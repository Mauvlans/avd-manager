import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import { withTenant, withSystem } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import { buildAdminConsentUrl, GraphClient } from "../services/graphClient";
import { acquireClientCredentialsToken } from "../services/tokenProvider";

/**
 * Onboarding service: generates the Graph admin-consent link and
 * Deploy-to-Azure RBAC template link, and records grant status callbacks in
 * tenants/subscriptions_registry.
 *
 * Auto-creates the tenant row from Microsoft's own OAuth admin-consent
 * redirect (which includes the real Entra tenant GUID) rather than asking
 * the operator to manually type in a display name + tenant GUID before
 * consent even happens — that manual step was pure duplication of
 * information Microsoft hands us for free in the callback, and it invited
 * typos in a GUID a human was never meant to transcribe.
 *
 * This is grant-tracking plumbing only — it does not itself call Graph or
 * Azure resource APIs; it produces the URLs the customer's admin visits,
 * and records the *result* of those visits via callback endpoints.
 */
export class OnboardingService {
  constructor(
    private readonly appClientId: string,
    private readonly graphRedirectUri: string,
    private readonly deployToAzureTemplateUrl: string,
    private readonly appClientSecret: string | null = null
  ) {}

  /** Builds the Graph admin-consent URL (grant a) to start onboarding a new
   * customer. `state` is a client-generated correlation nonce, not a tenant
   * id — we don't know the customer's tenant yet. Callers should generate
   * a fresh nonce per attempt (e.g. randomUUID()) purely so the browser
   * can recognize its own redirect coming back; the server does not persist
   * or validate this nonce today (documented gap — a real implementation
   * should validate it against a short-lived, server-issued anti-CSRF
   * value instead of trusting whatever the browser echoes back). */
  getAdminConsentUrl(correlationNonce: string): string {
    return buildAdminConsentUrl({
      clientId: this.appClientId,
      redirectUri: this.graphRedirectUri,
      state: correlationNonce,
    });
  }

  /** Returns the Deploy-to-Azure URL for the RBAC Bicep template (grant b),
   * plus the service principal object id the admin needs to manually paste
   * into the deployment's parameter field.
   *
   * IMPORTANT — auto-fill via URL was attempted and abandoned after two
   * live failures: portal.azure.com's Custom Deployment blade has NO
   * documented mechanism for pre-filling arbitrary parameter values via
   * the deploy-button URL. Microsoft's own docs
   * (learn.microsoft.com/azure/azure-resource-manager/templates/deploy-to-azure-button)
   * state only "default values from the template" pre-fill — nothing about
   * URL query params or fragment params setting parameter values. An
   * earlier version of this method tried appending
   * avdManagerServicePrincipalObjectId as both a plain query param and a
   * fragment param; neither worked when Adam tested it live against the
   * real portal, which matches the docs once actually checked instead of
   * assumed. Rather than keep guessing at undocumented behavior, this
   * returns the SP id separately so the frontend can display it for a
   * manual copy-paste — a small manual step, but a correct and honest
   * one instead of a UI that silently fails to do what it claims. */
  async getDeployToAzureUrl(
    tenantId: string,
    subscriptionIdHint?: string
  ): Promise<{ url: string; avdManagerServicePrincipalObjectId: string | null }> {
    const url = new URL(this.deployToAzureTemplateUrl);

    const servicePrincipalId = await withTenant(tenantId, async (client) => {
      const row = await this.getPendingRegistryRow(client, tenantId);
      return row?.graph_consent_service_principal_id ?? null;
    });

    return { url: url.toString(), avdManagerServicePrincipalObjectId: servicePrincipalId };
  }

