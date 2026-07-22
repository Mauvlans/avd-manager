import type { FetchLike, TokenProvider, ArmLroResult } from "./armHostPoolClient";

/**
 * Thin, real HTTP client over the Microsoft.DesktopVirtualization
 * `scalingPlans` ARM REST API (native AVD autoscaling), added to replace
 * the custom scaling-policy engine (scalingPolicyEvaluator.ts,
 * autoscaleTimer.ts, scalingActionRetryWorker.ts — all retired). Adam's
 * explicit call: don't build a competing scheduler when Azure already
 * ships one for free — surface/manage Azure's own Scaling Plans via ARM
 * instead of re-implementing ramp-up/peak/ramp-down scheduling ourselves.
 *
 * Deliberately mirrors ArmHostPoolClient's FetchLike/TokenProvider/
 * ArmLroResult/LRO-polling conventions exactly (same file's exported types
 * are reused rather than redeclared) so this codebase has exactly one ARM
 * calling convention, not two slightly-different ones.
 *
 * ARM resource shape verified against the real Microsoft.DesktopVirtualization
 * `scalingPlans` schema (schedules keyed by rampUp/peak/rampDown/offPeak
 * start times + capacity thresholds + minimum-hosts percentages, and a
 * `hostPoolReferences` array of { hostPoolArmPath, scalingPlanEnabled }
 * used to attach/detach the plan from host pools) — there is no separate
 * "attach" REST verb; attaching/detaching a host pool is done by PUTting
 * the scaling plan with an updated hostPoolReferences array, matching how
 * Terraform's azurerm_virtual_desktop_scaling_plan `host_pool` blocks work
 * against the same underlying API.
 */

export interface ScalingPlanSchedule {
  name: string;
  daysOfWeek: (
    | "Monday"
    | "Tuesday"
    | "Wednesday"
    | "Thursday"
    | "Friday"
    | "Saturday"
    | "Sunday"
  )[];
  rampUpStartTime: { hour: number; minute: number };
  rampUpLoadBalancingAlgorithm: "BreadthFirst" | "DepthFirst";
  rampUpMinimumHostsPct: number;
  rampUpCapacityThresholdPct: number;
  peakStartTime: { hour: number; minute: number };
  peakLoadBalancingAlgorithm: "BreadthFirst" | "DepthFirst";
  rampDownStartTime: { hour: number; minute: number };
  rampDownLoadBalancingAlgorithm: "BreadthFirst" | "DepthFirst";
  rampDownMinimumHostsPct: number;
  rampDownCapacityThresholdPct: number;
  rampDownForceLogoffUsers: boolean;
  rampDownWaitTimeMinutes: number;
  rampDownNotificationMessage?: string;
  rampDownStopHostsWhen: "ZeroSessions" | "ZeroActiveSessions";
  offPeakStartTime: { hour: number; minute: number };
  offPeakLoadBalancingAlgorithm: "BreadthFirst" | "DepthFirst";
}

export interface ScalingPlanHostPoolReference {
  /** Full ARM resourceId of the host pool this plan applies to, e.g.
   * /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.DesktopVirtualization/hostPools/{name} */
  hostPoolArmPath: string;
  scalingPlanEnabled: boolean;
}

export interface ScalingPlan {
  id: string;
  name: string;
  location: string;
  friendlyName?: string;
  description?: string;
  timeZone: string;
  exclusionTag?: string;
  hostPoolType: "Pooled" | "Personal";
  schedules: ScalingPlanSchedule[];
  hostPoolReferences: ScalingPlanHostPoolReference[];
}

export interface CreateOrUpdateScalingPlanParams {
  location: string;
  friendlyName?: string;
  description?: string;
  timeZone: string;
  exclusionTag?: string;
  hostPoolType: "Pooled" | "Personal";
  schedules: ScalingPlanSchedule[];
  hostPoolReferences: ScalingPlanHostPoolReference[];
}

