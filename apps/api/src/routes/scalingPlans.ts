import { Router } from "express";
import { withTenant } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import { ArmScalingPlanClient } from "../services/armScalingPlanClient";
import { resolveArmAuth } from "../services/armAuthResolver";
import { tenantAuth } from "../middleware/tenantAuth";

/**
 * CRUD routes for native Azure AVD Scaling Plans
 * (Microsoft.DesktopVirtualization/scalingPlans), replacing the retired
 * custom scaling-policy engine. Per Adam's decision, this app does not
 * run its own scheduling loop or evaluate its own scale-out/scale-in
 * decisions — it only surfaces and manages the scaling plans Azure itself
 * executes. There is intentionally no local DB table backing scaling
 * plans (unlike host_pools): ARM is the sole source of truth, so there is
 * nothing here to keep in sync or drift-detect against a local mirror.
 *
 * Mirrors hostPools.ts's tenantAuth + FakeTokenProvider + ArmLroResult
 * handling pattern exactly, for the same reasons documented there (only
 * one ARM-calling convention in this codebase, not two).
 */
export const scalingPlansRouter = Router();

scalingPlansRouter.use(tenantAuth);

function buildClient(req: any): Promise<ArmScalingPlanClient> {
  const tenantId = req.tenantId as string;
  return resolveArmAuth(tenantId).then(({ entraTenantId, tokenProvider }) => new ArmScalingPlanClient(entraTenantId, tokenProvider));
}

scalingPlansRouter.get("/", async (req, res) => {
  const subscriptionId = req.query.subscriptionId as string | undefined;
  const resourceGroup = req.query.resourceGroup as string | undefined;
  if (!subscriptionId || !resourceGroup) {
    return res.status(400).json({ error: "subscriptionId and resourceGroup are required" });
  }
  try {
    const client = await buildClient(req);
    const plans = await client.listScalingPlans(subscriptionId, resourceGroup);
    res.json(plans);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

scalingPlansRouter.get("/:name", async (req, res) => {
  const subscriptionId = req.query.subscriptionId as string | undefined;
  const resourceGroup = req.query.resourceGroup as string | undefined;
  if (!subscriptionId || !resourceGroup) {
    return res.status(400).json({ error: "subscriptionId and resourceGroup are required" });
  }
  try {
    const client = await buildClient(req);
    const plan = await client.getScalingPlan(subscriptionId, resourceGroup, req.params.name);
    if (!plan) return res.status(404).json({ error: "not found" });
    res.json(plan);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

scalingPlansRouter.put("/:name", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const { subscriptionId, resourceGroup, ...params } = req.body ?? {};
  if (!subscriptionId || !resourceGroup) {
    return res.status(400).json({ error: "subscriptionId and resourceGroup are required" });
  }
  try {
    const client = await buildClient(req);
    const result = await client.createOrUpdateScalingPlan(subscriptionId, resourceGroup, req.params.name, params);
    await withTenant(tenantId, async (dbClient) => {
      await writeAuditLog(dbClient, {
        tenantId,
        actor: req.header("x-actor") || "unknown",
        action: result.outcome === "succeeded" ? "scaling_plan_created_or_updated" : "scaling_plan_write_failed",
        resourceType: "scaling_plans",
        resourceId: req.params.name,
        beforeState: null,
        afterState: result,
      });
    });
    if (result.outcome !== "succeeded") {
      return res.status(502).json({ error: `scaling plan write did not succeed: ${result.outcome}`, detail: result });
    }
    res.json(result.data);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

scalingPlansRouter.delete("/:name", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const subscriptionId = req.query.subscriptionId as string | undefined;
  const resourceGroup = req.query.resourceGroup as string | undefined;
  if (!subscriptionId || !resourceGroup) {
    return res.status(400).json({ error: "subscriptionId and resourceGroup are required" });
  }
  try {
    const client = await buildClient(req);
    await client.deleteScalingPlan(subscriptionId, resourceGroup, req.params.name);
    await withTenant(tenantId, async (dbClient) => {
      await writeAuditLog(dbClient, {
        tenantId,
        actor: req.header("x-actor") || "unknown",
        action: "scaling_plan_deleted",
        resourceType: "scaling_plans",
        resourceId: req.params.name,
        beforeState: null,
        afterState: null,
      });
    });
    res.status(204).send();
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

scalingPlansRouter.post("/:name/attach", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const { subscriptionId, resourceGroup, hostPoolArmPath, scalingPlanEnabled = true } = req.body ?? {};
  if (!subscriptionId || !resourceGroup || !hostPoolArmPath) {
    return res.status(400).json({ error: "subscriptionId, resourceGroup, and hostPoolArmPath are required" });
  }
  try {
    const client = await buildClient(req);
    const result = await client.attachScalingPlanToHostPool(
      subscriptionId,
      resourceGroup,
      req.params.name,
      hostPoolArmPath,
      scalingPlanEnabled
    );
    await withTenant(tenantId, async (dbClient) => {
      await writeAuditLog(dbClient, {
        tenantId,
        actor: req.header("x-actor") || "unknown",
        action: result.outcome === "succeeded" ? "scaling_plan_attached" : "scaling_plan_attach_failed",
        resourceType: "scaling_plans",
        resourceId: req.params.name,
        beforeState: null,
        afterState: result,
      });
    });
    if (result.outcome !== "succeeded") {
      return res.status(502).json({ error: `attach did not succeed: ${result.outcome}`, detail: result });
    }
    res.json(result.data);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

scalingPlansRouter.post("/:name/detach", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const { subscriptionId, resourceGroup, hostPoolArmPath } = req.body ?? {};
  if (!subscriptionId || !resourceGroup || !hostPoolArmPath) {
    return res.status(400).json({ error: "subscriptionId, resourceGroup, and hostPoolArmPath are required" });
  }
  try {
    const client = await buildClient(req);
    const result = await client.detachScalingPlanFromHostPool(subscriptionId, resourceGroup, req.params.name, hostPoolArmPath);
    await withTenant(tenantId, async (dbClient) => {
      await writeAuditLog(dbClient, {
        tenantId,
        actor: req.header("x-actor") || "unknown",
        action: result.outcome === "succeeded" ? "scaling_plan_detached" : "scaling_plan_detach_failed",
        resourceType: "scaling_plans",
        resourceId: req.params.name,
        beforeState: null,
        afterState: result,
      });
    });
    if (result.outcome !== "succeeded") {
      return res.status(502).json({ error: `detach did not succeed: ${result.outcome}`, detail: result });
    }
    res.json(result.data);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