  /** Callback invoked after the customer's admin completes Graph consent.
   * Microsoft's redirect includes the real Entra tenant GUID (`tenant`
   * query param) — this is the FIRST time we learn who the customer is, so
   * this call auto-creates (or reuses, if this Entra tenant already
   * onboarded before) the tenant row, instead of requiring a prior manual
   * "create tenant" step.
   *
   * IMPORTANT: Microsoft's admin-consent redirect does NOT include a
   * servicePrincipalId parameter — an earlier version of this codebase
   * incorrectly assumed it would and 400'd on every real consent
   * completion (only caught once a real admin actually clicked through
   * consent; mocked tests never exercise a real AAD redirect's actual
   * query string). The service principal for our app in the customer's
   * tenant has to be looked up via Graph, using an app-only
   * (client-credentials) token for OUR OWN app against THIS customer's
   * tenant — which itself only works because admin consent (which just
   * happened) is what authorizes our app to get any token in their tenant
   * at all. If appClientSecret isn't configured, this degrades to
   * recording consent with a null service principal id rather than
   * failing the whole callback — the RBAC step below doesn't strictly
   * need it (Deploy-to-Azure already asks for/embeds the SP id itself via
   * getDeployToAzureUrl's lookup), so a real product would want a retry
   * job here more than a hard failure.
   *
   * Privileged (withSystem): tenant creation legitimately spans tenants
   * (there's no RLS context yet for a tenant we're only just learning
   * about). Returns the tenant id so the frontend can pick up the wizard's
   * remaining steps (Deploy-to-Azure link, registry status polling)
   * without ever having asked the admin to type in a GUID. */
  async recordGraphConsentGranted(
    entraTenantId: string,
    displayNameHint?: string
  ): Promise<{ tenantId: string }> {
    const servicePrincipalId = await this.resolveOwnServicePrincipalId(entraTenantId);

    return withSystem(async (client) => {
      const upserted = await client.query(
        `INSERT INTO tenants (display_name, entra_tenant_id, status)
         VALUES ($1, $2, 'onboarding')
         ON CONFLICT (entra_tenant_id) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [displayNameHint || entraTenantId, entraTenantId]
      );
      const tenantId = upserted.rows[0].id;

      const before = await this.getPendingRegistryRow(client, tenantId);
      await client.query(
        `INSERT INTO subscriptions_registry (tenant_id, subscription_id, graph_consent_status, graph_consent_service_principal_id, graph_consent_granted_at)
         VALUES ($1, NULL, 'granted', $2, now())
         ON CONFLICT (tenant_id) WHERE subscription_id IS NULL
         DO UPDATE SET graph_consent_status = 'granted', graph_consent_service_principal_id = $2, graph_consent_granted_at = now(), updated_at = now()`,
        [tenantId, servicePrincipalId]
      );
      const after = await this.getPendingRegistryRow(client, tenantId);
      await writeAuditLog(client, {
        tenantId,
        actor: "system:graph-consent-callback",
        action: "graph_consent_granted",
        resourceType: "subscriptions_registry",
        resourceId: tenantId,
        beforeState: before,
        afterState: after,
      });
      return { tenantId };
    });
  }

  /** Looks up our own app's service principal object id inside the
   * customer's tenant, using an app-only token for OUR app acquired
   * against THEIR tenant. Returns null (rather than throwing) if no
   * client secret is configured or the lookup fails — see
   * recordGraphConsentGranted's docstring for why this is a soft failure,
   * not a hard one. */
  private async resolveOwnServicePrincipalId(entraTenantId: string): Promise<string | null> {
    if (!this.appClientSecret) return null;
    try {
      const token = await acquireClientCredentialsToken(
        entraTenantId,
        this.appClientId,
        this.appClientSecret,
        "https://graph.microsoft.com/.default"
      );
      const graphClient = new GraphClient(async () => token);
      const sp = await graphClient.getServicePrincipalByAppId(this.appClientId);
      return sp?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Callback invoked after the customer runs the Deploy-to-Azure RBAC
   * template. Records which role definition was assigned and to which
   * resource groups. If a pending (subscription_id IS NULL) row exists from
   * the Graph-consent step above, this fills the subscription id into that
   * same row rather than creating a second one — Graph consent and RBAC
   * grant are two separate authorization surfaces for the SAME onboarding
   * event, not two unrelated registry rows. */
  async recordRbacGranted(
    tenantId: string,
    subscriptionId: string,
    roleDefinitionId: string,
    resourceGroups: string[]
  ): Promise<void> {
    await withTenant(tenantId, async (client) => {
      const pending = await this.getPendingRegistryRow(client, tenantId);
      const before = pending ?? (await this.getRegistryRow(client, tenantId, subscriptionId));

      if (pending) {
        await client.query(
          `UPDATE subscriptions_registry
           SET subscription_id = $2, resource_groups = $3, rbac_role_definition_id = $4,
               rbac_grant_status = 'granted', rbac_last_verified_at = now(), updated_at = now()
           WHERE id = $1`,
          [pending.id, subscriptionId, resourceGroups, roleDefinitionId]
        );
      } else {
        await client.query(
          `INSERT INTO subscriptions_registry (tenant_id, subscription_id, resource_groups, rbac_role_definition_id, rbac_grant_status, rbac_last_verified_at)
           VALUES ($1, $2, $3, $4, 'granted', now())
           ON CONFLICT (tenant_id, subscription_id)
           DO UPDATE SET resource_groups = $3, rbac_role_definition_id = $4, rbac_grant_status = 'granted', rbac_last_verified_at = now(), updated_at = now()`,
          [tenantId, subscriptionId, resourceGroups, roleDefinitionId]
        );
      }

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

  private async getPendingRegistryRow(client: PoolClient, tenantId: string) {
    const { rows } = await client.query(
      `SELECT * FROM subscriptions_registry WHERE tenant_id = $1 AND subscription_id IS NULL`,
      [tenantId]
    );
    return rows[0] ?? null;
  }

  /** Returns all subscriptions_registry rows for a tenant, for the
   * onboarding wizard's status-poll step. Uses withTenant (RLS-scoped) since
   * this is read on behalf of a specific tenant, not a system operation. */
  async listRegistryRows(tenantId: string) {
    return withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, tenant_id, subscription_id, resource_groups, rbac_role_definition_id,
                rbac_grant_status, rbac_last_verified_at, rbac_drift_details,
                graph_consent_status, graph_consent_service_principal_id, graph_consent_granted_at,
                created_at, updated_at
         FROM subscriptions_registry
         WHERE tenant_id = $1
         ORDER BY created_at ASC`,
        [tenantId]
      );
      return rows;
    });
  }
}

export const requestCorrelationId = () => randomUUID();
