import { withTenant } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import { ArmResourceGraphClient } from "./armResourceGraphClient";
import { resolveArmAuth } from "./armAuthResolver";

/**
 * Cost Optimization platform, Phase 1: inventory collection service. Runs
 * a real Azure Resource Graph query across every subscription this
 * tenant has granted RBAC for (per Adam's plan, § 4.1), and upserts the
 * results into the `resources` table — the same idempotent-upsert
 * pattern the plan calls for (§ 9.3), keyed on (tenant_id,
 * azure_resource_id), not append-only inserts.
 *
 * A resource that ARM no longer reports is soft-deleted (deleted_at set)
 * rather than physically removed, so historical cost/recommendation
 * joins against a since-deleted resource still resolve — matches the
 * plan's resources table shape (§ 6.2) having its own deleted_at column
 * for exactly this reason.
 */
export async function runResourceInventoryCollection(
  tenantId: string,
  subscriptionIds: string[]
): Promise<{ collectionRunId: string; discovered: number; inserted: number; updated: number; softDeleted: number }> {
  const collectionRunId = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO collection_runs (tenant_id, collector_type, status) VALUES ($1, 'resource_graph_inventory', 'running') RETURNING id`,
      [tenantId]
    );
    return rows[0].id;
  });

  try {
    const { entraTenantId, tokenProvider } = await resolveArmAuth(tenantId);
    const client = new ArmResourceGraphClient(entraTenantId, tokenProvider);
    const discoveredRows = await client.queryResources(subscriptionIds);

    let inserted = 0;
    let updated = 0;
    let softDeleted = 0;

    await withTenant(tenantId, async (dbClient) => {
      const seenIds = new Set<string>();
      for (const row of discoveredRows) {
        seenIds.add(row.id.toLowerCase());
        const { rows: existing } = await dbClient.query(
          `SELECT id FROM resources WHERE tenant_id = $1 AND azure_resource_id = $2`,
          [tenantId, row.id.toLowerCase()]
        );
        if (existing.length > 0) {
          await dbClient.query(
            `UPDATE resources SET resource_type = $3, resource_name = $4, resource_group = $5, location = $6,
                                   sku = $7, tags = $8, properties = $9, subscription_id = $10,
                                   last_seen_at = now(), deleted_at = NULL
             WHERE tenant_id = $1 AND azure_resource_id = $2`,
            [
              tenantId,
              row.id.toLowerCase(),
              row.type,
              row.name,
              row.resourceGroup,
              row.location,
              JSON.stringify(row.sku),
              JSON.stringify(row.tags),
              JSON.stringify(row.properties),
              row.subscriptionId,
            ]
          );
          updated++;
        } else {
          await dbClient.query(
            `INSERT INTO resources (tenant_id, subscription_id, azure_resource_id, resource_type, resource_name, resource_group, location, sku, tags, properties)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
            [
              tenantId,
              row.subscriptionId,
              row.id.toLowerCase(),
              row.type,
              row.name,
              row.resourceGroup,
              row.location,
              JSON.stringify(row.sku),
              JSON.stringify(row.tags),
              JSON.stringify(row.properties),
            ]
          );
          inserted++;
        }
      }

      // Soft-delete resources previously seen for these subscriptions that
      // Resource Graph no longer reports — real drift detection, not
      // guessed at. Scoped to the subscriptions actually queried this run
      // so a partial-scope collection doesn't wrongly mark unrelated
      // subscriptions' resources as gone.
      const { rows: softDeletedRows } = await dbClient.query(
        `UPDATE resources SET deleted_at = now()
         WHERE tenant_id = $1 AND subscription_id = ANY($2) AND deleted_at IS NULL
           AND azure_resource_id NOT IN (SELECT unnest($3::text[]))
         RETURNING id`,
        [tenantId, subscriptionIds, Array.from(seenIds)]
      );
      softDeleted = softDeletedRows.length;

      await writeAuditLog(dbClient, {
        tenantId,
        actor: "system:resource-inventory-collector",
        action: "resource_inventory_collected",
        resourceType: "collection_runs",
        resourceId: collectionRunId,
        beforeState: null,
        afterState: { discovered: discoveredRows.length, inserted, updated, softDeleted },
      });

      await dbClient.query(
        `UPDATE collection_runs SET status = 'succeeded', completed_at = now(), record_count = $2 WHERE id = $1`,
        [collectionRunId, discoveredRows.length]
      );
    });

    return {
      collectionRunId,
      discovered: discoveredRows.length,
      inserted,
      updated,
      softDeleted,
    };
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
