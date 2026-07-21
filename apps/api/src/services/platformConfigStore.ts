/**
 * Mutable platform config: the Entra app registration this AVD Manager
 * instance runs as. Historically this was read once from env vars at
 * process startup (ENTRA_APP_CLIENT_ID etc.), which forced an operator to
 * copy a client id/secret out of the Setup wizard, set env vars, and
 * restart the API — clunky for a first-run experience. Now Setup's
 * /api/setup/complete call updates this in-memory store directly, so the
 * very next onboarding request in the same process picks up the real
 * client id with no restart.
 *
 * Trade-off: this is intentionally NOT persisted to durable storage yet
 * (documented gap — see PROGRESS.md). A process restart reverts to
 * whatever ENTRA_APP_CLIENT_ID/etc. are in the environment. For a
 * single-operator local/dev run (which is the only scenario this
 * in-memory store is meant to serve) that's an acceptable trade — the
 * alternative of requiring a DB migration + restart for what should be a
 * "click a button" first-run flow is worse. A real multi-instance
 * production deployment must move this into subscriptions_registry-style
 * persisted config (also already flagged as a next step).
 */

export interface PlatformConfig {
  clientId: string;
  clientSecret: string | null;
  graphConsentRedirectUri: string;
  deployToAzureRbacTemplateUrl: string;
}

let current: PlatformConfig = {
  clientId: process.env.ENTRA_APP_CLIENT_ID || "00000000-0000-0000-0000-000000000000",
  clientSecret: process.env.ENTRA_APP_CLIENT_SECRET || null,
  graphConsentRedirectUri:
    process.env.GRAPH_CONSENT_REDIRECT_URI ||
    `http://localhost:${process.env.PORT ?? 4000}/api/onboarding/graph-consent/callback`,
  deployToAzureRbacTemplateUrl:
    process.env.DEPLOY_TO_AZURE_RBAC_TEMPLATE_URL ||
    "https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Favd-manager%2Favd-manager%2Fmain%2Finfra%2Fbicep%2Frbac-delegation.json",
};

export function getPlatformConfig(): PlatformConfig {
  return current;
}

export function setPlatformAppRegistration(clientId: string, clientSecret: string): void {
  current = { ...current, clientId, clientSecret };
}

/** True once a real app registration (not the all-zeros placeholder) is
 * configured — lets the onboarding wizard tell the admin whether Setup
 * still needs to run. */
export function isPlatformConfigured(): boolean {
  return current.clientId !== "00000000-0000-0000-0000-000000000000";
}
