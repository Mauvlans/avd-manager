import { Router } from "express";
import { withTenant } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import type { HostPoolType, LoadBalancerType } from "@avd-manager/shared";
import { ArmHostPoolClient, resolveVmNameFromResourceId } from "../services/armHostPoolClient";
import { FakeTokenProvider } from "../services/tokenProvider";
import { tenantAuth } from "../middleware/tenantAuth";

export const hostPoolsRouter = Router();

hostPoolsRouter.use(tenantAuth);

hostPoolsRouter.get("/", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const rows = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM host_pools ORDER BY created_at DESC`
    );
    return rows;
  });
  res.json(rows);
});

hostPoolsRouter.get("/:id", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const row = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(`SELECT * FROM host_pools WHERE id = $1`, [req.params.id]);
    return rows[0] ?? null;
  });
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

hostPoolsRouter.post("/", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const { subscriptionId, resourceGroup, name, location, hostPoolType, loadBalancerType, maxSessionLimit, preferredAppGroupType } =
    req.body ?? {};
  if (!subscriptionId || !resourceGroup || !name || !location || !hostPoolType || !loadBalancerType) {
    return res.status(400).json({ error: "missing required fields" });
  }

  // Write the DB record first (source of truth for what we intend); then
  // call ARM. In v1 this is not yet wrapped in a saga/compensating-action —
  // see PROGRESS.md for the outbox/saga hardening follow-up.
  const created = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO host_pools (tenant_id, subscription_id, resource_group, name, location, host_pool_type, load_balancer_type, max_session_limit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [tenantId, subscriptionId, resourceGroup, name, location, hostPoolType, loadBalancerType, maxSessionLimit ?? 10]
    );
    const row = rows[0];
    await writeAuditLog(client, {
      tenantId,
      actor: req.header("x-actor") || "unknown",
      action: "host_pool_created",
      resourceType: "host_pools",
      resourceId: row.id,
      beforeState: null,
      afterState: row,
    });
    return row;
  });

  // Real ARM call — uses FakeTokenProvider in this sandbox since there's no
  // live tenant with granted RBAC. Swap for ClientCredentialsArmTokenProvider
  // in production. Now polls to a real terminal state (see
  // armHostPoolClient.createOrUpdateHostPool) instead of trusting a bare
  // 202/201 Accepted; a failed/timed-out ARM outcome is surfaced in the
  // response as a warning (still not rolled back — see PROGRESS.md's
  // outbox/saga hardening follow-up for that).
  try {
    const armClient = new ArmHostPoolClient(req.header("x-entra-tenant-id") || "unknown", new FakeTokenProvider());
    const result = await armClient.createOrUpdateHostPool(subscriptionId, resourceGroup, name, {
      location,
      hostPoolType: hostPoolType as HostPoolType,
      loadBalancerType: loadBalancerType as LoadBalancerType,
      maxSessionLimit: maxSessionLimit ?? 10,
      preferredAppGroupType: preferredAppGroupType === "RailApplication" ? "RailApplication" : "Desktop",
    });
    if (result.outcome !== "succeeded") {
      return res.status(202).json({
        ...created,
        warning: `DB record created but ARM host pool creation did not succeed (${result.outcome}): ${result.reason}`,
      });
    }
  } catch (err) {
    return res.status(202).json({
      ...created,
      warning: `DB record created but ARM call failed (expected in this sandbox without live Azure creds): ${(err as Error).message}`,
    });
  }

  res.status(201).json(created);
});

hostPoolsRouter.delete("/:id", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const deleted = await withTenant(tenantId, async (client) => {
    const { rows: existing } = await client.query(`SELECT * FROM host_pools WHERE id = $1`, [req.params.id]);
    if (existing.length === 0) return null;
    await client.query(`DELETE FROM host_pools WHERE id = $1`, [req.params.id]);
    await writeAuditLog(client, {
      tenantId,
      actor: req.header("x-actor") || "unknown",
      action: "host_pool_deleted",
      resourceType: "host_pools",
      resourceId: req.params.id,
      beforeState: existing[0],
      afterState: null,
    });
    return existing[0];
  });
  if (!deleted) return res.status(404).json({ error: "not found" });
  res.status(204).send();
});

/** Session-host-level routes (Priority 4 UI): list session hosts within a
 * host pool, and start/deallocate the underlying VM for one. These call
 * the same ArmHostPoolClient methods the autoscale timer uses, so the
 * manual UI action and the automated scaling path go through identical
 * ARM polling/outcome-surfacing logic — no separate "trust the POST"
 * shortcut for the UI. */
hostPoolsRouter.get("/:id/session-hosts", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const pool = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(`SELECT * FROM host_pools WHERE id = $1`, [req.params.id]);
    return rows[0] ?? null;
  });
  if (!pool) return res.status(404).json({ error: "not found" });

  const armClient = new ArmHostPoolClient(req.header("x-entra-tenant-id") || "unknown", new FakeTokenProvider());
  const hosts = await armClient.listSessionHosts(pool.subscription_id, pool.resource_group, pool.name);
  res.json(hosts);
});

async function loadHostPoolAndHost(tenantId: string, hostPoolId: string, sessionHostName: string) {
  const pool = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(`SELECT * FROM host_pools WHERE id = $1`, [hostPoolId]);
    return rows[0] ?? null;
  });
  if (!pool) return { pool: null, host: null };
  const armClient = new ArmHostPoolClient(pool.tenant_id, new FakeTokenProvider());
  const hosts = await armClient.listSessionHosts(pool.subscription_id, pool.resource_group, pool.name);
  const host = hosts.find((h) => h.name === sessionHostName) ?? null;
  return { pool, host, armClient };
}

hostPoolsRouter.post("/:id/session-hosts/:sessionHostName/start", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const { pool, host, armClient } = await loadHostPoolAndHost(tenantId, req.params.id, req.params.sessionHostName);
  if (!pool) return res.status(404).json({ error: "host pool not found" });
  if (!host) return res.status(404).json({ error: "session host not found" });

  try {
    const vmName = resolveVmNameFromResourceId(host.resourceId);
    const result = await armClient!.startVm(pool.subscription_id, pool.resource_group, vmName);
    await withTenant(tenantId, async (client) => {
      await writeAuditLog(client, {
        tenantId,
        actor: req.header("x-actor") || "unknown",
        action: result.outcome === "succeeded" ? "session_host_start_requested" : "session_host_start_failed",
        resourceType: "session_hosts",
        resourceId: req.params.sessionHostName,
        beforeState: null,
        afterState: result,
      });
    });
    if (result.outcome !== "succeeded") {
      return res.status(502).json({ error: `start did not succeed: ${result.outcome}`, detail: result });
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

hostPoolsRouter.post("/:id/session-hosts/:sessionHostName/deallocate", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const { pool, host, armClient } = await loadHostPoolAndHost(tenantId, req.params.id, req.params.sessionHostName);
  if (!pool) return res.status(404).json({ error: "host pool not found" });
  if (!host) return res.status(404).json({ error: "session host not found" });

  try {
    const vmName = resolveVmNameFromResourceId(host.resourceId);
    const result = await armClient!.deallocateVm(pool.subscription_id, pool.resource_group, vmName);
    await withTenant(tenantId, async (client) => {
      await writeAuditLog(client, {
        tenantId,
        actor: req.header("x-actor") || "unknown",
        action: result.outcome === "succeeded" ? "session_host_deallocate_requested" : "session_host_deallocate_failed",
        resourceType: "session_hosts",
        resourceId: req.params.sessionHostName,
        beforeState: null,
        afterState: result,
      });
    });
    if (result.outcome !== "succeeded") {
      return res.status(502).json({ error: `deallocate did not succeed: ${result.outcome}`, detail: result });
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