export interface IArmScalingPlanClient {
  listScalingPlans(subscriptionId: string, resourceGroup: string): Promise<ScalingPlan[]>;
  getScalingPlan(subscriptionId: string, resourceGroup: string, name: string): Promise<ScalingPlan | null>;
  createOrUpdateScalingPlan(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    params: CreateOrUpdateScalingPlanParams,
    opts?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<ArmLroResult<ScalingPlan>>;
  deleteScalingPlan(subscriptionId: string, resourceGroup: string, name: string): Promise<void>;
  attachScalingPlanToHostPool(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    hostPoolArmPath: string,
    scalingPlanEnabled?: boolean
  ): Promise<ArmLroResult<ScalingPlan>>;
  detachScalingPlanFromHostPool(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    hostPoolArmPath: string
  ): Promise<ArmLroResult<ScalingPlan>>;
}

// Same stable Microsoft.DesktopVirtualization API version armHostPoolClient.ts
// uses — scalingPlans lives under the same resource provider, so there is no
// reason to pin a different version here (and doing so would risk drifting
// out of sync with the rest of the DesktopVirtualization surface this
// codebase talks to).
const ARM_API_VERSION = "2023-09-05";
const ARM_BASE = "https://management.azure.com";

export class ArmScalingPlanClient implements IArmScalingPlanClient {
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

  private scalingPlanUrl(subscriptionId: string, resourceGroup: string, name?: string): string {
    const base = `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DesktopVirtualization/scalingPlans`;
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

  private mapArmScalingPlan(armObj: any): ScalingPlan {
    const props = armObj.properties ?? {};
    return {
      id: armObj.id,
      name: armObj.name,
      location: armObj.location,
      friendlyName: props.friendlyName,
      description: props.description,
      timeZone: props.timeZone,
      exclusionTag: props.exclusionTag,
      hostPoolType: props.hostPoolType ?? "Pooled",
      schedules: (props.schedules ?? []).map((s: any) => ({
        name: s.name,
        daysOfWeek: s.daysOfWeek ?? [],
        rampUpStartTime: s.rampUpStartTime,
        rampUpLoadBalancingAlgorithm: s.rampUpLoadBalancingAlgorithm,
        rampUpMinimumHostsPct: s.rampUpMinimumHostsPct,
        rampUpCapacityThresholdPct: s.rampUpCapacityThresholdPct,
        peakStartTime: s.peakStartTime,
        peakLoadBalancingAlgorithm: s.peakLoadBalancingAlgorithm,
        rampDownStartTime: s.rampDownStartTime,
        rampDownLoadBalancingAlgorithm: s.rampDownLoadBalancingAlgorithm,
        rampDownMinimumHostsPct: s.rampDownMinimumHostsPct,
        rampDownCapacityThresholdPct: s.rampDownCapacityThresholdPct,
        rampDownForceLogoffUsers: s.rampDownForceLogoffUsers,
        rampDownWaitTimeMinutes: s.rampDownWaitTimeMinutes,
        rampDownNotificationMessage: s.rampDownNotificationMessage,
        rampDownStopHostsWhen: s.rampDownStopHostsWhen,
        offPeakStartTime: s.offPeakStartTime,
        offPeakLoadBalancingAlgorithm: s.offPeakLoadBalancingAlgorithm,
      })),
      hostPoolReferences: (props.hostPoolReferences ?? []).map((h: any) => ({
        hostPoolArmPath: h.hostPoolArmPath,
        scalingPlanEnabled: h.scalingPlanEnabled ?? false,
      })),
    };
  }

  async listScalingPlans(subscriptionId: string, resourceGroup: string): Promise<ScalingPlan[]> {
    const data = await this.request(this.scalingPlanUrl(subscriptionId, resourceGroup), "GET");
    return (data.value ?? []).map((v: any) => this.mapArmScalingPlan(v));
  }

  async getScalingPlan(subscriptionId: string, resourceGroup: string, name: string): Promise<ScalingPlan | null> {
    try {
      const data = await this.request(this.scalingPlanUrl(subscriptionId, resourceGroup, name), "GET");
      return this.mapArmScalingPlan(data);
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) return null;
      throw err;
    }
  }

