import { Router } from "express";
import { withTenant } from "../db/pool";

export const auditLogRouter = Router();

auditLogRouter.use((req, res, next) => {
  const tenantId = req.header("x-tenant-id");
  if (!tenantId) return res.status(400).json({ error: "x-tenant-id header required" });
  (req as any).tenantId = tenantId;
  next();
});

auditLogRouter.get("/", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const rows = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows;
  });
  res.json(rows);
});
