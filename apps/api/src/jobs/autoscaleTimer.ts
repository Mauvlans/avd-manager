import { withSystem } from "../db/pool";
import { ScalingPolicyEvaluator } from "../services/scalingPolicyEvaluator";
import { ArmHostPoolClient, resolveVmNameFromResourceId } from "../services/armHostPoolClient";
import { FakeTokenProvider } from "../services/tokenProvider";
import { RetailPricesClient, CostEstimator } from "../services/costEstimator";
import { writeAuditLog } from "../lib/auditLog";
import type { ScalingPolicy, SessionHost } from "@avd-manager/shared";

/**
 * Timer-triggered (e.g. every 5 min via Azure Functions timer trigger)
 * autoscale evaluation across all enabled scaling policies, for all tenants.
 * Structured as a plain async function so it can be wired into either an
 * Azure Functions timer trigger host or invoked directly in tests/local dev
 * via `npm run autoscale:once`.
 *
 * SAFETY: this function NEVER calls ARM actions directly computed from raw
 * policy config — it always routes through ScalingPolicyEvaluator, whose
 * safety-cap clamping is the single source of truth for "how much is too
 * much". If evaluator returns clampedBySafetyCaps=true, we log it loudly to
 * the audit trail before executing the (already-clamped) actions.
 */
export async function runAutoscaleTick(): Promise<void> {
  const evaluator = new ScalingPolicyEvaluator();
  const retailPrices = new RetailPricesClient();
  const costEstimator = new CostEstimator();

  const policies = await withSystem(async (client) => {
    const { rows } = await client.query(
      `SELECT sp.*, hp.subscription_id, hp.resource_group, hp.name as host_pool_name, hp.tenant_id as hp_tenant_id
       FROM scaling_policies sp
       JOIN host_pools hp ON hp.id = sp.host_pool_id
       WHERE sp.enabled = true`
    );
    return rows;
  });

  for (const row of policies) {
    const policy: ScalingPolicy = {
      id: row.id,
      tenantId: row.tenant_id,
      hostPoolId: row.host_pool_id,
      name: row.name,
      mode: row.mode,
      enabled: row.enabled,
      scheduleConfig: row.schedule_config,
      dynamicConfig: row.dynamic_config,
      safetyCaps: {
        maxHostsPerAction: row.max_hosts_per_action,
        maxCostDeltaPerActionUsdPerHour: Number(row.max_cost_delta_per_action_usd_per_hour),
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    // NOTE: without a live tenant + granted RBAC, this ARM call will fail
    // with a fake token in this sandbox. We catch and log rather than crash
    // the whole tick — one bad tenant/policy must not block others.
    let hosts: SessionHost[] = [];
    try {
      const armClient = new ArmHostPoolClient(row.hp_tenant_id, new FakeTokenProvider());
      hosts = await armClient.listSessionHosts(row.subscription_id, row.resource_group, row.host_pool_name);
    } catch (err) {
      console.error(`[autoscale] failed to list session hosts for policy ${policy.id}:`, err);
      continue;
    }

    let costPerHostUsdPerHour = 0.1; // conservative fallback if pricing lookup fails
    try {
      const price = await retailPrices.getVmHourlyPrice("Standard_D2s_v5", "eastus");
      if (price) costPerHostUsdPerHour = price.retailPrice;
    } catch {
      // Live pricing API failure — proceed with fallback rather than skip
      // scaling entirely, but note we intentionally did NOT fabricate a
      // "success" price; the fallback is a clearly-conservative constant.
    }

    const decision = evaluator.evaluate(policy, hosts, costPerHostUsdPerHour);

    await withSystem(async (client) => {
      await writeAuditLog(client, {
        tenantId: policy.tenantId,
        actor: "system:autoscale-engine",
        action: "scaling_decision_evaluated",
        resourceType: "scaling_policies",
        resourceId: policy.id,
        beforeState: null,
        afterState: decision,
      });
    });

    if (decision.actions.length === 0) continue;

    try {
      const armClient = new ArmHostPoolClient(row.hp_tenant_id, new FakeTokenProvider());
      const failures: string[] = [];
      for (const action of decision.actions) {
        if (action.action === "deallocate_host") {
          await armClient.deleteSessionHost(row.subscription_id, row.resource_group, row.host_pool_name, action.hostName);
        } else if (action.action === "start_host") {
          const host = hosts.find((h) => h.name === action.hostName);
          if (!host) {
            console.error(`[autoscale] start_host action for unknown host ${action.hostName}, skipping`);
            failures.push(`${action.hostName}: unknown host, skipped`);
            continue;
          }
          try {
            const vmName = resolveVmNameFromResourceId(host.resourceId);
            const result = await armClient.startVm(row.subscription_id, row.resource_group, vmName);
            if (result.outcome !== "succeeded") {
              console.error(`[autoscale] start_host for ${action.hostName} did not succeed: ${result.outcome} — ${result.reason}`);
              failures.push(`${action.hostName}: ${result.outcome} — ${result.reason}`);
            }
          } catch (err) {
            console.error(`[autoscale] failed to start VM for host ${action.hostName}:`, err);
            failures.push(`${action.hostName}: request error — ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      await withSystem(async (client) => {
        await writeAuditLog(client, {
          tenantId: policy.tenantId,
          actor: "system:autoscale-engine",
          action: failures.length > 0 ? "scaling_actions_partially_failed" : "scaling_actions_executed",
          resourceType: "scaling_policies",
          resourceId: policy.id,
          beforeState: null,
          afterState: failures.length > 0 ? { ...decision, failures } : decision,
        });
      });
    } catch (err) {
      console.error(`[autoscale] failed to execute scaling actions for policy ${policy.id}:`, err);
    }
  }
}

if (require.main === module) {
  runAutoscaleTick()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
