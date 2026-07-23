import { Router } from "express";
import { withTenant } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import { ArmApplicationGroupClient } from "../services/armApplicationGroupClient";
import { resolveArmAuth } from "../services/armAuthResolver";
import { tenantAuth } from "../middleware/tenantAuth";

/**
 * CRUD routes for real Azure AVD Application Groups
 * (Microsoft.DesktopVirtualization/applicationGroups). Part of the Host
 * Pools L2 tab experience (Host Pools / Application Groups / Workspaces)
 * per Adam's mock — ARM is the sole source of truth, no local DB table,
 * matching scalingPlans.ts's precedent for ARM-native-only resources.
 *
 * Mirrors scalingPlans.ts's tenantAuth + FakeTokenProvider + ArmLroResult
 * handling exactly, for the same one-ARM-calling-convention reason.
 */
export const applicationGroupsRouter = Router();

applicationGroupsRouter.use(tenantAuth);

function buildClient(req: any): Promise<ArmApplicationGroupClient> {
  const tenantId = req.tenantId as string;
  return resolveArmAuth(tenantId).then(({ entraTenantId, tokenProvider }) => new ArmApplicationGroupClient(entraTenantId, tokenProvider));
}

applicationGroupsRouter.get("/", async (req, res) => {
  const subscriptionId = req.query.subscriptionId as string | undefined;
  const resourceGroup = req.query.resourceGroup as string | undefined;
  if (!subscriptionId || !resourceGroup) {
    return res.status(400).json({ error: "subscriptionId and resourceGroup are required" });
  }
  try {
    const client = await buildClient(req);
    const groups = await client.listApplicationGroups(subscriptionId, resourceGroup);
    res.json(groups);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

applicationGroupsRouter.get("/:name", async (req, res) => {
  const subscriptionId = req.query.subscriptionId as string | undefined;
  const resourceGroup = req.query.resourceGroup as string | undefined;
  if (!subscriptionId || !resourceGroup) {
    return res.status(400).json({ error: "subscriptionId and resourceGroup are required" });
  }
  try {
    const client = await buildClient(req);
    const group = await client.getApplicationGroup(subscriptionId, resourceGroup, req.params.name);
    if (!group) return res.status(404).json({ error: "not found" });
    res.json(group);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

applicationGroupsRouter.put("/:name", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const { subscriptionId, resourceGroup, ...params } = req.body ?? {};
  if (!subscriptionId || !resourceGroup) {
    return res.status(400).json({ error: "subscriptionId and resourceGroup are required" });
  }
  if (!params.hostPoolArmPath || !params.applicationGroupType) {
    return res.status(400).json({ error: "hostPoolArmPath and applicationGroupType are required" });
  }
  try {
    const client = await buildClient(req);
    const result = await client.createOrUpdateApplicationGroup(subscriptionId, resourceGroup, req.params.name, params);
    await withTenant(tenantId, async (dbClient) => {
      await writeAuditLog(dbClient, {
        tenantId,
        actor: req.header("x-actor") || "unknown",
        action: result.outcome === "succeeded" ? "application_group_created_or_updated" : "application_group_write_failed",
        resourceType: "application_groups",
        resourceId: req.params.name,
        beforeState: null,
        afterState: result,
      });
    });
    if (result.outcome !== "succeeded") {
      return res.status(502).json({ error: `application group write did not succeed: ${result.outcome}`, detail: result });
    }
    res.json(result.data);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

applicationGroupsRouter.delete("/:name", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const subscriptionId = req.query.subscriptionId as string | undefined;
  const resourceGroup = req.query.resourceGroup as string | undefined;
  if (!subscriptionId || !resourceGroup) {
    return res.status(400).json({ error: "subscriptionId and resourceGroup are required" });
  }
  try {
    const client = await buildClient(req);
    await client.deleteApplicationGroup(subscriptionId, resourceGroup, req.params.name);
    await withTenant(tenantId, async (dbClient) => {
      await writeAuditLog(dbClient, {
        tenantId,
        actor: req.header("x-actor") || "unknown",
        action: "application_group_deleted",
        resourceType: "application_groups",
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
