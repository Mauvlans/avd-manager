import type { FetchLike, TokenProvider, ArmLroResult } from "./armHostPoolClient";

/**
 * Thin, real HTTP client over the Microsoft.DesktopVirtualization
 * `workspaces` ARM REST API, added for the Host Pools L2 tab experience
 * (Host Pools / Application Groups / Workspaces) per Adam's mock. Mirrors
 * ArmHostPoolClient/ArmScalingPlanClient/ArmApplicationGroupClient's
 * FetchLike/TokenProvider/ArmLroResult/LRO-polling conventions exactly.
 *
 * Real ARM shape: a workspace's `applicationGroupReferences` property is
 * an array of application-group ARM resource ids it publishes — there is
 * no separate "attach"/"detach" verb, same read-modify-write pattern
 * armScalingPlanClient.ts uses for hostPoolReferences.
 */

export interface Workspace {
  id: string;
  name: string;
  location: string;
  friendlyName?: string;
  description?: string;
  applicationGroupReferences: string[];
}

export interface CreateOrUpdateWorkspaceParams {
  location: string;
  friendlyName?: string;
  description?: string;
  applicationGroupReferences: string[];
}

export interface IArmWorkspaceClient {
  listWorkspaces(subscriptionId: string, resourceGroup: string): Promise<Workspace[]>;
  getWorkspace(subscriptionId: string, resourceGroup: string, name: string): Promise<Workspace | null>;
  createOrUpdateWorkspace(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    params: CreateOrUpdateWorkspaceParams,
    opts?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<ArmLroResult<Workspace>>;
  deleteWorkspace(subscriptionId: string, resourceGroup: string, name: string): Promise<void>;
  attachApplicationGroup(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    applicationGroupArmPath: string
  ): Promise<ArmLroResult<Workspace>>;
  detachApplicationGroup(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    applicationGroupArmPath: string
  ): Promise<ArmLroResult<Workspace>>;
}

const ARM_API_VERSION = "2023-09-05";
const ARM_BASE = "https://management.azure.com";

export class ArmWorkspaceClient implements IArmWorkspaceClient {
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

  private workspaceUrl(subscriptionId: string, resourceGroup: string, name?: string): string {
    const base = `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/workspaces`;
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

  private mapArmWorkspace(armObj: any): Workspace {
    const props = armObj.properties ?? {};
    return {
      id: armObj.id,
      name: armObj.name,
      location: armObj.location,
      friendlyName: props.friendlyName,
      description: props.description,
      applicationGroupReferences: props.applicationGroupReferences ?? [],
    };
  }

  async listWorkspaces(subscriptionId: string, resourceGroup: string): Promise<Workspace[]> {
    const data = await this.request(this.workspaceUrl(subscriptionId, resourceGroup), "GET");
    return (data.value ?? []).map((v: any) => this.mapArmWorkspace(v));
  }

  async getWorkspace(subscriptionId: string, resourceGroup: string, name: string): Promise<Workspace | null> {
    try {
      const data = await this.request(this.workspaceUrl(subscriptionId, resourceGroup, name), "GET");
      return this.mapArmWorkspace(data);
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) return null;
      throw err;
    }
  }

  async createOrUpdateWorkspace(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    params: CreateOrUpdateWorkspaceParams,
    opts?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<ArmLroResult<Workspace>> {
    const body = {
      location: params.location,
      properties: {
        friendlyName: params.friendlyName,
        description: params.description,
        applicationGroupReferences: params.applicationGroupReferences,
      },
    };
    const url = this.workspaceUrl(subscriptionId, resourceGroup, name);
    const { data, status, headers } = await this.requestWithHeaders(url, "PUT", body);

    if (status === 200 || status === 201) {
      return { outcome: "succeeded", data: this.mapArmWorkspace(data) };
    }

    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const pollIntervalMs = opts?.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    const asyncOpUrl = headers?.get?.("Azure-AsyncOperation") ?? headers?.get?.("azure-asyncoperation");
    if (asyncOpUrl) {
      const result = await this.pollAsyncOperation(asyncOpUrl, deadline, pollIntervalMs);
      if (result.outcome !== "succeeded") return result;
    } else {
      const pollResult = await this.pollWorkspaceExists(subscriptionId, resourceGroup, name, deadline, pollIntervalMs);
      if (pollResult.outcome !== "succeeded") return pollResult;
    }

    const finalData = await this.request(this.workspaceUrl(subscriptionId, resourceGroup, name), "GET");
    return { outcome: "succeeded", data: this.mapArmWorkspace(finalData) };
  }

  private async pollWorkspaceExists(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    deadline: number,
    pollIntervalMs: number
  ): Promise<ArmLroResult<void>> {
    const headers = await this.authHeaders();
    const url = this.workspaceUrl(subscriptionId, resourceGroup, name);
    while (Date.now() < deadline) {
      const res = await this.fetchImpl(url, { method: "GET", headers });
      if (res.ok) return { outcome: "succeeded" } as ArmLroResult<void>;
      if (res.status !== 404) {
        const errBody = await res.json().catch(() => ({}));
        return { outcome: "failed", reason: `poll request failed: ${res.status} ${JSON.stringify(errBody)}` };
      }
      await this.sleep(pollIntervalMs);
    }
    return { outcome: "timeout", reason: "workspace did not become visible within the polling deadline" };
  }

  async deleteWorkspace(subscriptionId: string, resourceGroup: string, name: string): Promise<void> {
    await this.request(this.workspaceUrl(subscriptionId, resourceGroup, name), "DELETE");
  }

  /**
   * No dedicated attach/detach ARM verb — same read-modify-write pattern
   * as armScalingPlanClient.ts's hostPoolReferences handling.
   */
  async attachApplicationGroup(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    applicationGroupArmPath: string
  ): Promise<ArmLroResult<Workspace>> {
    const ws = await this.getWorkspace(subscriptionId, resourceGroup, name);
    if (!ws) return { outcome: "failed", reason: `workspace ${name} not found` };
    const refs = ws.applicationGroupReferences.filter((r) => r !== applicationGroupArmPath);
    refs.push(applicationGroupArmPath);
    return this.createOrUpdateWorkspace(subscriptionId, resourceGroup, name, {
      location: ws.location,
      friendlyName: ws.friendlyName,
      description: ws.description,
      applicationGroupReferences: refs,
    });
  }

  async detachApplicationGroup(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    applicationGroupArmPath: string
  ): Promise<ArmLroResult<Workspace>> {
    const ws = await this.getWorkspace(subscriptionId, resourceGroup, name);
    if (!ws) return { outcome: "failed", reason: `workspace ${name} not found` };
    const refs = ws.applicationGroupReferences.filter((r) => r !== applicationGroupArmPath);
    return this.createOrUpdateWorkspace(subscriptionId, resourceGroup, name, {
      location: ws.location,
      friendlyName: ws.friendlyName,
      description: ws.description,
      applicationGroupReferences: refs,
    });
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
