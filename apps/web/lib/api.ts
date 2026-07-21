/**
 * Thin client for the AVD Manager Express API (apps/api). Endpoint shapes
 * are taken directly from apps/api/src/routes/*.ts — do not guess new ones
 * here without checking that source first.
 *
 * Auth: the API's tenantAuth middleware expects `x-tenant-id` always, and
 * (if API_AUTH_TOKEN is set server-side) `x-api-key` too. In this MVP the
 * web app is a trusted server-side-rendered/BFF-style caller, so both
 * headers are attached uniformly here rather than per-call.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";
// This is only safe because in this MVP the web app calls the API from a
// trusted server context (or a private network in docker-compose), not
// directly from an end-user's browser. See PROGRESS.md: real per-user auth
// (Graph-issued JWT validated per request) is a documented next step, at
// which point this shared secret goes away entirely in favor of per-request
// bearer tokens forwarded from the signed-in user's session.
const API_KEY = process.env.API_AUTH_TOKEN || process.env.NEXT_PUBLIC_API_AUTH_TOKEN || "";

export interface ApiOptions {
  tenantId?: string;
  actor?: string;
}

async function request<T>(
  path: string,
  opts: ApiOptions & { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {}
): Promise<T> {
  const { tenantId, actor, method = "GET", body, query } = opts;
  const url = new URL(API_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (tenantId) headers["x-tenant-id"] = tenantId;
  if (actor) headers["x-actor"] = actor;
  if (API_KEY) headers["x-api-key"] = API_KEY;

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error((data && data.error) || `API request failed: ${method} ${path} -> ${res.status}`);
  }
  return data as T;
}

// --- Onboarding (apps/api/src/routes/onboarding.ts) ---

export function createTenant(input: { displayName: string; entraTenantId: string }) {
  return request<{ id: string }>("/api/onboarding/tenants", { method: "POST", body: input });
}

export function getGraphConsentUrl(tenantId: string) {
  return request<{ url: string }>(`/api/onboarding/tenants/${tenantId}/graph-consent-url`);
}

export function getDeployToAzureUrl(tenantId: string, subscriptionId?: string) {
  return request<{ url: string }>(`/api/onboarding/tenants/${tenantId}/deploy-to-azure-url`, {
    query: { subscriptionId },
  });
}

export interface SubscriptionsRegistryRow {
  id: string;
  tenant_id: string;
  subscription_id: string;
  resource_groups: string[];
  rbac_role_definition_id: string | null;
  rbac_grant_status: "not_requested" | "pending" | "granted" | "drifted" | "revoked";
  rbac_last_verified_at: string | null;
  rbac_drift_details: string | null;
  graph_consent_status: "not_requested" | "pending" | "granted" | "revoked";
  graph_consent_service_principal_id: string | null;
  graph_consent_granted_at: string | null;
  created_at: string;
  updated_at: string;
}

export function getOnboardingRegistry(tenantId: string) {
  return request<SubscriptionsRegistryRow[]>(`/api/onboarding/tenants/${tenantId}/registry`);
}

// --- Host pools (apps/api/src/routes/hostPools.ts) — tenant-scoped, needs x-tenant-id ---

export interface HostPoolRow {
  id: string;
  tenant_id: string;
  subscription_id: string;
  resource_group: string;
  name: string;
  location: string;
  host_pool_type: string;
  load_balancer_type: string;
  max_session_limit: number;
  session_host_count: number;
  created_at: string;
  updated_at: string;
}

export function listHostPools(tenantId: string) {
  return request<HostPoolRow[]>("/api/host-pools", { tenantId });
}

export function getHostPool(tenantId: string, id: string) {
  return request<HostPoolRow>(`/api/host-pools/${id}`, { tenantId });
}

export function createHostPool(
  tenantId: string,
  input: {
    subscriptionId: string;
    resourceGroup: string;
    name: string;
    location: string;
    hostPoolType: "Personal" | "Pooled";
    loadBalancerType: "BreadthFirst" | "DepthFirst" | "Persistent";
    maxSessionLimit?: number;
  }
) {
  return request<HostPoolRow & { warning?: string }>("/api/host-pools", {
    tenantId,
    method: "POST",
    body: input,
  });
}

export function deleteHostPool(tenantId: string, id: string) {
  return request<void>(`/api/host-pools/${id}`, { tenantId, method: "DELETE" });
}

// --- Session hosts (apps/api/src/routes/hostPools.ts session-host routes) ---

export interface SessionHostRow {
  name: string;
  hostPoolId: string;
  resourceId: string;
  status: "Available" | "Unavailable" | "Shutdown" | "Disconnected" | "Upgrading" | "Unknown";
  sessions: number;
  allowNewSession: boolean;
  vmSize: string;
  lastHeartBeat: string | null;
}

export type ArmLroResult =
  | { outcome: "succeeded" }
  | { outcome: "failed"; reason: string }
  | { outcome: "timeout"; reason: string };

export function listSessionHosts(tenantId: string, hostPoolId: string) {
  return request<SessionHostRow[]>(`/api/host-pools/${hostPoolId}/session-hosts`, { tenantId });
}

export function startSessionHost(tenantId: string, hostPoolId: string, sessionHostName: string) {
  return request<ArmLroResult>(`/api/host-pools/${hostPoolId}/session-hosts/${encodeURIComponent(sessionHostName)}/start`, {
    tenantId,
    method: "POST",
  });
}

export function deallocateSessionHost(tenantId: string, hostPoolId: string, sessionHostName: string) {
  return request<ArmLroResult>(
    `/api/host-pools/${hostPoolId}/session-hosts/${encodeURIComponent(sessionHostName)}/deallocate`,
    { tenantId, method: "POST" }
  );
}

// --- Scaling policies (apps/api/src/routes/scalingPolicies.ts) ---

export interface ScalingPolicyRow {
  id: string;
  tenant_id: string;
  host_pool_id: string;
  name: string;
  mode: "schedule" | "dynamic_threshold";
  enabled: boolean;
  schedule_config: unknown;
  dynamic_config: unknown;
  max_hosts_per_action: number;
  max_cost_delta_per_action_usd_per_hour: string;
  created_at: string;
  updated_at: string;
}

export function listScalingPolicies(tenantId: string, hostPoolId?: string) {
  return request<ScalingPolicyRow[]>("/api/scaling-policies", { tenantId, query: { hostPoolId } });
}

export function createScalingPolicy(
  tenantId: string,
  input: {
    hostPoolId: string;
    name: string;
    mode: "schedule" | "dynamic_threshold";
    enabled?: boolean;
    scheduleConfig?: unknown;
    dynamicConfig?: unknown;
    maxHostsPerAction: number;
    maxCostDeltaPerActionUsdPerHour: number;
  }
) {
  return request<ScalingPolicyRow>("/api/scaling-policies", { tenantId, method: "POST", body: input });
}

export function setScalingPolicyEnabled(tenantId: string, id: string, enabled: boolean) {
  return request<ScalingPolicyRow>(`/api/scaling-policies/${id}`, {
    tenantId,
    method: "PATCH",
    body: { enabled },
  });
}

// --- Cost estimation (apps/api/src/routes/scalingPolicies.ts costRouter, public retail prices) ---

export interface CostEstimateResponse {
  price: { retailPrice: number; currencyCode: string; armSkuName: string; armRegionName: string };
  hourlyCost: number;
  monthlyCost: number;
}

export function getCostEstimate(armSkuName: string, armRegionName: string, hostCount: number) {
  return request<CostEstimateResponse>("/api/cost/estimate", {
    query: { armSkuName, armRegionName, hostCount: String(hostCount) },
  });
}

// --- Audit log (apps/api/src/routes/auditLog.ts) ---

export interface AuditLogRow {
  id: string;
  tenant_id: string;
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string;
  before_state: unknown;
  after_state: unknown;
  created_at: string;
}

export function listAuditLog(tenantId: string, limit = 50) {
  return request<AuditLogRow[]>("/api/audit-log", { tenantId, query: { limit: String(limit) } });
}
