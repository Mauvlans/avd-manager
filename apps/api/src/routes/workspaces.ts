import { Router } from "express";
import { withTenant } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import { ArmWorkspaceClient } from "../services/armWorkspaceClient";
import { FakeTokenProvider } from "../services/tokenProvider";
import { tenantAuth } from "../middleware/tenantAuth";

/**
 * CRUD routes for real Azure AVD Workspaces
 * (Microsoft.DesktopVirtualization/workspaces), plus attach/detach for
 * publishing an Application Group into a Workspace. Part of the Host
 * Pools L2 tab experience (Host Pools / Application Groups / Workspaces)
 * per Adam's mock. ARM is the sole source of truth, no local DB table —
 * mirrors scalingPlans.ts/applicationGroups.ts's conventions exactly.
 */
export const workspacesRouter = Router();

workspacesRouter.use(tenantAuth);

function buildClient(req: any): ArmWorkspaceClient {
  return new ArmWorkspaceClient(req.header("x-entra-tenant-id") || "unknown", new FakeTokenProvider());
}

workspacesRouter.get("/", async (req, res) => {
  const subscriptionId = req.query.subscriptionId as string | undefined;
  const resourceGroup = req.query.resourceGroup as string | undefined;
  if (!subscriptionId || !resourceGroup) {
    return res.status(400).json({ error: "subscriptionId and resourceGroup are required" });
  }
  try {
    const client = buildClient(req);
    const workspaces = await client.listWorkspaces(subscriptionId, resourceGroup);
    res.json(workspaces);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

workspacesRouter.get("/:name", async (req, res) => {
  const subscriptionId = req.query.subscriptionId as string | undefined;
  const resourceGroup = req.query.resourceGroup as string | undefined;
  if (!subscriptionId || !resourceGroup) {
    return res.status(400).json({ error: "subscriptionId and resourceGroup are required" });
  }
  try {
    const client = buildClient(req);
    const ws = await client.getWorkspace(subscriptionId, resourceGroup, req.params.name);
    if (!ws) return res.status(404).json({ error: "not found" });
    res.json(ws);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

workspacesRouter.put("/:name", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const { subscriptionId, resourceGroup, ...params } = req.body ?? {};
  if (!subscriptionId || !resourceGroup) {
    return res.status(400).json({ error: "subscriptionId and resourceGroup are required" });
  }
  try {
    const client = buildClient(req);
    const result = await client.createOrUpdateWorkspace(subscriptionId, resourceGroup, req.params.name, {
      applicationGroupReferences: [],
      ...params,
    });
    await withTenant(tenantId, async (dbClient) => {
      await writeAuditLog(dbClient, {
        tenantId,
        actor: req.header("x-actor") || "unknown",
        action: result.outcome === "succeeded" ? "workspace_created_or_updated" : "workspace_write_failed",
        resourceType: "workspaces",
        resourceId: req.params.name,
        beforeState: null,
        afterState: result,
      });
    });
    if (result.outcome !== "succeeded") {
      return res.status(502).json({ error: `workspace write did not succeed: ${result.outcome}`, detail: result });
    }
    res.json(result.data);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

workspacesRouter.delete("/:name", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const subscriptionId = req.query.subscriptionId as string | undefined;
  const resourceGroup = req.query.resourceGroup as string | undefined;
  if (!subscriptionId || !resourceGroup) {
    return res.status(400).json({ error: "subscriptionId and resourceGroup are required" });
  }
  try {
    const client = buildClient(req);
    await client.deleteWorkspace(subscriptionId, resourceGroup, req.params.name);
    await withTenant(tenantId, async (dbClient) => {
      await writeAuditLog(dbClient, {
        tenantId,
        actor: req.header("x-actor") || "unknown",
        action: "workspace_deleted",
        resourceType: "workspaces",
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

workspacesRouter.post("/:name/attach", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const { subscriptionId, resourceGroup, applicationGroupArmPath } = req.body ?? {};
  if (!subscriptionId || !resourceGroup || !applicationGroupArmPath) {
    return res.status(400).json({ error: "subscriptionId, resourceGroup, and applicationGroupArmPath are required" });
  }
  try {
    const client = buildClient(req);
    const result = await client.attachApplicationGroup(subscriptionId, resourceGroup, req.params.name, applicationGroupArmPath);
    await withTenant(tenantId, async (dbClient) => {
      await writeAuditLog(dbClient, {
        tenantId,
        actor: req.header("x-actor") || "unknown",
        action: result.outcome === "succeeded" ? "workspace_app_group_attached" : "workspace_app_group_attach_failed",
        resourceType: "workspaces",
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

workspacesRouter.post("/:name/detach", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const { subscriptionId, resourceGroup, applicationGroupArmPath } = req.body ?? {};
  if (!subscriptionId || !resourceGroup || !applicationGroupArmPath) {
    return res.status(400).json({ error: "subscriptionId, resourceGroup, and applicationGroupArmPath are required" });
  }
  try {
    const client = buildClient(req);
    const result = await client.detachApplicationGroup(subscriptionId, resourceGroup, req.params.name, applicationGroupArmPath);
    await withTenant(tenantId, async (dbClient) => {
      await writeAuditLog(dbClient, {
        tenantId,
        actor: req.header("x-actor") || "unknown",
        action: result.outcome === "succeeded" ? "workspace_app_group_detached" : "workspace_app_group_detach_failed",
        resourceType: "workspaces",
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