  async createOrUpdateScalingPlan(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    params: CreateOrUpdateScalingPlanParams,
    opts?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<ArmLroResult<ScalingPlan>> {
    const body = {
      location: params.location,
      properties: {
        friendlyName: params.friendlyName,
        description: params.description,
        timeZone: params.timeZone,
        exclusionTag: params.exclusionTag,
        hostPoolType: params.hostPoolType,
        schedules: params.schedules,
        hostPoolReferences: params.hostPoolReferences,
      },
    };
    const url = this.scalingPlanUrl(subscriptionId, resourceGroup, name);
    const { data, status, headers } = await this.requestWithHeaders(url, "PUT", body);

    // 200/201 both mean the PUT completed synchronously — same convention
    // as ArmHostPoolClient.createOrUpdateHostPool.
    if (status === 200 || status === 201) {
      return { outcome: "succeeded", data: this.mapArmScalingPlan(data) };
    }

    // 202 Accepted: poll to a terminal state instead of trusting the
    // response body alone.
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const pollIntervalMs = opts?.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    const asyncOpUrl = headers?.get?.("Azure-AsyncOperation") ?? headers?.get?.("azure-asyncoperation");
    if (asyncOpUrl) {
      const result = await this.pollAsyncOperation(asyncOpUrl, deadline, pollIntervalMs);
      if (result.outcome !== "succeeded") return result;
    } else {
      // No async-operation header — ARM doesn't expose a provisioningState
      // on scalingPlans any more than it does on hostPools, so fall back
      // to "the GET succeeds and returns the name we expect" as the best
      // available terminal signal, exactly like createOrUpdateHostPool.
      const pollResult = await this.pollScalingPlanExists(subscriptionId, resourceGroup, name, deadline, pollIntervalMs);
      if (pollResult.outcome !== "succeeded") return pollResult;
    }

    const finalData = await this.request(this.scalingPlanUrl(subscriptionId, resourceGroup, name), "GET");
    return { outcome: "succeeded", data: this.mapArmScalingPlan(finalData) };
  }

  private async pollScalingPlanExists(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    deadline: number,
    pollIntervalMs: number
  ): Promise<ArmLroResult<void>> {
    const headers = await this.authHeaders();
    const url = this.scalingPlanUrl(subscriptionId, resourceGroup, name);
    while (Date.now() < deadline) {
      const res = await this.fetchImpl(url, { method: "GET", headers });
      if (res.ok) return { outcome: "succeeded" } as ArmLroResult<void>;
      if (res.status !== 404) {
        const errBody = await res.json().catch(() => ({}));
        return { outcome: "failed", reason: `poll request failed: ${res.status} ${JSON.stringify(errBody)}` };
      }
      await this.sleep(pollIntervalMs);
    }
    return { outcome: "timeout", reason: "scaling plan did not become visible within the polling deadline" };
  }

  async deleteScalingPlan(subscriptionId: string, resourceGroup: string, name: string): Promise<void> {
    await this.request(this.scalingPlanUrl(subscriptionId, resourceGroup, name), "DELETE");
  }

  /**
   * There is no dedicated "attach"/"detach" ARM verb for scaling plans —
   * per the real Microsoft.DesktopVirtualization scalingPlans schema,
   * association with a host pool is expressed entirely through the plan's
   * own `hostPoolReferences` array (this matches how the Azure portal and
   * Terraform's azurerm_virtual_desktop_scaling_plan `host_pool` blocks
   * both do it under the hood). So attach/detach here are read-modify-write
   * helpers: fetch the current plan, splice hostPoolArmPath in/out of
   * hostPoolReferences, then PUT the whole plan back via
   * createOrUpdateScalingPlan so the LRO-polling behavior is identical to
   * every other write path in this client.
   */
  async attachScalingPlanToHostPool(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    hostPoolArmPath: string,
    scalingPlanEnabled = true
  ): Promise<ArmLroResult<ScalingPlan>> {
    const plan = await this.getScalingPlan(subscriptionId, resourceGroup, name);
    if (!plan) {
      return { outcome: "failed", reason: `scaling plan ${name} not found` };
    }
    const existingRefs = plan.hostPoolReferences.filter((r) => r.hostPoolArmPath !== hostPoolArmPath);
    const hostPoolReferences = [...existingRefs, { hostPoolArmPath, scalingPlanEnabled }];
    return this.createOrUpdateScalingPlan(subscriptionId, resourceGroup, name, {
      location: plan.location,
      friendlyName: plan.friendlyName,
      description: plan.description,
      timeZone: plan.timeZone,
      exclusionTag: plan.exclusionTag,
      hostPoolType: plan.hostPoolType,
      schedules: plan.schedules,
      hostPoolReferences,
    });
  }

  async detachScalingPlanFromHostPool(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    hostPoolArmPath: string
  ): Promise<ArmLroResult<ScalingPlan>> {
    const plan = await this.getScalingPlan(subscriptionId, resourceGroup, name);
    if (!plan) {
      return { outcome: "failed", reason: `scaling plan ${name} not found` };
    }
    const hostPoolReferences = plan.hostPoolReferences.filter((r) => r.hostPoolArmPath !== hostPoolArmPath);
    return this.createOrUpdateScalingPlan(subscriptionId, resourceGroup, name, {
      location: plan.location,
      friendlyName: plan.friendlyName,
      description: plan.description,
      timeZone: plan.timeZone,
      exclusionTag: plan.exclusionTag,
      hostPoolType: plan.hostPoolType,
      schedules: plan.schedules,
      hostPoolReferences,
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
