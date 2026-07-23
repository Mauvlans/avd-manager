import { Router } from "express";
import { withTenant } from "../db/pool";
import { tenantAuth } from "../middleware/tenantAuth";
import { runTelemetryCollection } from "../services/telemetryCollector";

/**
 * Cost Optimization platform, Phase 3 (per Adam's plan): AVD telemetry
 * collection. Read-only.
 */
export const telemetryRouter = Router();

telemetryRouter.use(tenantAuth);

telemetryRouter.post("/collect", async (req, res) => {
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
    return res.status(400).json({ error: "No RBAC-granted subscriptions found for this tenant." });
  }

  try {
    const result = await runTelemetryCollection(tenantId, subscriptionIds);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

telemetryRouter.get("/vm-metrics", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const azureResourceId = req.query.azureResourceId as string | undefined;
  if (!azureResourceId) return res.status(400).json({ error: "azureResourceId is required" });

  const rows = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT metric_time, metric_name, average_value, maximum_value, minimum_value, unit
       FROM metric_hourly WHERE tenant_id = $1 AND azure_resource_id = $2
       ORDER BY metric_time DESC LIMIT 500`,
      [tenantId, azureResourceId.toLowerCase()]
    );
    return rows;
  });
  res.json(rows);
});

telemetryRouter.get("/vm-summary", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const rows = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT azure_resource_id, metric_name,
              AVG(average_value) AS avg_average, MAX(maximum_value) AS p_max, COUNT(*) AS sample_count
       FROM metric_hourly WHERE tenant_id = $1 AND metric_time > now() - interval '7 days'
       GROUP BY azure_resource_id, metric_name`,
      [tenantId]
    );
    return rows;
  });
  res.json(rows);
});

telemetryRouter.get("/session-hourly", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const rows = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM avd_session_hourly WHERE tenant_id = $1 ORDER BY bucket_start DESC LIMIT 200`,
      [tenantId]
    );
    return rows;
  });
  res.json(rows);
});
