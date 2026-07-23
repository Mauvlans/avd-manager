import type { FetchLike, TokenProvider, ArmLroResult } from "./armHostPoolClient";

/**
 * Thin, real HTTP client over the Microsoft.DesktopVirtualization
 * `applicationGroups` ARM REST API, added for the Host Pools L2 tab
 * experience (Host Pools / Application Groups / Workspaces) per Adam's
 * mock. Mirrors ArmHostPoolClient/ArmScalingPlanClient's FetchLike/
 * TokenProvider/ArmLroResult/LRO-polling conventions exactly — one ARM
 * calling convention in this codebase, not three slightly different ones.
 *
 * Real ARM shape: an application group is always scoped to exactly one
 * host pool (`hostPoolArmPath` in properties, set at create time and
 * effectively immutable — ARM rejects changing it on an existing group),
 * and has an `applicationGroupType` of "Desktop" (whole-desktop) or
 * "RemoteApplication" (RemoteApp publishing) which must be compatible
 * with the host pool's own `preferredAppGroupType`.
 */

export type ApplicationGroupType = "Desktop" | "RemoteApp";

export interface ApplicationGroup {
  id: string;
  name: string;
  location: string;
  friendlyName?: string;
  description?: string;
  hostPoolArmPath: string;
  applicationGroupType: ApplicationGroupType;
  workspaceArmPath?: string | null;
}

export interface CreateOrUpdateApplicationGroupParams {
  location: string;
  friendlyName?: string;
  description?: string;
  hostPoolArmPath: string;
  applicationGroupType: ApplicationGroupType;
}

export interface IArmApplicationGroupClient {
  listApplicationGroups(subscriptionId: string, resourceGroup: string): Promise<ApplicationGroup[]>;
  getApplicationGroup(subscriptionId: string, resourceGroup: string, name: string): Promise<ApplicationGroup | null>;
  createOrUpdateApplicationGroup(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    params: CreateOrUpdateApplicationGroupParams,
    opts?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<ArmLroResult<ApplicationGroup>>;
  deleteApplicationGroup(subscriptionId: string, resourceGroup: string, name: string): Promise<void>;
}

// Same stable Microsoft.DesktopVirtualization API version the rest of this
// codebase's ARM clients use (armHostPoolClient.ts, armScalingPlanClient.ts)
// — applicationGroups lives under the same resource provider.
const ARM_API_VERSION = "2023-09-05";
const ARM_BASE = "https://management.azure.com";

export class ArmApplicationGroupClient implements IArmApplicationGroupClient {
  constructor(
    private readonly entraTenantId: string,
    private readonly tokenProvider: TokenProvider,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.tokenProvider.getArmToken(this.entraTenantId);
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  private appGroupUrl(subscriptionId: string, resourceGroup: string, name?: string): string {
    const base = `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/applicationGroups`;
    return name ? `${base}/${name}?api-version=${ARM_API_VERSION}` : `${base}?api-version=${ARM_API_VERSION}`;
  }

  private async request(url: string, method: string, body?: unknown) {
    const { data } = await this.requestWithHeaders(url, method, body);
    return data;
  }

  private async requestWithHeaders(
    url: string,
    method: string,
    body?: unknown
  ): Promise<{ data: any; status: number; headers?: { get(name: string): string | null } }> {
    const headers = await this.authHeaders();
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && res.status !== 202) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(`ARM request failed: ${method} ${url} -> ${res.status} ${JSON.stringify(errBody)}`);
    }
    const data = await res.json().catch(() => ({}));
    return { data, status: res.status, headers: res.headers };
  }

  private mapArmApplicationGroup(armObj: any): ApplicationGroup {
    const props = armObj.properties ?? {};
    return {
      id: armObj.id,
      name: armObj.name,
      location: armObj.location,
      friendlyName: props.friendlyName,
      description: props.description,
      hostPoolArmPath: props.hostPoolArmPath,
      applicationGroupType: props.applicationGroupType === "RemoteApp" ? "RemoteApp" : "Desktop",
      workspaceArmPath: props.workspaceArmPath ?? null,
    };
  }

