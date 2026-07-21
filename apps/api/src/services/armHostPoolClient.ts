import type { HostPool, HostPoolType, LoadBalancerType, SessionHost } from "@avd-manager/shared";

/**
 * Minimal fetch-like signature so we can inject a mock in unit tests without
 * pulling in a full HTTP mocking library. Node 18+/20 has global fetch.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; headers?: { get(name: string): string | null } }>;

export interface TokenProvider {
  /** Returns an app-only ARM bearer token for the given tenant, acquired via
   * the tenant's granted RBAC role (client credentials flow against our
   * multi-tenant app registration, scoped to https://management.azure.com/.default). */
  getArmToken(entraTenantId: string): Promise<string>;
}

/**
 * Thin, real HTTP client over the Microsoft.DesktopVirtualization ARM REST
 * API. Structured behind an interface (IArmHostPoolClient) + this concrete
 * implementation (ArmHostPoolClient) so it is unit-testable with a mock
 * FetchLike, since this sandbox has no live Azure credentials to test
 * against a real subscription.
 */
export interface IArmHostPoolClient {
  listHostPools(subscriptionId: string, resourceGroup: string): Promise<HostPool[]>;
  getHostPool(subscriptionId: string, resourceGroup: string, name: string): Promise<HostPool | null>;
  createOrUpdateHostPool(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    params: {
      location: string;
      hostPoolType: HostPoolType;
      loadBalancerType: LoadBalancerType;
      maxSessionLimit: number;
    }
  ): Promise<HostPool>;
  deleteHostPool(subscriptionId: string, resourceGroup: string, name: string): Promise<void>;
  listSessionHosts(subscriptionId: string, resourceGroup: string, hostPoolName: string): Promise<SessionHost[]>;
  updateSessionHost(
    subscriptionId: string,
    resourceGroup: string,
    hostPoolName: string,
    sessionHostName: string,
    params: { allowNewSession: boolean }
  ): Promise<void>;
  deleteSessionHost(
    subscriptionId: string,
    resourceGroup: string,
    hostPoolName: string,
    sessionHostName: string
  ): Promise<void>;
  /** Starts the underlying VM for a session host via the Microsoft.Compute
   * `start` action. This is a DIFFERENT resource provider than
   * DesktopVirtualization — AVD session hosts are backed by a regular Azure
   * VM resource, and "starting a host" for autoscale scale-out purposes
   * means calling Compute's start action on that VM, not anything under
   * Microsoft.DesktopVirtualization. `vmName` is the underlying VM resource
   * name, which by AVD convention is usually (but not guaranteed to be)
   * the same as the session host name's prefix before the FQDN suffix —
   * callers should resolve this from the session host's `resourceId`
   * rather than assuming string equality; see resolveVmNameFromResourceId.
   *
   * Polls the ARM Azure-AsyncOperation (falling back to polling the VM's
   * provisioningState directly if no operation URL is returned) until the
   * operation reaches a terminal state or `timeoutMs` elapses, and returns
   * the real outcome rather than assuming success on 202 Accepted. */
  startVm(
    subscriptionId: string,
    resourceGroup: string,
    vmName: string,
    opts?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<VmStartResult>;
}

export type VmStartResult =
  | { outcome: "succeeded" }
  | { outcome: "failed"; reason: string }
  | { outcome: "timeout"; reason: string };

const ARM_API_VERSION = "2023-09-05"; // Microsoft.DesktopVirtualization stable API version
const COMPUTE_API_VERSION = "2024-07-01"; // Microsoft.Compute stable API version
const ARM_BASE = "https://management.azure.com";

/**
 * Given the full ARM resourceId of a session host's underlying VM (as
 * returned in SessionHost.resourceId), extracts the VM resource name.
 * Exported standalone (not just a private method) so it's independently
 * unit-testable without needing a full ArmHostPoolClient instance.
 */
export function resolveVmNameFromResourceId(resourceId: string): string {
  const parts = resourceId.split("/").filter(Boolean);
  const idx = parts.findIndex((p) => p.toLowerCase() === "virtualmachines");
  if (idx === -1 || !parts[idx + 1]) {
    throw new Error(`could not resolve VM name from resourceId: ${resourceId}`);
  }
  return parts[idx + 1];
}

export class ArmHostPoolClient implements IArmHostPoolClient {
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

