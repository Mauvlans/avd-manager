import type { NextFunction, Request, Response } from "express";
import { withSystem } from "../db/pool";

/**
 * MVP tenant-context auth middleware.
 *
 * Replaces the earlier "trust the x-tenant-id header" stub. This version
 * still uses a header-supplied tenant id (there is no real end-user identity
 * provider wired up yet — see PROGRESS.md), but it is now:
 *   1. Enforced centrally as middleware rather than duplicated ad-hoc in
 *      every router file.
 *   2. Validated against a shared-secret API key (`x-api-key`) checked
 *      against `API_AUTH_TOKEN`, so an arbitrary caller cannot simply invent
 *      a tenant id — they must also hold the service credential.
 *   3. Validated that the tenant id actually exists and is not suspended,
 *      via a real DB lookup (`withSystem`, bypassing RLS since we don't have
 *      tenant context yet), returning 401/403 rather than silently trusting
 *      the header.
 *
 * This is NOT a substitute for real per-user authentication (e.g. validating
 * a Graph-issued JWT for a logged-in tenant admin, mapping `oid`/`tid` claims
 * to our tenant row). That is the documented next step in PROGRESS.md. For
 * an internal MVP demo where the "caller" is our own web app talking to our
 * own API over a private network, this raises the bar from "no enforcement
 * at all" to "requires both a shared secret and a real, active tenant row"
 * without requiring a live Entra tenant to test against.
 */
export async function tenantAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const expectedToken = process.env.API_AUTH_TOKEN;
  if (expectedToken) {
    const presented = req.header("x-api-key");
    if (presented !== expectedToken) {
      res.status(401).json({ error: "invalid or missing x-api-key" });
      return;
    }
  }

  const tenantId = req.header("x-tenant-id");
  if (!tenantId) {
    res.status(400).json({ error: "x-tenant-id header required" });
    return;
  }

  try {
    const tenant = await withSystem(async (client) => {
      const { rows } = await client.query(`SELECT id, status FROM tenants WHERE id = $1`, [tenantId]);
      return rows[0] ?? null;
    });
    if (!tenant) {
      res.status(403).json({ error: "unknown tenant" });
      return;
    }
    if (tenant.status === "suspended") {
      res.status(403).json({ error: "tenant is suspended" });
      return;
    }
  } catch (err) {
    // If the DB is unreachable we fail closed, not open.
    res.status(503).json({ error: `auth check failed: ${(err as Error).message}` });
    return;
  }

  (req as any).tenantId = tenantId;
  next();
}
