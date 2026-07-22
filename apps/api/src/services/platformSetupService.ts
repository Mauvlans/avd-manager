import type { FetchLike } from "./armHostPoolClient";

/**
 * Platform bootstrap: creates OUR multi-tenant Entra app registration via
 * device-code sign-in, mirroring the pattern used in the W365Import project's
 * "Run setup wizard" (see /mnt/ai-work/W365Import/README.md, "One-time setup").
 *
 * Why device code + a well-known Microsoft client ID: a brand-new app has no
 * credentials of its own to authenticate with yet, so we borrow a Microsoft
 * first-party client that's already pre-authorized for
 * Application.ReadWrite.All / AppRoleAssignment.ReadWrite.All against Graph
 * (Graph requires first-party-Microsoft-client-to-first-party-Graph token
 * requests to be explicitly pre-authorized — AADSTS65002 otherwise, and no
 * admin-consent click overrides that). Microsoft Graph PowerShell's client
 * (14d82eec-204b-4c2f-b7e8-296a70dab67e — same one Connect-MgGraph uses) is
 * documented as pre-authorized for exactly this.
 *
 * This never touches or stores the admin's password — device code flow only
 * ever hands us short-lived access/refresh tokens for the well-known client,
 * scoped to what that client itself is allowed to request.
 */

const WELL_KNOWN_GRAPH_POWERSHELL_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const DEVICE_CODE_SCOPES = [
  "https://graph.microsoft.com/Application.ReadWrite.All",
  "https://graph.microsoft.com/AppRoleAssignment.ReadWrite.All",
  "https://graph.microsoft.com/DelegatedPermissionGrant.ReadWrite.All",
].join(" ");

// Graph application-permission App IDs + role IDs our platform app needs
// (the same three scopes buildAdminConsentUrl already requests for customer
// tenants — see graphClient.ts). These are Microsoft's well-known, stable
// Graph resource App ID and role IDs, not something we invent.
const GRAPH_RESOURCE_APP_ID = "00000003-0000-0000-c000-000000000000"; // Microsoft Graph
const REQUIRED_APP_ROLES = [
  { id: "df021288-bdef-4463-88db-98f22de89214", value: "User.Read.All" },
  { id: "5b567255-7703-4780-807c-7be8301ae99b", value: "Group.Read.All" },
  { id: "7ab1d382-f21e-4acd-a863-ba3e13f7da61", value: "Directory.Read.All" },
];

export interface DeviceCodeSession {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
}

export type PollOutcome =
  | { status: "pending" }
  | { status: "authorized"; accessToken: string; refreshToken?: string }
  | { status: "expired" }
  | { status: "denied"; error: string };

export interface CreatedAppRegistration {
  appId: string;
  objectId: string;
  clientSecret: string;
  servicePrincipalId: string;
  adminConsentGranted: boolean;
}

