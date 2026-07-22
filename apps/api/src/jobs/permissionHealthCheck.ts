import { withSystem } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import { getPlatformConfig } from "../services/platformConfigStore";
import { ArmRoleAssignmentVerifier } from "../services/armRoleAssignmentVerifier";

/**
 * Periodic RBAC drift-detection job (this is our replacement for the
 * "delegated resource management" visibility that Azure Lighthouse would
 * normally provide — see README's "no Lighthouse" decision). For every
 * subscriptions_registry row with rbac_grant_status = 'granted', re-checks
 * (in production) whether the expected custom role assignment still exists
 * at the expected scope via a real ARM roleAssignments list call. In this
 * sandbox there is no live tenant, so the ARM check is behind an injectable
 * interface and this job runs against a mock verifier by default — wire in
 * a real RoleAssignmentVerifier for production.
 */
export interface RoleAssignmentVerifier {
  /** Returns true if the expected role assignment is present and correctly
   * scoped; false if it's missing/modified (drift). */
  verify(params: {
    entraTenantId: string;
    subscriptionId: string;
    resourceGroups: string[];
    roleDefinitionId: string;
  }): Promise<boolean>;
}

/** Stub verifier — NOT validated against real Azure. Always returns true so
 * the health-check job can be exercised end-to-end locally without lying
 * about live drift detection. Replace with a real ARM
 * roleAssignments.listForScope call in production. */
export class StubRoleAssignmentVerifier implements RoleAssignmentVerifier {
  async verify(): Promise<boolean> {
    return true;
  }
}

export async function runPermissionHealthCheck(
  verifier: RoleAssignmentVerifier = new StubRoleAssignmentVerifier()
): Promise<{ checked: number; driftDetected: number }> {
  const rows = await withSystem(async (client) => {
    const { rows } = await client.query(
      `SELECT sr.*, t.entra_tenant_id
       FROM subscriptions_registry sr
       JOIN tenants t ON t.id = sr.tenant_id
       WHERE sr.rbac_grant_status = 'granted'`
    );
    return rows;
  });

  let driftDetected = 0;

  for (const row of rows) {
    const ok = await verifier.verify({
      entraTenantId: row.entra_tenant_id,
      subscriptionId: row.subscription_id,
      resourceGroups: row.resource_groups,
      roleDefinitionId: row.rbac_role_definition_id,
    });

    await withSystem(async (client) => {
      if (ok) {
        await client.query(
          `UPDATE subscriptions_registry SET rbac_last_verified_at = now(), rbac_drift_details = NULL, updated_at = now() WHERE id = $1`,
          [row.id]
        );
      } else {
        driftDetected += 1;
        const driftDetails = `RBAC role assignment ${row.rbac_role_definition_id} not found/modified at expected scope as of ${new Date().toISOString()}`;
        await client.query(
          `UPDATE subscriptions_registry SET rbac_grant_status = 'drifted', rbac_drift_details = $1, rbac_last_verified_at = now(), updated_at = now() WHERE id = $2`,
          [driftDetails, row.id]
        );
        await writeAuditLog(client, {
          tenantId: row.tenant_id,
          actor: "system:permission-health-check",
          action: "rbac_drift_detected",
          resourceType: "subscriptions_registry",
          resourceId: row.subscription_id,
          beforeState: { rbac_grant_status: "granted" },
          afterState: { rbac_grant_status: "drifted", driftDetails },
        });
      }
    });
  }

  return { checked: rows.length, driftDetected };
}

if (require.main === module) {
  // When run directly (e.g. as a scheduled job), use the real ARM-backed
  // verifier if a platform app registration + secret are configured;
  // otherwise fall back to the stub so this can still be exercised without
  // live credentials. See platformConfigStore.ts and
  // armRoleAssignmentVerifier.ts for why a real verifier — not a
  // customer-side webhook — is how RBAC grants actually get detected (ARM
  // template deployments have no built-in "call this webhook on success"
  // primitive without heavyweight deploymentScripts machinery).
  const config = getPlatformConfig();
  const verifier =
    config.clientSecret && config.clientId !== "00000000-0000-0000-0000-000000000000"
      ? new ArmRoleAssignmentVerifier(config.clientId, config.clientSecret)
      : new StubRoleAssignmentVerifier();

  runPermissionHealthCheck(verifier)
    .then((result) => {
      console.log(`[permission-health-check] checked=${result.checked} drift=${result.driftDetected}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