  private hostPoolUrl(subscriptionId: string, resourceGroup: string, name?: string): string {
    const base = `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools`;
    return name ? `${base}/${name}?api-version=${ARM_API_VERSION}` : `${base}?api-version=${ARM_API_VERSION}`;
  }

  private sessionHostUrl(
    subscriptionId: string,
    resourceGroup: string,
    hostPoolName: string,
    sessionHostName?: string
  ): string {
    const base = `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/hostPools/${hostPoolName}/sessionHosts`;
    return sessionHostName
      ? `${base}/${sessionHostName}?api-version=${ARM_API_VERSION}`
      : `${base}?api-version=${ARM_API_VERSION}`;
  }

  private async request(url: string, method: string, body?: unknown) {
    const headers = await this.authHeaders();
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(`ARM request failed: ${method} ${url} -> ${res.status} ${JSON.stringify(errBody)}`);
    }
    return res.json();
  }

  private mapArmHostPool(subscriptionId: string, resourceGroup: string, armObj: any, tenantId = ""): HostPool {
    return {
      id: armObj.id,
      tenantId,
      subscriptionId,
      resourceGroup,
      name: armObj.name,
      location: armObj.location,
      hostPoolType: armObj.properties?.hostPoolType,
      loadBalancerType: armObj.properties?.loadBalancerType,
      maxSessionLimit: armObj.properties?.maxSessionLimit ?? 0,
      sessionHostCount: 0,
      createdAt: armObj.systemData?.createdAt ?? new Date().toISOString(),
      updatedAt: armObj.systemData?.lastModifiedAt ?? new Date().toISOString(),
    };
  }

  async listHostPools(subscriptionId: string, resourceGroup: string): Promise<HostPool[]> {
    const data = await this.request(this.hostPoolUrl(subscriptionId, resourceGroup), "GET");
    return (data.value ?? []).map((v: any) => this.mapArmHostPool(subscriptionId, resourceGroup, v));
  }

