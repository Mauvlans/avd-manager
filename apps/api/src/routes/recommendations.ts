import { Router } from "express";
import { withTenant } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import { tenantAuth } from "../middleware/tenantAuth";
import { evaluateRules } from "../services/rules/ruleFramework";
import { NoScalingPlanRule, EmptyHostPoolRule } from "../services/rules/avdScalingRules";
import { UnattachedDiskRule } from "../services/rules/storageRules";

/**
 * Cost Optimization platform, Phase 4 (per Adam's plan): recommendation
 * engine. Read-only — evaluates rules against already-collected data
 * (Phase 1 inventory, Phase 3 telemetry); never modifies anything in the
 * customer's Azure environment. MVP rule set for this pass: 3 real rules
 * (NoScalingPlanRule, EmptyHostPoolRule, UnattachedDiskRule) rather than
 * the plan's full § 12 list of 10 — the other 7 need data this pass
 * doesn't collect yet (oversized-VM needs sustained CPU/memory
 * percentiles over 14-30 days per the plan's own § 12.3 guidance,
 * reservation opportunities need historical hourly usage, etc.) and are
 * documented as follow-ups, not faked with placeholder logic.
 */
export const recommendationsRouter = Router();

recommendationsRouter.use(tenantAuth);

const RULES = [new NoScalingPlanRule(), new EmptyHostPoolRule(), new UnattachedDiskRule()];

recommendationsRouter.post("/evaluate", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  try {
    const results = await withTenant(tenantId, async (client) => {
      const ruleResults = await evaluateRules(tenantId, client, RULES);
      await writeAuditLog(client, {
        tenantId,
        actor: "system:recommendation-engine",
        action: "recommendations_evaluated",
        resourceType: "recommendations",
        resourceId: tenantId,
        beforeState: null,
        afterState: ruleResults,
      });
      return ruleResults;
    });
    res.json({ ruleResults: results });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

recommendationsRouter.get("/", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const status = (req.query.status as string) || "open";
  const rows = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM recommendations WHERE tenant_id = $1 AND status = $2
       ORDER BY estimated_monthly_savings DESC NULLS LAST, severity DESC`,
      [tenantId, status]
    );
    return rows;
  });
  res.json(rows);
});

recommendationsRouter.post("/:id/dismiss", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  await withTenant(tenantId, async (client) => {
    const { rows: existing } = await client.query(`SELECT * FROM recommendations WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
    if (existing.length === 0) return;
    await client.query(`UPDATE recommendations SET status = 'dismissed' WHERE id = $1`, [req.params.id]);
    await writeAuditLog(client, {
      tenantId,
      actor: req.header("x-actor") || "unknown",
      action: "recommendation_dismissed",
      resourceType: "recommendations",
      resourceId: req.params.id,
      beforeState: existing[0],
      afterState: { status: "dismissed" },
    });
  });
  res.status(204).send();
});
