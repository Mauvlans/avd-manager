import { Router } from "express";
import { withTenant } from "../db/pool";
import { tenantAuth } from "../middleware/tenantAuth";
import { runCostIngestion } from "../services/costIngestionService";

/**
 * Cost Optimization platform, Phase 2 (per Adam's plan): real Cost
 * Management ingestion. Read-only — this only queries and stores cost
 * data, it never modifies anything in the customer's Azure environment.
 */
export const costFactsRouter = Router();

costFactsRouter.use(tenantAuth);

costFactsRouter.post("/ingest", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  let subscriptionIds: string[] = req.body?.subscriptionIds ?? [];
  const startDate = req.body?.startDate ?? defaultStartDate();
  const endDate = req.body?.endDate ?? defaultEndDate();

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
    return res.status(400).json({ error: "No RBAC-granted subscriptions found for this tenant." });
  }

  try {
    const result = await runCostIngestion(tenantId, subscriptionIds, startDate, endDate);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

costFactsRouter.get("/summary", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const costType = (req.query.costType as string) || "AmortizedCost";
  const rows = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT date_trunc('month', usage_date)::date AS month, currency, SUM(cost) AS total_cost
       FROM cost_facts WHERE tenant_id = $1 AND cost_type = $2
       GROUP BY month, currency ORDER BY month DESC`,
      [tenantId, costType]
    );
    return rows;
  });
  res.json(rows);
});

costFactsRouter.get("/by-service", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const costType = (req.query.costType as string) || "AmortizedCost";
  const rows = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT service_family, currency, SUM(cost) AS total_cost
       FROM cost_facts WHERE tenant_id = $1 AND cost_type = $2
       GROUP BY service_family, currency ORDER BY total_cost DESC`,
      [tenantId, costType]
    );
    return rows;
  });
  res.json(rows);
});

costFactsRouter.get("/by-resource", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const costType = (req.query.costType as string) || "AmortizedCost";
  const rows = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT cf.azure_resource_id, r.resource_name, r.resource_type, cf.currency, SUM(cf.cost) AS total_cost
       FROM cost_facts cf
       LEFT JOIN resources r ON r.tenant_id = cf.tenant_id AND r.azure_resource_id = cf.azure_resource_id
       WHERE cf.tenant_id = $1 AND cf.cost_type = $2 AND cf.azure_resource_id IS NOT NULL
       GROUP BY cf.azure_resource_id, r.resource_name, r.resource_type, cf.currency
       ORDER BY total_cost DESC LIMIT 100`,
      [tenantId, costType]
    );
    return rows;
  });
  res.json(rows);
});

function defaultStartDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}

function defaultEndDate(): string {
  return new Date().toISOString().slice(0, 10);
}
