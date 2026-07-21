import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import { withTenant, withSystem } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import { buildAdminConsentUrl } from "../services/graphClient";

export interface CreateTenantInput {
  displayName: string;
  entraTenantId: string;
}

/**
 * Onboarding service: creates the tenant row, generates the Graph
 * admin-consent link and Deploy-to-Azure RBAC template link, and records
 * grant status callbacks in subscriptions_registry.
 *
 * This is grant-tracking plumbing only — it does not itself call Graph or
 * Azure; it produces the URLs the customer's admin visits, and records the
 * *result* of those visits via callback endpoints.
 */
export class OnboardingService {
  constructor(
    private readonly appClientId: string,
    private readonly graphRedirectUri: string,
    private readonly deployToAzureTemplateUrl: string
  ) {}

  /** Privileged: creates a new tenant row. Bypasses per-tenant RLS since
   * there is no tenant context yet at creation time. */
  async createTenant(input: CreateTenantInput): Promise<{ id: string }> {
    return withSystem(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO tenants (display_name, entra_tenant_id, status)
         VALUES ($1, $2, 'onboarding') RETURNING id`,
        [input.displayName, input.entraTenantId]
      );
      return { id: rows[0].id };
    });
  }

  /** Builds the Graph admin-consent URL (grant a) for a tenant to complete
   * onboarding. `state` should encode the tenant id so the callback can
   * correlate the consent grant back to the right tenant row. */
  getAdminConsentUrl(tenantId: string): string {
    return buildAdminConsentUrl({
      clientId: this.appClientId,
      redirectUri: this.graphRedirectUri,
      state: tenantId,
    });
  }

  /** Returns the Deploy-to-Azure URL for the RBAC Bicep template (grant b).
   * The customer runs this in their own subscription; it deploys the custom
   * least-privilege role + assignment. See infra/bicep/rbac-delegation.bicep. */
  getDeployToAzureUrl(tenantId: string, subscriptionIdHint?: string): string {
    const url = new URL(this.deployToAzureTemplateUrl);
    url.searchParams.set("tenantCallbackState", tenantId);
    if (subscriptionIdHint) url.searchParams.set("subscriptionId", subscriptionIdHint);
    return url.toString();
  }

  /** Callback invoked after the customer's admin completes Graph consent.
   * Records the resulting service principal id and marks graph_consent_status
   * granted for the subscriptions_registry row(s) for this tenant — or, if
   * none exist yet for this subscription, upserts a placeholder row scoped
   * to graph-only until the RBAC grant (a separate flow) adds Azure scope. */
  async recordGraphConsentGranted(
    tenantId: string,
    subscriptionId: string,
    servicePrincipalId: string
  ): Promise<void> {
    await withTenant(tenantId, async (client) => {
      const before = await this.getRegistryRow(client, tenantId, subscriptionId);
      await client.query(
        `INSERT INTO subscriptions_registry (tenant_id, subscription_id, graph_consent_status, graph_consent_service_principal_id, graph_consent_granted_at)
         VALUES ($1, $2, 'granted', $3, now())
         ON CONFLICT (tenant_id, subscription_id)
         DO UPDATE SET graph_consent_status = 'granted', graph_consent_service_principal_id = $3, graph_consent_granted_at = now(), updated_at = now()`,
        [tenantId, subscriptionId, servicePrincipalId]
      );
      const after = await this.getRegistryRow(client, tenantId, subscriptionId);
      await writeAuditLog(client, {
        tenantId,
        actor: "system:graph-consent-callback",
        action: "graph_consent_granted",
        resourceType: "subscriptions_registry",
        resourceId: subscriptionId,
        beforeState: before,
        afterState: after,
      });
    });
  }

  /** Callback invoked after the customer runs the Deploy-to-Azure RBAC
   * template. Records which role definition was assigned and to which
   * resource groups. */
  async recordRbacGranted(
    tenantId: string,
    subscriptionId: string,
    roleDefinitionId: string,
    resourceGroups: string[]
  ): Promise<void> {
    await withTenant(tenantId, async (client) => {
      const before = await this.getRegistryRow(client, tenantId, subscriptionId);
      await client.query(
        `INSERT INTO subscriptions_registry (tenant_id, subscription_id, resource_groups, rbac_role_definition_id, rbac_grant_status, rbac_last_verified_at)
         VALUES ($1, $2, $3, $4, 'granted', now())
         ON CONFLICT (tenant_id, subscription_id)
         DO UPDATE SET resource_groups = $3, rbac_role_definition_id = $4, rbac_grant_status = 'granted', rbac_last_verified_at = now(), updated_at = now()`,
        [tenantId, subscriptionId, resourceGroups, roleDefinitionId]
      );
      const after = await this.getRegistryRow(client, tenantId, subscriptionId);
      await writeAuditLog(client, {
        tenantId,
        actor: "system:rbac-deploy-callback",
        action: "rbac_granted",
        resourceType: "subscriptions_registry",
        resourceId: subscriptionId,
        beforeState: before,
        afterState: after,
      });
    });
  }

  private async getRegistryRow(client: PoolClient, tenantId: string, subscriptionId: string) {
    const { rows } = await client.query(
      `SELECT * FROM subscriptions_registry WHERE tenant_id = $1 AND subscription_id = $2`,
      [tenantId, subscriptionId]
    );
    return rows[0] ?? null;
  }
}

export const requestCorrelationId = () => randomUUID();
