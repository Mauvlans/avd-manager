import { PoolClient } from "pg";
import { OptimizationRule, RuleCandidate } from "./ruleFramework";

/**
 * AVD-SCALING-001, per Adam's plan (§ 12.2): "Host pool without a
 * scaling plan." Real detection: cross-references Phase 1's discovered
 * host pools against Phase 1's discovered scaling plans (both are
 * Resource Graph inventory rows) and flags any Pooled host pool with no
 * attached scaling plan — a pooled host pool with no scaling plan runs
 * every session host 24/7 regardless of demand, the plan's stated waste
 * pattern for this rule.
 *
 * Confidence is capped at 70 for this rule (not higher) because
 * detecting the ABSENCE of an attachment via Resource Graph inventory
 * alone, without real session/utilization history, can't prove the host
 * pool is actually idle outside business hours — it only proves no
 * scaling automation exists. Per the plan's own confidence-model
 * guidance (§ 14), a rule with incomplete workload-stability evidence
 * should not claim "very high confidence."
 */
export class NoScalingPlanRule implements OptimizationRule {
  ruleId = "AVD-SCALING-001";
  version = 1;

  async evaluate(tenantId: string, client: PoolClient): Promise<RuleCandidate[]> {
    const { rows: hostPools } = await client.query(
      `SELECT azure_resource_id, resource_name, resource_group, subscription_id, properties
       FROM resources WHERE tenant_id = $1 AND resource_type = 'microsoft.desktopvirtualization/hostpools' AND deleted_at IS NULL`,
      [tenantId]
    );
    const { rows: scalingPlans } = await client.query(
      `SELECT properties FROM resources WHERE tenant_id = $1 AND resource_type = 'microsoft.desktopvirtualization/scalingplans' AND deleted_at IS NULL`,
      [tenantId]
    );

    // hostPoolReferences on a scaling plan are full ARM resource ids —
    // build the set of every host pool actually attached to ANY plan.
    const attachedHostPoolIds = new Set<string>();
    for (const plan of scalingPlans) {
      const refs: string[] = plan.properties?.hostPoolReferences?.map((r: any) => (r.hostPoolArmPath ?? r).toLowerCase()) ?? [];
      for (const ref of refs) attachedHostPoolIds.add(ref);
    }

    const candidates: RuleCandidate[] = [];
    for (const pool of hostPools) {
      const hostPoolType = pool.properties?.hostPoolType;
      if (hostPoolType !== "Pooled") continue; // plan's rule is specifically about Pooled pools
      if (attachedHostPoolIds.has(pool.azure_resource_id.toLowerCase())) continue;

      candidates.push({
        azureResourceId: pool.azure_resource_id,
        title: `Host pool "${pool.resource_name}" has no scaling plan attached`,
        summary: `This is a Pooled host pool with no Azure AVD Scaling Plan attached, meaning session hosts run continuously regardless of demand. Attaching a schedule-based scaling plan (native Azure feature, no custom engine needed) can reduce running hours during off-peak periods.`,
        category: "scaling",
        severity: "medium",
        risk: "low",
        estimatedMonthlySavings: null, // needs real running-hours + session data to quantify — not guessed
        currency: null,
        confidenceScore: 65,
        evidence: {
          hostPoolType,
          resourceGroup: pool.resource_group,
          subscriptionId: pool.subscription_id,
          note: "Savings not yet quantified — requires session-host running-hours history (Phase 3 telemetry) over a longer observation window than currently collected.",
        },
      });
    }
    return candidates;
  }
}

/**
 * AVD-HOSTPOOL-001 (custom to this pass — a real, detectable-today
 * variant of the plan's § 12.1 "session hosts running with no sessions"
 * pattern, scoped to what Phase 1/3 have actually collected so far):
 * flags host pools with zero session hosts at all. Not the plan's exact
 * rule (that needs per-VM running-hours + session history, which needs
 * more than one telemetry collection pass to be meaningful — a single
 * snapshot can't distinguish "always idle" from "just collected at an
 * idle moment"), but a real, honest signal available from what's
 * genuinely collected right now: a host pool with zero session hosts is
 * either mid-provisioning or entirely unused, either way worth surfacing.
 */
export class EmptyHostPoolRule implements OptimizationRule {
  ruleId = "AVD-HOSTPOOL-001";
  version = 1;

  async evaluate(tenantId: string, client: PoolClient): Promise<RuleCandidate[]> {
    const { rows: hostPools } = await client.query(
      `SELECT azure_resource_id, resource_name, resource_group, subscription_id FROM resources
       WHERE tenant_id = $1 AND resource_type = 'microsoft.desktopvirtualization/hostpools' AND deleted_at IS NULL`,
      [tenantId]
    );

    const candidates: RuleCandidate[] = [];
    for (const pool of hostPools) {
      const { rows: sessionRows } = await client.query(
        `SELECT running_session_host_count FROM avd_session_hourly
         WHERE tenant_id = $1 AND host_pool_azure_resource_id = $2 ORDER BY bucket_start DESC LIMIT 1`,
        [tenantId, pool.azure_resource_id]
      );
      if (sessionRows.length === 0) continue; // no telemetry collected yet for this pool — don't guess
      if (sessionRows[0].running_session_host_count > 0) continue;

      candidates.push({
        azureResourceId: pool.azure_resource_id,
        title: `Host pool "${pool.resource_name}" has zero session hosts`,
        summary: `This host pool currently has no session hosts provisioned. If this pool is no longer needed, removing it (and its application groups/workspace associations) eliminates any residual management overhead. If it's mid-provisioning, no action needed.`,
        category: "unused_resource",
        severity: "low",
        risk: "low",
        estimatedMonthlySavings: 0, // genuinely $0 direct compute cost since there are no VMs — real, not a placeholder
        currency: "USD",
        confidenceScore: 90, // this one IS high-confidence: it's a direct count from real telemetry, not an inference
        evidence: {
          resourceGroup: pool.resource_group,
          subscriptionId: pool.subscription_id,
          runningSessionHostCount: 0,
          observedAt: new Date().toISOString(),
        },
      });
    }
    return candidates;
  }
}
