import { Router } from "express";
import { withTenant } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import type { HostPoolType, LoadBalancerType } from "@avd-manager/shared";
import { ArmHostPoolClient } from "../services/armHostPoolClient";
import { FakeTokenProvider } from "../services/tokenProvider";

export const hostPoolsRouter = Router();

/** Middleware convention: every route in this file expects req.tenantId to
 * be populated by upstream auth middleware (not implemented in this stub —
 * see PROGRESS.md). For now we accept it via header for local dev/testing. */
hostPoolsRouter.use((req, res, next) => {
  const tenantId = req.header("x-tenant-id");
  if (!tenantId) return res.status(400).json({ error: "x-tenant-id header required" });
  (req as any).tenantId = tenantId;
  next();
});

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
  const { subscriptionId, resourceGroup, name, location, hostPoolType, loadBalancerType, maxSessionLimit } =
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
  // in production. Errors here are surfaced but do not roll back the DB
  // record in v1 (see PROGRESS.md: needs reconciliation/retry logic).
  try {
    const armClient = new ArmHostPoolClient(req.header("x-entra-tenant-id") || "unknown", new FakeTokenProvider());
    await armClient.createOrUpdateHostPool(subscriptionId, resourceGroup, name, {
      location,
      hostPoolType: hostPoolType as HostPoolType,
      loadBalancerType: loadBalancerType as LoadBalancerType,
      maxSessionLimit: maxSessionLimit ?? 10,
    });
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
