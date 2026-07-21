import { Router } from "express";
import { OnboardingService } from "../services/onboardingService";

const onboardingService = new OnboardingService(
  process.env.ENTRA_APP_CLIENT_ID || "00000000-0000-0000-0000-000000000000",
  process.env.GRAPH_CONSENT_REDIRECT_URI || "http://localhost:4000/api/onboarding/graph-consent/callback",
  process.env.DEPLOY_TO_AZURE_RBAC_TEMPLATE_URL ||
    "https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Favd-manager%2Favd-manager%2Fmain%2Finfra%2Fbicep%2Frbac-delegation.json"
);

export const onboardingRouter = Router();

onboardingRouter.post("/tenants", async (req, res) => {
  const { displayName, entraTenantId } = req.body ?? {};
  if (!displayName || !entraTenantId) {
    return res.status(400).json({ error: "displayName and entraTenantId are required" });
  }
  const tenant = await onboardingService.createTenant({ displayName, entraTenantId });
  res.status(201).json(tenant);
});

onboardingRouter.get("/tenants/:tenantId/graph-consent-url", (req, res) => {
  res.json({ url: onboardingService.getAdminConsentUrl(req.params.tenantId) });
});

onboardingRouter.get("/tenants/:tenantId/deploy-to-azure-url", (req, res) => {
  const subscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
  res.json({ url: onboardingService.getDeployToAzureUrl(req.params.tenantId, subscriptionId) });
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
  await onboardingService.recordGraphConsentGranted(tenantId, subscriptionId, servicePrincipalId);
  res.json({ status: "recorded" });
});

/** Callback invoked by the Deploy-to-Azure template's deployment script (or
 * manually by an admin confirming the deployment) once the RBAC role +
 * assignment exist in the customer's subscription. */
onboardingRouter.post("/rbac-grant/callback", async (req, res) => {
  const { tenantId, subscriptionId, roleDefinitionId, resourceGroups } = req.body ?? {};
  if (!tenantId || !subscriptionId || !roleDefinitionId || !Array.isArray(resourceGroups)) {
    return res.status(400).json({ error: "missing required fields" });
  }
  await onboardingService.recordRbacGranted(tenantId, subscriptionId, roleDefinitionId, resourceGroups);
  res.json({ status: "recorded" });
});
