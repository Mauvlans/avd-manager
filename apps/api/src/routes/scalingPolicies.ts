import { Router } from "express";
import { withTenant } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import { RetailPricesClient, CostEstimator } from "../services/costEstimator";
import { tenantAuth } from "../middleware/tenantAuth";

export const scalingPoliciesRouter = Router();
export const costRouter = Router();

scalingPoliciesRouter.use(tenantAuth);

scalingPoliciesRouter.get("/", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const hostPoolId = req.query.hostPoolId as string | undefined;
  const rows = await withTenant(tenantId, async (client) => {
    const { rows } = hostPoolId
      ? await client.query(`SELECT * FROM scaling_policies WHERE host_pool_id = $1 ORDER BY created_at DESC`, [
          hostPoolId,
        ])
      : await client.query(`SELECT * FROM scaling_policies ORDER BY created_at DESC`);
    return rows;
  });
  res.json(rows);
});

scalingPoliciesRouter.post("/", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const {
    hostPoolId,
    name,
    mode,
    enabled = true,
    scheduleConfig = null,
    dynamicConfig = null,
    maxHostsPerAction = 2,
    maxCostDeltaPerActionUsdPerHour = 5.0,
  } = req.body ?? {};

  if (!hostPoolId || !name || !mode) {
    return res.status(400).json({ error: "hostPoolId, name, and mode are required" });
  }
  if (mode !== "schedule" && mode !== "dynamic_threshold") {
    return res.status(400).json({ error: "mode must be 'schedule' or 'dynamic_threshold'" });
  }
  // Non-negotiable: reject any attempt to set caps to something that would
  // effectively disable them.
  if (maxHostsPerAction <= 0 || maxCostDeltaPerActionUsdPerHour <= 0) {
    return res.status(400).json({ error: "safety caps must be positive, non-zero values" });
  }

  const created = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO scaling_policies (tenant_id, host_pool_id, name, mode, enabled, schedule_config, dynamic_config, max_hosts_per_action, max_cost_delta_per_action_usd_per_hour)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        tenantId,
        hostPoolId,
        name,
        mode,
        enabled,
        scheduleConfig ? JSON.stringify(scheduleConfig) : null,
        dynamicConfig ? JSON.stringify(dynamicConfig) : null,
        maxHostsPerAction,
        maxCostDeltaPerActionUsdPerHour,
      ]
    );
    const row = rows[0];
    await writeAuditLog(client, {
      tenantId,
      actor: req.header("x-actor") || "unknown",
      action: "scaling_policy_created",
      resourceType: "scaling_policies",
      resourceId: row.id,
      beforeState: null,
      afterState: row,
    });
    return row;
  });

  res.status(201).json(created);
});

scalingPoliciesRouter.patch("/:id", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const { enabled } = req.body ?? {};
  const updated = await withTenant(tenantId, async (client) => {
    const { rows: existing } = await client.query(`SELECT * FROM scaling_policies WHERE id = $1`, [
      req.params.id,
    ]);
    if (existing.length === 0) return null;
    const { rows } = await client.query(
      `UPDATE scaling_policies SET enabled = COALESCE($1, enabled), updated_at = now() WHERE id = $2 RETURNING *`,
      [enabled, req.params.id]
    );
    await writeAuditLog(client, {
      tenantId,
      actor: req.header("x-actor") || "unknown",
      action: "scaling_policy_updated",
      resourceType: "scaling_policies",
      resourceId: req.params.id,
      beforeState: existing[0],
      afterState: rows[0],
    });
    return rows[0];
  });
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json(updated);
});

// --- Cost estimation (public retail prices, unauthenticated) ---

const retailPricesClient = new RetailPricesClient();
const costEstimator = new CostEstimator();

costRouter.get("/estimate", async (req, res) => {
  const armSkuName = (req.query.armSkuName as string) || "Standard_D2s_v5";
  const armRegionName = (req.query.armRegionName as string) || "eastus";
  const hostCount = Number(req.query.hostCount ?? 1);

  try {
    const price = await retailPricesClient.getVmHourlyPrice(armSkuName, armRegionName);
    if (!price) {
      return res.status(404).json({ error: `no retail price found for ${armSkuName} in ${armRegionName}` });
    }
    res.json({
      price,
      hourlyCost: costEstimator.estimateHourlyCost(price.retailPrice, hostCount),
      monthlyCost: costEstimator.estimateMonthlyCost(price.retailPrice, hostCount),
    });
  } catch (err) {
    res.status(502).json({ error: `retail prices API call failed: ${(err as Error).message}` });
  }
});
