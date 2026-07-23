import { Router } from "express";
import { withTenant } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import { tenantAuth } from "../middleware/tenantAuth";
import { ArmResourceGroupClient } from "../services/armResourceGroupClient";
import { ArmHostPoolClient } from "../services/armHostPoolClient";
import { resolveArmAuth } from "../services/armAuthResolver";

/**
 * Settings > Monitored Resource Groups, per Adam's request: an admin
 * picks which resource groups (within a granted subscription) AVD
 * Manager should actively discover resources in — host pools (and later
 * application groups/workspaces) created OUTSIDE this product, e.g.
 * Adam's real pre-existing host pool that had no matching DB row because
 * it was never created through Deploy > Template.
 *
 * GET /resource-groups fetches the REAL list of resource groups in a
 * subscription live from ARM (Microsoft.Resources), for the picker —
 * not free-text entry, per Adam's explicit choice.
 * GET/PUT /monitored persists which ones the admin selected.
 * POST /sync discovers host pools in every monitored resource group and
 * imports (upserts) them into host_pools — this is what actually pulls
 * Adam's real pre-existing host pool into the product.
 */
export const monitoredResourceGroupsRouter = Router();

monitoredResourceGroupsRouter.use(tenantAuth);

monitoredResourceGroupsRouter.get("/resource-groups", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const subscriptionId = req.query.subscriptionId as string | undefined;
  if (!subscriptionId) return res.status(400).json({ error: "subscriptionId is required" });
  try {
    const { entraTenantId, tokenProvider } = await resolveArmAuth(tenantId);
    const client = new ArmResourceGroupClient(entraTenantId, tokenProvider);
    const groups = await client.listResourceGroups(subscriptionId);
    res.json(groups);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

monitoredResourceGroupsRouter.get("/monitored", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const rows = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT subscription_id, selected_resource_groups, last_synced_at FROM monitored_resource_groups WHERE tenant_id = $1`,
      [tenantId]
    );
    return rows;
  });
  res.json(rows);
});

monitoredResourceGroupsRouter.put("/monitored/:subscriptionId", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const { subscriptionId } = req.params;
  const { selectedResourceGroups } = req.body ?? {};
  if (!Array.isArray(selectedResourceGroups) || !selectedResourceGroups.every((v) => typeof v === "string")) {
    return res.status(400).json({ error: "selectedResourceGroups must be an array of strings" });
  }

  await withTenant(tenantId, async (client) => {
    const { rows: existing } = await client.query(
      `SELECT selected_resource_groups FROM monitored_resource_groups WHERE tenant_id = $1 AND subscription_id = $2`,
      [tenantId, subscriptionId]
    );
    const before = existing[0]?.selected_resource_groups ?? null;

    await client.query(
      `INSERT INTO monitored_resource_groups (tenant_id, subscription_id, selected_resource_groups)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (tenant_id, subscription_id)
       DO UPDATE SET selected_resource_groups = $3::jsonb, updated_at = now()`,
      [tenantId, subscriptionId, JSON.stringify(selectedResourceGroups)]
    );

    await writeAuditLog(client, {
      tenantId,
      actor: req.header("x-actor") || "unknown",
      action: "monitored_resource_groups_updated",
      resourceType: "monitored_resource_groups",
      resourceId: subscriptionId,
      beforeState: before,
      afterState: selectedResourceGroups,
    });
  });

  res.json({ subscriptionId, selectedResourceGroups });
});

/** Discovers host pools in every monitored resource group (across every
 * subscription this tenant has configured) and upserts them into
 * host_pools — the actual mechanism that pulls a real pre-existing host
 * pool (created outside AVD Manager, e.g. directly in the Azure portal)
 * into this product instead of it just sitting invisible in Azure. Not a
 * destructive sync: only inserts/updates, never deletes a host_pools row
 * that ARM no longer reports (a real "this pool exists in Azure but not
 * in our DB" discovery flow doesn't imply "this DB row that Azure removed
 * should vanish" — that's a distinct, more dangerous operation this
 * endpoint deliberately does not attempt). */
monitoredResourceGroupsRouter.post("/sync", async (req, res) => {
  const tenantId = (req as any).tenantId as string;

  const monitored = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT subscription_id, selected_resource_groups FROM monitored_resource_groups WHERE tenant_id = $1`,
      [tenantId]
    );
    return rows;
  });

  let armClient: ArmHostPoolClient;
  try {
    const { entraTenantId, tokenProvider } = await resolveArmAuth(tenantId);
    armClient = new ArmHostPoolClient(entraTenantId, tokenProvider);
  } catch (err) {
    return res.status(502).json({ error: (err as Error).message, discovered: 0, imported: 0, errors: [] });
  }
  let discovered = 0;
  let imported = 0;
  const errors: string[] = [];

  for (const row of monitored) {
    const resourceGroups: string[] = row.selected_resource_groups ?? [];
    for (const resourceGroup of resourceGroups) {
      try {
        const pools = await armClient.listHostPools(row.subscription_id, resourceGroup);
        discovered += pools.length;
        for (const pool of pools) {
          await withTenant(tenantId, async (client) => {
            const { rows: existing } = await client.query(
              `SELECT id FROM host_pools WHERE tenant_id = $1 AND subscription_id = $2 AND resource_group = $3 AND name = $4`,
              [tenantId, row.subscription_id, resourceGroup, pool.name]
            );
            if (existing.length > 0) return; // already known — no update needed for a v1 discovery pass
            const inserted = await client.query(
              `INSERT INTO host_pools (tenant_id, subscription_id, resource_group, name, location, host_pool_type, load_balancer_type, max_session_limit)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
              [
                tenantId,
                row.subscription_id,
                resourceGroup,
                pool.name,
                pool.location,
                pool.hostPoolType,
                pool.loadBalancerType,
                pool.maxSessionLimit,
              ]
            );
            imported++;
            await writeAuditLog(client, {
              tenantId,
              actor: "system:resource-group-sync",
              action: "host_pool_discovered_and_imported",
              resourceType: "host_pools",
              resourceId: inserted.rows[0].id,
              beforeState: null,
              afterState: pool,
            });
          });
        }
      } catch (err) {
        errors.push(`${row.subscription_id}/${resourceGroup}: ${(err as Error).message}`);
      }
    }
  }

  await withTenant(tenantId, async (client) => {
    await client.query(`UPDATE monitored_resource_groups SET last_synced_at = now() WHERE tenant_id = $1`, [tenantId]);
  });

  res.json({ discovered, imported, errors });
});
