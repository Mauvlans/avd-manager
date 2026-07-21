import { withSystem } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import { ArmHostPoolClient, resolveVmNameFromResourceId } from "../services/armHostPoolClient";
import { FakeTokenProvider } from "../services/tokenProvider";
import type { ScalingActionType } from "@avd-manager/shared";

/**
 * Minimal outbox/retry worker for scaling actions that partially failed.
 *
 * `autoscaleTimer.ts` already writes a `scaling_actions_partially_failed`
 * audit_log entry (instead of silently reporting success) whenever a
 * `start_host`/`deallocate_host` ARM call didn't reach a "succeeded" LRO
 * outcome. Nothing previously acted on that entry — it just sat in the
 * audit trail as a manual-review breadcrumb. This worker is the first
 * automated consumer of that outbox: it reads recent partially-failed
 * entries that have not already been retried, retries each failed action
 * EXACTLY ONCE (bounded — no infinite retry loop, no backoff scheduling;
 * a still-failing action after this one retry is left for a human/alerting
 * pipeline, not retried again by a future run of this worker), and always
 * records a new audit entry either way (`retried_success` or
 * `retried_still_failed`) so the retry attempt itself is auditable.
 *
 * "Already retried" is determined by checking for a later
 * retried_success/retried_still_failed audit_log row with the same
 * resource_id (the scaling policy id) — see the NOT EXISTS subquery below.
 * This keeps the worker idempotent/safe to run on a schedule (e.g. every
 * few minutes via the same timer-trigger mechanism as autoscaleTimer)
 * without needing a separate "retry_count" column on audit_log.
 */

interface PartiallyFailedRow {
  auditLogId: string;
  tenantId: string;
  policyId: string;
  subscriptionId: string;
  resourceGroup: string;
  hostPoolName: string;
  entraTenantId: string;
  afterState: {
    actions?: { hostName: string; action: ScalingActionType; reason: string }[];
    failures?: string[];
  };
}

/** Extracts the host names that failed from the `failures` string array
 * written by autoscaleTimer (format: "<hostName>: <outcome> — <reason>"). */
function extractFailedHostNames(failures: string[] | undefined): Set<string> {
  const names = new Set<string>();
  for (const f of failures ?? []) {
    const idx = f.indexOf(":");
    if (idx > 0) names.add(f.slice(0, idx));
  }
  return names;
}

async function fetchRetryCandidates(): Promise<PartiallyFailedRow[]> {
  return withSystem(async (client) => {
    const { rows } = await client.query(
      `SELECT al.id AS audit_log_id, al.tenant_id, al.resource_id AS policy_id, al.after_state,
              hp.subscription_id, hp.resource_group, hp.name AS host_pool_name, t.entra_tenant_id
       FROM audit_log al
       JOIN scaling_policies sp ON sp.id = al.resource_id::uuid
       JOIN host_pools hp ON hp.id = sp.host_pool_id
       JOIN tenants t ON t.id = al.tenant_id
       WHERE al.action = 'scaling_actions_partially_failed'
         AND al.created_at > now() - interval '24 hours'
         AND NOT EXISTS (
           SELECT 1 FROM audit_log retry
           WHERE retry.resource_id = al.resource_id
             AND retry.action IN ('retried_success', 'retried_still_failed')
             AND retry.created_at > al.created_at
         )
       ORDER BY al.created_at ASC`
    );
    return rows.map((r: any) => ({
      auditLogId: r.audit_log_id,
      tenantId: r.tenant_id,
      policyId: r.policy_id,
      subscriptionId: r.subscription_id,
      resourceGroup: r.resource_group,
      hostPoolName: r.host_pool_name,
      entraTenantId: r.entra_tenant_id,
      afterState: typeof r.after_state === "string" ? JSON.parse(r.after_state) : r.after_state ?? {},
    }));
  });
}

/** Retries the single failed action for one host, once. Returns the new
 * outcome so the caller can decide the audit action. Never throws for an
 * ARM-side failure — that's the expected "still failed" case, not a bug in
 * the worker itself; only a genuinely unexpected error (e.g. can't resolve
 * a VM name) is caught and reported as a failure string too. */
async function retryOneAction(
  armClient: ArmHostPoolClient,
  row: PartiallyFailedRow,
  hostName: string,
  action: ScalingActionType | undefined
): Promise<{ hostName: string; succeeded: boolean; detail: string }> {
  try {
    if (action === "deallocate_host") {
      const result = await armClient.deleteSessionHost(row.subscriptionId, row.resourceGroup, row.hostPoolName, hostName);
      return { hostName, succeeded: result.outcome === "succeeded", detail: `${result.outcome}${result.outcome !== "succeeded" ? ` — ${result.reason}` : ""}` };
    }
    if (action === "start_host") {
      // We don't have the session host's resourceId (VM resourceId) stored
      // on the audit row — look it up fresh, same as autoscaleTimer does,
      // rather than trusting stale state.
      const hosts = await armClient.listSessionHosts(row.subscriptionId, row.resourceGroup, row.hostPoolName);
      const host = hosts.find((h) => h.name === hostName);
      if (!host) {
        return { hostName, succeeded: false, detail: "retry skipped: host no longer present in listSessionHosts" };
      }
      const vmName = resolveVmNameFromResourceId(host.resourceId);
      const result = await armClient.startVm(row.subscriptionId, row.resourceGroup, vmName);
      return { hostName, succeeded: result.outcome === "succeeded", detail: `${result.outcome}${result.outcome !== "succeeded" ? ` — ${result.reason}` : ""}` };
    }
    return { hostName, succeeded: false, detail: `retry skipped: unknown action type ${String(action)}` };
  } catch (err) {
    return { hostName, succeeded: false, detail: `retry threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Runs one pass of the retry worker: finds unretried
 * `scaling_actions_partially_failed` audit entries, retries each failed
 * host action exactly once, and writes a `retried_success` or
 * `retried_still_failed` audit entry recording the outcome. Structured as
 * a plain async function (same shape as `runAutoscaleTick`) so it can be
 * invoked directly in tests/local dev or wired into a timer trigger.
 */
export async function runScalingActionRetryWorker(): Promise<void> {
  const candidates = await fetchRetryCandidates();

  for (const row of candidates) {
    const failedHostNames = extractFailedHostNames(row.afterState.failures);
    if (failedHostNames.size === 0) continue;

    const armClient = new ArmHostPoolClient(row.entraTenantId, new FakeTokenProvider());
    const retryResults: { hostName: string; succeeded: boolean; detail: string }[] = [];

    for (const hostName of Array.from(failedHostNames)) {
      const originalAction = row.afterState.actions?.find((a) => a.hostName === hostName)?.action;
      const outcome = await retryOneAction(armClient, row, hostName, originalAction);
      retryResults.push(outcome);
      if (!outcome.succeeded) {
        console.error(`[scalingActionRetryWorker] retry for host ${hostName} (policy ${row.policyId}) still failed: ${outcome.detail}`);
      }
    }

    const allSucceeded = retryResults.every((r) => r.succeeded);
    await withSystem(async (client) => {
      await writeAuditLog(client, {
        tenantId: row.tenantId,
        actor: "system:scaling-action-retry-worker",
        action: allSucceeded ? "retried_success" : "retried_still_failed",
        resourceType: "scaling_policies",
        resourceId: row.policyId,
        beforeState: { sourceAuditLogId: row.auditLogId, failedHostNames: Array.from(failedHostNames) },
        afterState: { retryResults },
      });
    });
  }
}

if (require.main === module) {
  runScalingActionRetryWorker()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