  async getHostPool(subscriptionId: string, resourceGroup: string, name: string): Promise<HostPool | null> {
    try {
      const data = await this.request(this.hostPoolUrl(subscriptionId, resourceGroup, name), "GET");
      return this.mapArmHostPool(subscriptionId, resourceGroup, data);
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) return null;
      throw err;
    }
  }

  async createOrUpdateHostPool(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    params: {
      location: string;
      hostPoolType: HostPoolType;
      loadBalancerType: LoadBalancerType;
      maxSessionLimit: number;
    }
  ): Promise<HostPool> {
    const body = {
      location: params.location,
      properties: {
        hostPoolType: params.hostPoolType,
        loadBalancerType: params.loadBalancerType,
        maxSessionLimit: params.maxSessionLimit,
        preferredAppGroupType: "Desktop",
      },
    };
    const data = await this.request(this.hostPoolUrl(subscriptionId, resourceGroup, name), "PUT", body);
    return this.mapArmHostPool(subscriptionId, resourceGroup, data);
  }

  async deleteHostPool(subscriptionId: string, resourceGroup: string, name: string): Promise<void> {
    await this.request(this.hostPoolUrl(subscriptionId, resourceGroup, name), "DELETE");
  }

  async listSessionHosts(
    subscriptionId: string,
    resourceGroup: string,
    hostPoolName: string
  ): Promise<SessionHost[]> {
    const data = await this.request(this.sessionHostUrl(subscriptionId, resourceGroup, hostPoolName), "GET");
    return (data.value ?? []).map((v: any) => ({
      name: v.name,
      hostPoolId: hostPoolName,
      resourceId: v.properties?.resourceId ?? "",
      status: v.properties?.status ?? "Unknown",
      sessions: v.properties?.sessions ?? 0,
      allowNewSession: v.properties?.allowNewSession ?? true,
      vmSize: v.properties?.virtualMachineSize ?? "",
      lastHeartBeat: v.properties?.lastHeartBeat ?? null,
    }));
  }

  async updateSessionHost(
    subscriptionId: string,
    resourceGroup: string,
    hostPoolName: string,
    sessionHostName: string,
    params: { allowNewSession: boolean }
  ): Promise<void> {
    await this.request(
      this.sessionHostUrl(subscriptionId, resourceGroup, hostPoolName, sessionHostName),
      "PATCH",
      { properties: { allowNewSession: params.allowNewSession } }
    );
  }

  async deleteSessionHost(
    subscriptionId: string,
    resourceGroup: string,
    hostPoolName: string,
    sessionHostName: string
  ): Promise<void> {
    await this.request(
      this.sessionHostUrl(subscriptionId, resourceGroup, hostPoolName, sessionHostName),
      "DELETE"
    );
  }

  private computeVmStartUrl(subscriptionId: string, resourceGroup: string, vmName: string): string {
    return `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}/start?api-version=${COMPUTE_API_VERSION}`;
  }

  private computeVmInstanceViewUrl(subscriptionId: string, resourceGroup: string, vmName: string): string {
    return `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}?api-version=${COMPUTE_API_VERSION}&$expand=instanceView`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Polls a given URL (either the Azure-AsyncOperation URL returned by the
   * start call, or the VM resource itself as a provisioningState fallback)
   * until it reports a terminal status or the deadline passes. */
  private async pollUntilTerminal(
    url: string,
    isAsyncOperationUrl: boolean,
    deadline: number,
    pollIntervalMs: number
  ): Promise<VmStartResult> {
    const headers = await this.authHeaders();
    while (Date.now() < deadline) {
      const res = await this.fetchImpl(url, { method: "GET", headers });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        return { outcome: "failed", reason: `poll request failed: ${res.status} ${JSON.stringify(errBody)}` };
      }
      const data = await res.json();
      const status: string | undefined = isAsyncOperationUrl
        ? data.status
        : data.properties?.provisioningState;

      if (isAsyncOperationUrl) {
        if (status === "Succeeded") return { outcome: "succeeded" };
        if (status === "Failed" || status === "Canceled") {
          return {
            outcome: "failed",
            reason: data.error ? JSON.stringify(data.error) : `operation status=${status}`,
          };
        }
        // status is "Running"/"InProgress"/"NotStarted" — keep polling.
      } else {
        // provisioningState fallback: "Succeeded" for the VM resource means
        // the last operation (our start call) completed; "Failed" is a
        // terminal failure. Anything else ("Updating", etc.) keeps polling.
        if (status === "Succeeded") return { outcome: "succeeded" };
        if (status === "Failed") {
          return { outcome: "failed", reason: `VM provisioningState=Failed` };
        }
      }

      await this.sleep(pollIntervalMs);
    }
    return { outcome: "timeout", reason: `did not reach a terminal state within the polling deadline` };
  }

  async startVm(
    subscriptionId: string,
    resourceGroup: string,
    vmName: string,
    opts?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<VmStartResult> {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const pollIntervalMs = opts?.pollIntervalMs ?? 5_000;
    const headers = await this.authHeaders();
    const startUrl = this.computeVmStartUrl(subscriptionId, resourceGroup, vmName);
    const res = await this.fetchImpl(startUrl, { method: "POST", headers });

    // Compute's async start action returns 200 (already running, nothing to
    // poll — treat as immediate success) or 202 (Accepted, operation in
    // progress — must poll to confirm real outcome). Anything else is a
    // request-level failure.
    if (!res.ok && res.status !== 202) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(`ARM request failed: POST ${startUrl} -> ${res.status} ${JSON.stringify(errBody)}`);
    }
    if (res.status === 200) {
      return { outcome: "succeeded" };
    }

    // 202 Accepted: poll for the real outcome instead of assuming success.
    const asyncOpUrl = res.headers?.get?.("Azure-AsyncOperation") ?? res.headers?.get?.("azure-asyncoperation");
    const deadline = Date.now() + timeoutMs;
    if (asyncOpUrl) {
      return this.pollUntilTerminal(asyncOpUrl, true, deadline, pollIntervalMs);
    }
    // No Azure-AsyncOperation header available (e.g. mocked fetch, or ARM
    // omitted it) — fall back to polling the VM resource's provisioningState.
    return this.pollUntilTerminal(
      this.computeVmInstanceViewUrl(subscriptionId, resourceGroup, vmName),
      false,
      deadline,
      pollIntervalMs
    );
  }
}
