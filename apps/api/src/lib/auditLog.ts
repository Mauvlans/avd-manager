import { PoolClient } from "pg";

export interface AuditEntryInput {
  tenantId: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  beforeState?: unknown;
  afterState?: unknown;
}

/** Writes one audit_log row. Call this inside the same transaction/withTenant
 * scope as the mutation it is documenting, so it either commits with the
 * change or rolls back with it — never a mutation without its audit trail. */
export async function writeAuditLog(client: PoolClient, entry: AuditEntryInput): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor, action, resource_type, resource_id, before_state, after_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.tenantId,
      entry.actor,
      entry.action,
      entry.resourceType,
      entry.resourceId,
      entry.beforeState ? JSON.stringify(entry.beforeState) : null,
      entry.afterState ? JSON.stringify(entry.afterState) : null,
    ]
  );
}