  async listApplicationGroups(subscriptionId: string, resourceGroup: string): Promise<ApplicationGroup[]> {
    const data = await this.request(this.appGroupUrl(subscriptionId, resourceGroup), "GET");
    return (data.value ?? []).map((v: any) => this.mapArmApplicationGroup(v));
  }

  async getApplicationGroup(subscriptionId: string, resourceGroup: string, name: string): Promise<ApplicationGroup | null> {
    try {
      const data = await this.request(this.appGroupUrl(subscriptionId, resourceGroup, name), "GET");
      return this.mapArmApplicationGroup(data);
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) return null;
      throw err;
    }
  }

  async createOrUpdateApplicationGroup(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    params: CreateOrUpdateApplicationGroupParams,
    opts?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<ArmLroResult<ApplicationGroup>> {
    const body = {
      location: params.location,
      properties: {
        friendlyName: params.friendlyName,
        description: params.description,
        hostPoolArmPath: params.hostPoolArmPath,
        applicationGroupType: params.applicationGroupType,
      },
    };
    const url = this.appGroupUrl(subscriptionId, resourceGroup, name);
    const { data, status, headers } = await this.requestWithHeaders(url, "PUT", body);

    if (status === 200 || status === 201) {
      return { outcome: "succeeded", data: this.mapArmApplicationGroup(data) };
    }

    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const pollIntervalMs = opts?.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    const asyncOpUrl = headers?.get?.("Azure-AsyncOperation") ?? headers?.get?.("azure-asyncoperation");
    if (asyncOpUrl) {
      const result = await this.pollAsyncOperation(asyncOpUrl, deadline, pollIntervalMs);
      if (result.outcome !== "succeeded") return result;
    } else {
      const pollResult = await this.pollApplicationGroupExists(subscriptionId, resourceGroup, name, deadline, pollIntervalMs);
      if (pollResult.outcome !== "succeeded") return pollResult;
    }

    const finalData = await this.request(this.appGroupUrl(subscriptionId, resourceGroup, name), "GET");
    return { outcome: "succeeded", data: this.mapArmApplicationGroup(finalData) };
  }

  private async pollApplicationGroupExists(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    deadline: number,
    pollIntervalMs: number
  ): Promise<ArmLroResult<void>> {
    const headers = await this.authHeaders();
    const url = this.appGroupUrl(subscriptionId, resourceGroup, name);
    while (Date.now() < deadline) {
      const res = await this.fetchImpl(url, { method: "GET", headers });
      if (res.ok) return { outcome: "succeeded" } as ArmLroResult<void>;
      if (res.status !== 404) {
        const errBody = await res.json().catch(() => ({}));
        return { outcome: "failed", reason: `poll request failed: ${res.status} ${JSON.stringify(errBody)}` };
      }
      await this.sleep(pollIntervalMs);
    }
    return { outcome: "timeout", reason: "application group did not become visible within the polling deadline" };
  }

  async deleteApplicationGroup(subscriptionId: string, resourceGroup: string, name: string): Promise<void> {
    await this.request(this.appGroupUrl(subscriptionId, resourceGroup, name), "DELETE");
  }

  private async pollAsyncOperation(
    url: string,
    deadline: number,
    pollIntervalMs: number
  ): Promise<ArmLroResult<void>> {
    const headers = await this.authHeaders();
    while (Date.now() < deadline) {
      const res = await this.fetchImpl(url, { method: "GET", headers });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        return { outcome: "failed", reason: `poll request failed: ${res.status} ${JSON.stringify(errBody)}` };
      }
      const data = await res.json();
      const status: string | undefined = data.status;
      if (status === "Succeeded") return { outcome: "succeeded" } as ArmLroResult<void>;
      if (status === "Failed" || status === "Canceled") {
        return { outcome: "failed", reason: data.error ? JSON.stringify(data.error) : `operation status=${status}` };
      }
      await this.sleep(pollIntervalMs);
    }
    return { outcome: "timeout", reason: "did not reach a terminal state within the polling deadline" };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
