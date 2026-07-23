import { withTenant } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import { ArmCostManagementClient, CostQueryRow } from "./armCostManagementClient";
import { resolveArmAuth } from "./armAuthResolver";

/**
 * Cost Optimization platform, Phase 2: cost ingestion service. Runs real
 * Cost Management queries across every RBAC-granted subscription and
 * upserts into cost_facts — idempotent per migration 008's functional
 * unique index, matching the plan's § 9.3 idempotency guidance (Cost
 * Management data can be corrected after its initial appearance, so
 * re-ingesting the same window must update in place, not duplicate).
 *
 * Pulls BOTH ActualCost and AmortizedCost per the plan's § 4.3 stated
 * preference ("Primary financial view: Amortized cost, Secondary billing
 * view: Actual cost") — two real ARM calls per subscription, not one.
 */
export async function runCostIngestion(
  tenantId: string,
  subscriptionIds: string[],
  startDate: string,
  endDate: string
): Promise<{ collectionRunId: string; rowsIngested: number }> {
  const collectionRunId = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO collection_runs (tenant_id, collector_type, status) VALUES ($1, 'cost_management_ingestion', 'running') RETURNING id`,
      [tenantId]
    );
    return rows[0].id;
  });

  try {
    const { entraTenantId, tokenProvider } = await resolveArmAuth(tenantId);
    const client = new ArmCostManagementClient(entraTenantId, tokenProvider);

    let rowsIngested = 0;

    for (const subscriptionId of subscriptionIds) {
      const [actualRows, amortizedRows] = await Promise.all([
        client.queryCost(subscriptionId, startDate, endDate, "ActualCost"),
        client.queryCost(subscriptionId, startDate, endDate, "AmortizedCost"),
      ]);

      rowsIngested += await upsertCostRows(tenantId, subscriptionId, actualRows, "ActualCost");
      rowsIngested += await upsertCostRows(tenantId, subscriptionId, amortizedRows, "AmortizedCost");
    }

    await withTenant(tenantId, async (dbClient) => {
      await writeAuditLog(dbClient, {
        tenantId,
        actor: "system:cost-ingestion",
        action: "cost_ingested",
        resourceType: "collection_runs",
        resourceId: collectionRunId,
        beforeState: null,
        afterState: { subscriptionIds, startDate, endDate, rowsIngested },
      });
      await dbClient.query(
        `UPDATE collection_runs SET status = 'succeeded', completed_at = now(), record_count = $2 WHERE id = $1`,
        [collectionRunId, rowsIngested]
      );
    });

    return { collectionRunId, rowsIngested };
  } catch (err) {
    await withTenant(tenantId, async (dbClient) => {
      await dbClient.query(
        `UPDATE collection_runs SET status = 'failed', completed_at = now(), error_details = $2::jsonb WHERE id = $1`,
        [collectionRunId, JSON.stringify({ message: (err as Error).message })]
      );
    });
    throw err;
  }
}

async function upsertCostRows(
  tenantId: string,
  subscriptionId: string,
  rows: CostQueryRow[],
  costType: "ActualCost" | "AmortizedCost"
): Promise<number> {
  return withTenant(tenantId, async (client) => {
    let count = 0;
    for (const row of rows) {
      await client.query(
        `INSERT INTO cost_facts (tenant_id, subscription_id, usage_date, azure_resource_id, meter_category, meter_subcategory, service_family, charge_type, cost_type, cost, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, subscription_id, usage_date, cost_type, COALESCE(azure_resource_id, ''), COALESCE(meter_category, ''), COALESCE(meter_subcategory, ''), COALESCE(charge_type, ''))
         DO UPDATE SET cost = $10, service_family = $7, currency = $11, ingested_at = now()`,
        [
          tenantId,
          subscriptionId,
          row.usageDate,
          row.resourceId ? row.resourceId.toLowerCase() : null,
          row.meterCategory,
          row.meterSubcategory,
          row.serviceFamily,
          row.chargeType,
          costType,
          row.cost,
          row.currency,
        ]
      );
      count++;
    }
    return count;
  });
}
