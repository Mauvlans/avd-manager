import { Router } from "express";
import { withTenant } from "../db/pool";
import { tenantAuth } from "../middleware/tenantAuth";

export const auditLogRouter = Router();

auditLogRouter.use(tenantAuth);

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
