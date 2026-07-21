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
  return new OnboardingService(config.clientId, config.graphConsentRedirectUri, config.deployToAzureRbacTemplateUrl);
}

/** Tells the onboarding wizard whether Setup still needs to run, so it can
 * show/hide its embedded Setup step accordingly instead of the admin
 * having to know to visit a separate page first. */
onboardingRouter.get("/platform-status", (_req, res) => {
  res.json({ configured: isPlatformConfigured(), clientId: getPlatformConfig().clientId });
});

onboardingRouter.post("/tenants", async (req, res) => {
  const { displayName, entraTenantId } = req.body ?? {};
  if (!displayName || !entraTenantId) {
    return res.status(400).json({ error: "displayName and entraTenantId are required" });
  }
  const tenant = await getOnboardingService().createTenant({ displayName, entraTenantId });
  res.status(201).json(tenant);
});

onboardingRouter.get("/tenants/:tenantId/graph-consent-url", (req, res) => {
  res.json({ url: getOnboardingService().getAdminConsentUrl(req.params.tenantId) });
});

onboardingRouter.get("/tenants/:tenantId/deploy-to-azure-url", (req, res) => {
  const subscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
  res.json({ url: getOnboardingService().getDeployToAzureUrl(req.params.tenantId, subscriptionId) });
});

/** Callback the customer's browser (or our own redirect handler) hits after
 * admin consent completes. `state` carries the tenant id we set when
 * building the consent URL. In production this should validate the OAuth
 * response signature/anti-CSRF token, not just trust the query string. */
onboardingRouter.get("/graph-consent/callback", async (req, res) => {
  const tenantId = String(req.query.state ?? "");
  const subscriptionId = String(req.query.subscriptionId ?? "");
  const servicePrincipalId = String(req.query.servicePrincipalId ?? req.query.tenant ?? "");
  if (!tenantId || !subscriptionId || !servicePrincipalId) {
    return res.status(400).json({ error: "missing tenantId/subscriptionId/servicePrincipalId" });
  }
  await getOnboardingService().recordGraphConsentGranted(tenantId, subscriptionId, servicePrincipalId);
  res.json({ status: "recorded" });
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