export class PlatformSetupService {
  constructor(private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {}

  /** Step 1: start a device-code flow. The caller shows `verification_uri` +
   * `user_code` to the admin, who visits that URL and enters the code in
   * their own browser, signed in as themselves — we never see or handle
   * their password. */
  async startDeviceCode(): Promise<DeviceCodeSession> {
    const res = await this.fetchImpl(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: WELL_KNOWN_GRAPH_POWERSHELL_CLIENT_ID,
          scope: DEVICE_CODE_SCOPES,
        }).toString(),
      }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`devicecode request failed: ${res.status} ${JSON.stringify(body)}`);
    }
    return res.json();
  }

  /** Step 2: poll the token endpoint until the admin completes sign-in (or
   * the code expires/is denied). Callers should poll at `interval` seconds,
   * per the device-code spec, not tighter — a too-fast poll gets
   * throttled by AAD (authorization_pending vs slow_down errors are both
   * folded into "pending" here since the caller-side polling loop already
   * respects `interval`). */
  async pollDeviceCode(deviceCode: string): Promise<PollOutcome> {
    const res = await this.fetchImpl(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: WELL_KNOWN_GRAPH_POWERSHELL_CLIENT_ID,
          device_code: deviceCode,
        }).toString(),
      }
    );
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      return { status: "authorized", accessToken: body.access_token, refreshToken: body.refresh_token };
    }
    if (body.error === "authorization_pending" || body.error === "slow_down") {
      return { status: "pending" };
    }
    if (body.error === "expired_token") {
      return { status: "expired" };
    }
    return { status: "denied", error: body.error_description || body.error || "unknown error" };
  }

  /** Step 3: once authorized, create the platform's multi-tenant app
   * registration, its service principal, a client secret, and grant the
   * required Graph application-permission app roles + tenant-wide admin
   * consent — all via Graph calls authenticated with the admin's own
   * device-code-issued token (so Graph enforces the admin's real
   * privileges; we never elevate anything ourselves).
   *
   * `graphConsentRedirectUri` MUST be registered on the app at creation
   * time — an app with no registered Web redirect URI fails every
   * customer's actual admin-consent sign-in with AADSTS500113 ("No reply
   * address is registered for the application"), even though app
   * creation itself succeeds. This was missed in the first version of this
   * method (caught live against a real tenant, not by the mocked unit
   * tests — they never exercise a real AAD authorize/consent redirect). */
  async createPlatformAppRegistration(
    accessToken: string,
    displayName: string,
    graphConsentRedirectUri: string
  ): Promise<CreatedAppRegistration> {
    const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };

    // 1. App registration (multitenant), with the Web redirect URI our
    // onboarding flow's admin-consent callback uses registered up front.
    const appRes = await this.fetchImpl("https://graph.microsoft.com/v1.0/applications", {
      method: "POST",
      headers,
      body: JSON.stringify({
        displayName,
        signInAudience: "AzureADMultipleOrgs",
        web: {
          redirectUris: [graphConsentRedirectUri],
        },
        requiredResourceAccess: [
          {
            resourceAppId: GRAPH_RESOURCE_APP_ID,
            resourceAccess: REQUIRED_APP_ROLES.map((r) => ({ id: r.id, type: "Role" })),
          },
        ],
      }),
    });
    if (!appRes.ok) {
      throw new Error(`application create failed: ${appRes.status} ${JSON.stringify(await appRes.json().catch(() => ({})))}`);
    }
    const app = await appRes.json();

    // 2. Service principal for that app
    const spRes = await this.fetchImpl("https://graph.microsoft.com/v1.0/servicePrincipals", {
      method: "POST",
      headers,
      body: JSON.stringify({ appId: app.appId }),
    });
    if (!spRes.ok) {
      throw new Error(`servicePrincipal create failed: ${spRes.status} ${JSON.stringify(await spRes.json().catch(() => ({})))}`);
    }
    const sp = await spRes.json();

    // 3. Client secret
    const secretRes = await this.fetchImpl(`https://graph.microsoft.com/v1.0/applications/${app.id}/addPassword`, {
      method: "POST",
      headers,
      body: JSON.stringify({ passwordCredential: { displayName: "avd-manager-platform-setup" } }),
    });
    if (!secretRes.ok) {
      throw new Error(`addPassword failed: ${secretRes.status} ${JSON.stringify(await secretRes.json().catch(() => ({})))}`);
    }
    const secret = await secretRes.json();

    // 4. Tenant-wide admin consent: grant each required app role assignment
    // directly to our service principal, resourced against Microsoft
    // Graph's *own* service principal in this tenant (not ours) — that's
    // what "this app can call Graph with these application permissions"
    // actually means. Equivalent effect to clicking "Grant admin consent"
    // in the portal for application permissions.
    const graphSpRes = await this.fetchImpl(
      `https://graph.microsoft.com/v1.0/servicePrincipals?$filter=appId eq '${GRAPH_RESOURCE_APP_ID}'&$select=id`,
      { headers }
    );
    if (!graphSpRes.ok) {
      throw new Error(
        `lookup of Microsoft Graph service principal failed: ${graphSpRes.status} ${JSON.stringify(
          await graphSpRes.json().catch(() => ({}))
        )}`
      );
    }
    const graphSpBody = await graphSpRes.json();
    const graphResourceSpId = graphSpBody.value?.[0]?.id;
    if (!graphResourceSpId) {
      throw new Error("Could not resolve Microsoft Graph's service principal id in this tenant");
    }

    let adminConsentGranted = true;
    for (const role of REQUIRED_APP_ROLES) {
      const grantRes = await this.fetchImpl(
        `https://graph.microsoft.com/v1.0/servicePrincipals/${sp.id}/appRoleAssignedTo`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            principalId: sp.id,
            resourceId: graphResourceSpId,
            appRoleId: role.id,
          }),
        }
      );
      if (!grantRes.ok) adminConsentGranted = false;
    }

    return {
      appId: app.appId,
      objectId: app.id,
      clientSecret: secret.secretText,
      servicePrincipalId: sp.id,
      adminConsentGranted,
    };
  }
}
