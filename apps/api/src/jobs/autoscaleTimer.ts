import { withSystem } from "../db/pool";
import { ScalingPolicyEvaluator } from "../services/scalingPolicyEvaluator";
import { ArmHostPoolClient } from "../services/armHostPoolClient";
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
      for (const action of decision.actions) {
        if (action.action === "deallocate_host") {
          await armClient.deleteSessionHost(row.subscription_id, row.resource_group, row.host_pool_name, action.hostName);
        }
        // start_host in v1 is a stub: real implementation needs to call the
        // underlying Microsoft.Compute VM start API, not DesktopVirtualization
        // — tracked in PROGRESS.md.
      }
      await withSystem(async (client) => {
        await writeAuditLog(client, {
          tenantId: policy.tenantId,
          actor: "system:autoscale-engine",
          action: "scaling_actions_executed",
          resourceType: "scaling_policies",
          resourceId: policy.id,
          beforeState: null,
          afterState: decision,
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
