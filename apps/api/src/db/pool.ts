import { Pool, PoolClient } from "pg";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgres://avd_app:avd_app_password_change_me@localhost:5432/avdmanager",
});

/**
 * Runs `fn` inside a transaction with `app.current_tenant` set for the
 * duration, so that Postgres RLS policies scope every query to that tenant.
 * This is the ONLY sanctioned way application code should touch tenant-scoped
 * tables — never grab a raw client and skip the SET LOCAL.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.current_tenant = $1", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * For privileged/system operations that legitimately span tenants (tenant
 * onboarding creation, cross-tenant health-check jobs). Use sparingly and
 * never expose directly to a tenant-scoped HTTP request.
 */
export async function withSystem<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const result = await fn(client);
    return result;
  } finally {
    client.release();
  }
}

export default pool;
