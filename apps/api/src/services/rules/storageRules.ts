import { PoolClient } from "pg";
import { OptimizationRule, RuleCandidate } from "./ruleFramework";

/**
 * AVD-STORAGE-001, per Adam's plan (§ 12.6): "Unattached managed disks."
 * Real detection against Phase 1's Resource Graph inventory — a managed
 * disk resource's `properties.diskState` is a genuine ARM field
 * ("Unattached" is a real, documented value, not invented here) that
 * directly tells us whether a disk has no VM attached, without needing
 * any additional collection pass.
 *
 * Applies the plan's own safety policy (§ 12.6): "7-day minimum age
 * before alerting" — checked against the resource's first_seen_at in
 * our own inventory as a floor (a real disk could be older in Azure than
 * our first collection of it, so this is a conservative minimum, not an
 * exact "when was this disk actually detached" timestamp, which Resource
 * Graph doesn't expose).
 */
export class UnattachedDiskRule implements OptimizationRule {
  ruleId = "AVD-STORAGE-001";
  version = 1;

  async evaluate(tenantId: string, client: PoolClient): Promise<RuleCandidate[]> {
    const { rows: disks } = await client.query(
      `SELECT azure_resource_id, resource_name, resource_group, subscription_id, sku, properties, first_seen_at
       FROM resources
       WHERE tenant_id = $1 AND resource_type = 'microsoft.compute/disks' AND deleted_at IS NULL
         AND first_seen_at < now() - interval '7 days'`,
      [tenantId]
    );

    const candidates: RuleCandidate[] = [];
    for (const disk of disks) {
      const diskState = disk.properties?.diskState;
      if (diskState !== "Unattached") continue;

      const diskSizeGB = disk.properties?.diskSizeGB;
      const skuName = disk.sku?.name;

      candidates.push({
        azureResourceId: disk.azure_resource_id,
        title: `Unattached managed disk "${disk.resource_name}"`,
        summary: `This managed disk (${skuName ?? "unknown SKU"}, ${diskSizeGB ?? "?"} GB) has been unattached for at least 7 days and continues to incur storage cost with no VM using it. Confirm it isn't retained intentionally for backup/DR before deleting — consider a snapshot first if unsure.`,
        category: "storage",
        severity: "low",
        risk: "medium", // plan's own guidance: never assume unused == safe to delete without a snapshot/backup check
        estimatedMonthlySavings: null, // needs customer effective disk pricing (Phase 2 cost_facts join) to quantify accurately, not retail-estimated here
        currency: null,
        confidenceScore: 75,
        evidence: {
          diskState,
          diskSizeGB,
          skuName,
          resourceGroup: disk.resource_group,
          subscriptionId: disk.subscription_id,
          firstSeenAt: disk.first_seen_at,
        },
      });
    }
    return candidates;
  }
}
