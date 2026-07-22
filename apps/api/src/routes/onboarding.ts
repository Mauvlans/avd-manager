import { Router } from "express";
import { OnboardingService } from "../services/onboardingService";
import { getPlatformConfig, isPlatformConfigured } from "../services/platformConfigStore";

export const onboardingRouter = Router();

/** Builds a fresh OnboardingService per request using the *current*
 * platform config, instead of freezing config at module-load time — this
 * is what lets Setup's device-code flow take effect immediately, with no
 * API restart, once it writes a real client id/secret into
 * platformConfigStore. */
function getOnboardingService(): OnboardingService {
  const config = getPlatformConfig();
  return new OnboardingService(
    config.clientId,
    config.graphConsentRedirectUri,
    config.deployToAzureRbacTemplateUrl,
    config.clientSecret
  );
}

/** Tells the onboarding wizard whether Setup still needs to run, so it can
 * show/hide its embedded Setup step accordingly instead of the admin
 * having to know to visit a separate page first. */
onboardingRouter.get("/platform-status", (_req, res) => {
  res.json({ configured: isPlatformConfigured(), clientId: getPlatformConfig().clientId });
});

/** Step 1 of the wizard: get a fresh Graph admin-consent link. `nonce` is a
 * client-generated correlation value (not a tenant id — we don't know the
 * customer's tenant yet, that's what consent discovers). No tenant record
 * is created here; it's auto-created from Microsoft's own consent
 * callback below, which is the point of this design — see
 * onboardingService.ts docstring. */
onboardingRouter.get("/graph-consent-url", (req, res) => {
  const nonce = typeof req.query.nonce === "string" ? req.query.nonce : Math.random().toString(36).slice(2);
  res.json({ url: getOnboardingService().getAdminConsentUrl(nonce), nonce });
});

onboardingRouter.get("/tenants/:tenantId/deploy-to-azure-url", async (req, res) => {
  const subscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
  const url = await getOnboardingService().getDeployToAzureUrl(req.params.tenantId, subscriptionId);
  res.json({ url });
});

/** Callback the customer's browser hits after admin consent completes.
 * Microsoft's own redirect includes `tenant` (the real Entra tenant GUID)
 * and, once resolvable, the resulting service principal id. This call
 * auto-creates (or reuses) the tenant row — the wizard never asked the
 * admin to type in a tenant GUID or display name manually; Microsoft's
 * redirect is the source of truth for both.
 *
 * Since the admin-consent link opens in a new browser tab/window (the
 * wizard uses target="_blank" so the original wizard tab stays open),
 * this redirects that tab back to the web app's onboarding page with the
 * resulting tenantId in the query string, instead of returning bare JSON
 * — the onboarding page picks that up on mount and persists it via
 * useTenantId, continuing the wizard with no manual "create tenant" step
 * and no manual tenant-id copy/paste between tabs. */
onboardingRouter.get("/graph-consent/callback", async (req, res) => {
  const entraTenantId = String(req.query.tenant ?? "");
  const displayNameHint = typeof req.query.displayName === "string" ? req.query.displayName : undefined;
  const webAppBaseUrl = process.env.WEB_APP_BASE_URL || "http://10.0.0.27:3000";
  if (!entraTenantId) {
    return res
      .status(400)
      .redirect(`${webAppBaseUrl}/onboarding?consentError=${encodeURIComponent("missing tenant from consent redirect")}`);
  }
  const { tenantId } = await getOnboardingService().recordGraphConsentGranted(entraTenantId, displayNameHint);
  res.redirect(`${webAppBaseUrl}/onboarding?tenantId=${tenantId}&consentDone=1`);
});

/** Status-poll endpoint for the onboarding wizard: returns the tenant's
 * subscriptions_registry row(s) — graph_consent_status/granted-at,
 * rbac_grant_status/last-verified/drift-details, subscription id(s), and
 * resource groups in scope. Lets the frontend poll for grant completion
 * instead of requiring the admin to manually check the audit log. */
onboardingRouter.get("/tenants/:tenantId/registry", async (req, res) => {
  const rows = await getOnboardingService().listRegistryRows(req.params.tenantId);
  res.json(rows);
});

/** Callback invoked by the Deploy-to-Azure template's deployment script (or
 * manually by an admin confirming the deployment) once the RBAC role +
 * assignment exist in the customer's subscription. */
onboardingRouter.post("/rbac-grant/callback", async (req, res) => {
  const { tenantId, subscriptionId, roleDefinitionId, resourceGroups } = req.body ?? {};
  if (!tenantId || !subscriptionId || !roleDefinitionId || !Array.isArray(resourceGroups)) {
    return res.status(400).json({ error: "missing required fields" });
  }
  await getOnboardingService().recordRbacGranted(tenantId, subscriptionId, roleDefinitionId, resourceGroups);
  res.json({ status: "recorded" });
});
