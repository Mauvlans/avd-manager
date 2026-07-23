import { withSystem } from "../db/pool";
import { ClientCredentialsArmTokenProvider } from "./tokenProvider";
import { getPlatformConfig } from "./platformConfigStore";
import type { TokenProvider } from "./armHostPoolClient";

/**
 * Resolves REAL ARM auth (entra tenant GUID + a real TokenProvider) for a
 * given AVD Manager tenant id (our own UUID, not the customer's Entra
 * tenant GUID), replacing the FakeTokenProvider placeholder that every
 * ARM-backed route previously used unconditionally — that placeholder
 * returns a fake bearer token string, which ARM correctly rejects with a
 * 401 InvalidAuthenticationToken the moment a route is actually exercised
 * against a real subscription (exactly what Adam hit live on Settings >
 * Monitored Resource Groups).
 *
 * Looks up the tenant's real entra_tenant_id from the tenants table, then
 * builds a ClientCredentialsArmTokenProvider using our own app's
 * clientId/clientSecret from platformConfigStore (the same credentials
 * Setup creates and onboardingService already uses for Graph calls) —
 * this is the multi-tenant app registration + client-credentials flow
 * that's authorized to call ARM in the customer's tenant BECAUSE they
 * granted RBAC to it (see infra/bicep/rbac-delegation.bicep), not a
 * separate auth mechanism.
 *
 * Throws a clear, actionable error (not a silent fake-token 401) if the
 * platform isn't configured yet or the tenant can't be found — callers
 * should surface this error directly rather than swallow it, since "ARM
 * calls don't work until Setup + Onboarding are both done" is a real,
 * expected precondition, not a bug to paper over.
 */
export async function resolveArmAuth(
  avdManagerTenantId: string
): Promise<{ entraTenantId: string; tokenProvider: TokenProvider }> {
  const config = getPlatformConfig();
  if (!config.clientSecret) {
    throw new Error(
      "AVD Manager's platform app registration has no client secret configured yet — complete Settings > Onboarding's Platform Setup step first."
    );
  }
  const tenantRow = await withSystem(async (client) => {
    const { rows } = await client.query(`SELECT entra_tenant_id FROM tenants WHERE id = $1`, [avdManagerTenantId]);
    return rows[0] ?? null;
  });
  if (!tenantRow?.entra_tenant_id) {
    throw new Error(`No tenant found for id ${avdManagerTenantId} — complete Onboarding first.`);
  }
  return {
    entraTenantId: tenantRow.entra_tenant_id,
    tokenProvider: new ClientCredentialsArmTokenProvider(config.clientId, config.clientSecret),
  };
}

