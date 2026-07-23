import { Router } from "express";
import { withTenant } from "../db/pool";
import { tenantAuth } from "../middleware/tenantAuth";
import { runResourceInventoryCollection } from "../services/resourceInventoryCollector";

/**
 * Cost Optimization platform, Phase 1 (per Adam's plan, message.txt):
 * inventory collection trigger + resource listing. Real ARM data via
 * Resource Graph, real Postgres upserts, real RLS — no simulated data.
 */
export const resourcesRouter = Router();

resourcesRouter.use(tenantAuth);

/** Triggers a real Resource Graph collection run across the given
 * subscription ids (or, if omitted, falls back to every RBAC-granted
 * subscription in this tenant's onboarding registry). */
resourcesRouter.post("/collect", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  let subscriptionIds: string[] = req.body?.subscriptionIds ?? [];

  if (subscriptionIds.length === 0) {
    subscriptionIds = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT DISTINCT subscription_id FROM subscriptions_registry WHERE tenant_id = $1 AND subscription_id IS NOT NULL AND rbac_grant_status = 'granted'`,
        [tenantId]
      );
      return rows.map((r) => r.subscription_id);
    });
  }

  if (subscriptionIds.length === 0) {
    return res.status(400).json({ error: "No RBAC-granted subscriptions found for this tenant — complete Onboarding first, or pass subscriptionIds explicitly." });
  }

  try {
    const result = await runResourceInventoryCollection(tenantId, subscriptionIds);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

resourcesRouter.get("/", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const resourceType = req.query.resourceType as string | undefined;
  const subscriptionId = req.query.subscriptionId as string | undefined;
  const includeDeleted = req.query.includeDeleted === "true";

  const rows = await withTenant(tenantId, async (client) => {
    const conditions: string[] = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];
    if (!includeDeleted) conditions.push("deleted_at IS NULL");
    if (resourceType) {
      params.push(resourceType);
      conditions.push(`resource_type = $${params.length}`);
    }
    if (subscriptionId) {
      params.push(subscriptionId);
      conditions.push(`subscription_id = $${params.length}`);
    }
    const { rows } = await client.query(
      `SELECT * FROM resources WHERE ${conditions.join(" AND ")} ORDER BY resource_type, resource_name`,
      params
    );
    return rows;
  });

  res.json(rows);
});

resourcesRouter.get("/summary", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const rows = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT resource_type, count(*) AS count FROM resources WHERE tenant_id = $1 AND deleted_at IS NULL GROUP BY resource_type ORDER BY count DESC`,
      [tenantId]
    );
    return rows;
  });
  res.json(rows);
});

resourcesRouter.get("/collection-runs", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const rows = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM collection_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 20`,
      [tenantId]
    );
    return rows;
  });
  res.json(rows);
});
