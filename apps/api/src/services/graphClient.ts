import type { FetchLike } from "./armHostPoolClient";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface EntraGroup {
  id: string;
  displayName: string;
  description: string | null;
}

export interface EntraUser {
  id: string;
  displayName: string;
  userPrincipalName: string;
}

/**
 * Thin real HTTP client over Microsoft Graph, used post-admin-consent to
 * sync Entra ID groups/users for AVD assignment. Interface + injectable
 * FetchLike so it's unit-testable without a live tenant.
 */
export interface IGraphClient {
  listGroups(): Promise<EntraGroup[]>;
  listGroupMembers(groupId: string): Promise<EntraUser[]>;
  getServicePrincipalByAppId(appId: string): Promise<{ id: string } | null>;
}

export class GraphClient implements IGraphClient {
  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  private async request(path: string) {
    const res = await this.fetchImpl(`${GRAPH_BASE}${path}`, {
      method: "GET",
      headers: await this.headers(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Graph request failed: GET ${path} -> ${res.status} ${JSON.stringify(body)}`);
    }
    return res.json();
  }

  async listGroups(): Promise<EntraGroup[]> {
    const data = await this.request("/groups?$select=id,displayName,description");
    return (data.value ?? []).map((g: any) => ({
      id: g.id,
      displayName: g.displayName,
      description: g.description ?? null,
    }));
  }

  async listGroupMembers(groupId: string): Promise<EntraUser[]> {
    const data = await this.request(`/groups/${groupId}/members?$select=id,displayName,userPrincipalName`);
    return (data.value ?? []).map((u: any) => ({
      id: u.id,
      displayName: u.displayName,
      userPrincipalName: u.userPrincipalName,
    }));
  }

  async getServicePrincipalByAppId(appId: string): Promise<{ id: string } | null> {
    const data = await this.request(`/servicePrincipals?$filter=appId eq '${appId}'&$select=id`);
    const items = data.value ?? [];
    return items.length > 0 ? { id: items[0].id } : null;
  }
}

/**
 * Builds the Graph admin-consent URL a customer's Global Admin visits to
 * grant our multi-tenant app the requested scopes in their tenant. This is
 * grant (a) in the two-grant onboarding model — see README. No RBAC/Azure
 * resource access is implied by this URL; that's the separate Bicep-based
 * grant (b).
 */
export function buildAdminConsentUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://login.microsoftonline.com/organizations/v2.0/adminconsent");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set(
    "scope",
    "https://graph.microsoft.com/User.Read.All https://graph.microsoft.com/Group.Read.All https://graph.microsoft.com/Directory.Read.All"
  );
  return url.toString();
}
