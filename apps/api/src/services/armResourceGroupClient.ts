import type { FetchLike, TokenProvider } from "./armHostPoolClient";

/**
 * Real ARM REST client over Microsoft.Resources' resourceGroups list API
 * (NOT Microsoft.DesktopVirtualization — resource groups are a core Azure
 * Resource Manager concept, not an AVD-specific one). Used to populate
 * Settings > Monitored Resource Groups' picker with the actual resource
 * groups that exist in a granted subscription, per Adam's request, rather
 * than free-text entry.
 */
const ARM_BASE = "https://management.azure.com";
const RESOURCE_GROUPS_API_VERSION = "2021-04-01";

export interface ResourceGroupSummary {
  name: string;
  location: string;
}

export class ArmResourceGroupClient {
  constructor(
    private readonly entraTenantId: string,
    private readonly tokenProvider: TokenProvider,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  async listResourceGroups(subscriptionId: string): Promise<ResourceGroupSummary[]> {
    const token = await this.tokenProvider.getArmToken(this.entraTenantId);
    const url = `${ARM_BASE}/subscriptions/${subscriptionId}/resourcegroups?api-version=${RESOURCE_GROUPS_API_VERSION}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(`ARM request failed: GET ${url} -> ${res.status} ${JSON.stringify(errBody)}`);
    }
    const data = await res.json();
    return (data.value ?? []).map((v: any) => ({ name: v.name, location: v.location }));
  }
}
