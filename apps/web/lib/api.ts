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

export function getGraphConsentUrl(nonce: string) {
  return request<{ url: string; nonce: string }>("/api/onboarding/graph-consent-url", { query: { nonce } });
}

export function getDeployToAzureUrl(tenantId: string, subscriptionId?: string) {
  return request<{ url: string; avdManagerServicePrincipalObjectId: string | null }>(
    `/api/onboarding/tenants/${tenantId}/deploy-to-azure-url`,
    { query: { subscriptionId } }
  );
}

export interface SubscriptionsRegistryRow {
  id: string;
  tenant_id: string;
  subscription_id: string | null;
  subscription_display_name: string | null;
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
    preferredAppGroupType?: "Desktop" | "RailApplication";
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

// --- Scaling plans (apps/api/src/routes/scalingPlans.ts) — thin wrappers
// over native Azure AVD Scaling Plans (Microsoft.DesktopVirtualization/
// scalingPlans). There is no local DB table backing these; ARM is the
// sole source of truth, matching the API's design (see scalingPlans.ts's
// header comment for why the custom scaling-policy engine was retired). ---

export interface ScalingPlanScheduleInput {
  name: string;
  daysOfWeek: string[];
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
  hostPoolArmPath: string;
  scalingPlanEnabled: boolean;
}

export interface ScalingPlanRow {
  id: string;
  name: string;
  location: string;
  friendlyName?: string;
  description?: string;
  timeZone: string;
  exclusionTag?: string;
  hostPoolType: "Pooled" | "Personal";
  schedules: ScalingPlanScheduleInput[];
  hostPoolReferences: ScalingPlanHostPoolReference[];
}

export function listScalingPlans(tenantId: string, subscriptionId: string, resourceGroup: string) {
  return request<ScalingPlanRow[]>("/api/scaling-plans", { tenantId, query: { subscriptionId, resourceGroup } });
}

export function getScalingPlan(tenantId: string, subscriptionId: string, resourceGroup: string, name: string) {
  return request<ScalingPlanRow>(`/api/scaling-plans/${encodeURIComponent(name)}`, {
    tenantId,
    query: { subscriptionId, resourceGroup },
  });
}

export function createOrUpdateScalingPlan(
  tenantId: string,
  name: string,
  input: {
    subscriptionId: string;
    resourceGroup: string;
    location: string;
    friendlyName?: string;
    description?: string;
    timeZone: string;
    exclusionTag?: string;
    hostPoolType: "Pooled" | "Personal";
    schedules: ScalingPlanScheduleInput[];
    hostPoolReferences: ScalingPlanHostPoolReference[];
  }
) {
  return request<ScalingPlanRow>(`/api/scaling-plans/${encodeURIComponent(name)}`, {
    tenantId,
    method: "PUT",
    body: input,
  });
}

export function deleteScalingPlan(tenantId: string, name: string, subscriptionId: string, resourceGroup: string) {
  return request<void>(`/api/scaling-plans/${encodeURIComponent(name)}`, {
    tenantId,
    method: "DELETE",
    query: { subscriptionId, resourceGroup },
  });
}

export function attachScalingPlanToHostPool(
  tenantId: string,
  name: string,
  input: { subscriptionId: string; resourceGroup: string; hostPoolArmPath: string; scalingPlanEnabled?: boolean }
) {
  return request<ScalingPlanRow>(`/api/scaling-plans/${encodeURIComponent(name)}/attach`, {
    tenantId,
    method: "POST",
    body: input,
  });
}

export function detachScalingPlanFromHostPool(
  tenantId: string,
  name: string,
  input: { subscriptionId: string; resourceGroup: string; hostPoolArmPath: string }
) {
  return request<ScalingPlanRow>(`/api/scaling-plans/${encodeURIComponent(name)}/detach`, {
    tenantId,
    method: "POST",
    body: input,
  });
}

// --- Application Groups (apps/api/src/routes/applicationGroups.ts) — thin
// wrappers over real Azure AVD Application Groups
// (Microsoft.DesktopVirtualization/applicationGroups). No local DB table;
// ARM is the sole source of truth, matching scaling plans' precedent. ---

export type ApplicationGroupType = "Desktop" | "RemoteApp";

export interface ApplicationGroupRow {
  id: string;
  name: string;
  location: string;
  friendlyName?: string;
  description?: string;
  hostPoolArmPath: string;
  applicationGroupType: ApplicationGroupType;
  workspaceArmPath?: string | null;
}

export function listApplicationGroups(tenantId: string, subscriptionId: string, resourceGroup: string) {
  return request<ApplicationGroupRow[]>("/api/application-groups", { tenantId, query: { subscriptionId, resourceGroup } });
}

export function getApplicationGroup(tenantId: string, subscriptionId: string, resourceGroup: string, name: string) {
  return request<ApplicationGroupRow>(`/api/application-groups/${encodeURIComponent(name)}`, {
    tenantId,
    query: { subscriptionId, resourceGroup },
  });
}

export function createOrUpdateApplicationGroup(
  tenantId: string,
  name: string,
  input: {
    subscriptionId: string;
    resourceGroup: string;
    location: string;
    friendlyName?: string;
    description?: string;
    hostPoolArmPath: string;
    applicationGroupType: ApplicationGroupType;
  }
) {
  return request<ApplicationGroupRow>(`/api/application-groups/${encodeURIComponent(name)}`, {
    tenantId,
    method: "PUT",
    body: input,
  });
}

export function deleteApplicationGroup(tenantId: string, name: string, subscriptionId: string, resourceGroup: string) {
  return request<void>(`/api/application-groups/${encodeURIComponent(name)}`, {
    tenantId,
    method: "DELETE",
    query: { subscriptionId, resourceGroup },
  });
}

// --- Workspaces (apps/api/src/routes/workspaces.ts) — thin wrappers over
// real Azure AVD Workspaces (Microsoft.DesktopVirtualization/workspaces).
// No local DB table; ARM is the sole source of truth. ---

export interface WorkspaceRow {
  id: string;
  name: string;
  location: string;
  friendlyName?: string;
  description?: string;
  applicationGroupReferences: string[];
}

export function listWorkspaces(tenantId: string, subscriptionId: string, resourceGroup: string) {
  return request<WorkspaceRow[]>("/api/workspaces", { tenantId, query: { subscriptionId, resourceGroup } });
}

export function getWorkspace(tenantId: string, subscriptionId: string, resourceGroup: string, name: string) {
  return request<WorkspaceRow>(`/api/workspaces/${encodeURIComponent(name)}`, {
    tenantId,
    query: { subscriptionId, resourceGroup },
  });
}

export function createOrUpdateWorkspace(
  tenantId: string,
  name: string,
  input: {
    subscriptionId: string;
    resourceGroup: string;
    location: string;
    friendlyName?: string;
    description?: string;
  }
) {
  return request<WorkspaceRow>(`/api/workspaces/${encodeURIComponent(name)}`, {
    tenantId,
    method: "PUT",
    body: input,
  });
}

export function deleteWorkspace(tenantId: string, name: string, subscriptionId: string, resourceGroup: string) {
  return request<void>(`/api/workspaces/${encodeURIComponent(name)}`, {
    tenantId,
    method: "DELETE",
    query: { subscriptionId, resourceGroup },
  });
}

export function attachApplicationGroupToWorkspace(
  tenantId: string,
  name: string,
  input: { subscriptionId: string; resourceGroup: string; applicationGroupArmPath: string }
) {
  return request<WorkspaceRow>(`/api/workspaces/${encodeURIComponent(name)}/attach`, {
    tenantId,
    method: "POST",
    body: input,
  });
}

export function detachApplicationGroupFromWorkspace(
  tenantId: string,
  name: string,
  input: { subscriptionId: string; resourceGroup: string; applicationGroupArmPath: string }
) {
  return request<WorkspaceRow>(`/api/workspaces/${encodeURIComponent(name)}/detach`, {
    tenantId,
    method: "POST",
    body: input,
  });
}

// --- Cost estimation (apps/api/src/routes/cost.ts, public retail prices) ---

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

// --- Service Variables (apps/api/src/routes/serviceVariables.ts) ---

export interface ServiceVariableOption {
  value: string;
  label: string;
}

export interface ServiceVariableRow {
  key: string;
  options: ServiceVariableOption[];
  selectedValues: string[];
}

// --- Monitored Resource Groups (apps/api/src/routes/monitoredResourceGroups.ts) ---

export interface ResourceGroupSummary {
  name: string;
  location: string;
}

export interface MonitoredResourceGroupRow {
  subscription_id: string;
  selected_resource_groups: string[];
  last_synced_at: string | null;
}

export function listAzureResourceGroups(tenantId: string, subscriptionId: string) {
  return request<ResourceGroupSummary[]>("/api/monitored-resource-groups/resource-groups", {
    tenantId,
    query: { subscriptionId },
  });
}

export function getMonitoredResourceGroups(tenantId: string) {
  return request<MonitoredResourceGroupRow[]>("/api/monitored-resource-groups/monitored", { tenantId });
}

export function updateMonitoredResourceGroups(tenantId: string, subscriptionId: string, selectedResourceGroups: string[]) {
  return request<{ subscriptionId: string; selectedResourceGroups: string[] }>(
    `/api/monitored-resource-groups/monitored/${encodeURIComponent(subscriptionId)}`,
    { tenantId, method: "PUT", body: { selectedResourceGroups } }
  );
}

export function syncMonitoredResourceGroups(tenantId: string) {
  return request<{ discovered: number; imported: number; errors: string[] }>("/api/monitored-resource-groups/sync", {
    tenantId,
    method: "POST",
  });
}

// --- Cost Optimization: resource inventory (apps/api/src/routes/resources.ts) ---

export interface ResourceRow {
  id: string;
  tenant_id: string;
  subscription_id: string;
  azure_resource_id: string;
  resource_type: string;
  resource_name: string;
  resource_group: string | null;
  location: string | null;
  sku: unknown;
  tags: Record<string, string>;
  properties: unknown;
  first_seen_at: string;
  last_seen_at: string;
  deleted_at: string | null;
}

export interface ResourceTypeSummary {
  resource_type: string;
  count: string;
}

export interface CollectionRunRow {
  id: string;
  collector_type: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  record_count: number | null;
  error_details: unknown;
}

export function triggerResourceCollection(tenantId: string, subscriptionIds?: string[]) {
  return request<{ collectionRunId: string; discovered: number; inserted: number; updated: number; softDeleted: number }>(
    "/api/resources/collect",
    { tenantId, method: "POST", body: subscriptionIds ? { subscriptionIds } : {} }
  );
}

export function listResources(tenantId: string, filters?: { resourceType?: string; subscriptionId?: string }) {
  return request<ResourceRow[]>("/api/resources", { tenantId, query: filters as Record<string, string> });
}

export function getResourceSummary(tenantId: string) {
  return request<ResourceTypeSummary[]>("/api/resources/summary", { tenantId });
}

export function listCollectionRuns(tenantId: string) {
  return request<CollectionRunRow[]>("/api/resources/collection-runs", { tenantId });
}

// --- Cost Optimization: cost facts (apps/api/src/routes/costFacts.ts) ---

export interface CostSummaryRow {
  month: string;
  currency: string;
  total_cost: string;
}

export interface CostByServiceRow {
  service_family: string | null;
  currency: string;
  total_cost: string;
}

export function triggerCostIngestion(tenantId: string) {
  return request<{ collectionRunId: string; rowsIngested: number }>("/api/cost-facts/ingest", { tenantId, method: "POST", body: {} });
}

export function getCostSummary(tenantId: string) {
  return request<CostSummaryRow[]>("/api/cost-facts/summary", { tenantId });
}

export function getCostByService(tenantId: string) {
  return request<CostByServiceRow[]>("/api/cost-facts/by-service", { tenantId });
}

// --- Cost Optimization: telemetry (apps/api/src/routes/telemetry.ts) ---

export function triggerTelemetryCollection(tenantId: string) {
  return request<{ collectionRunId: string; vmsCollected: number; hostPoolsCollected: number; metricPointsIngested: number; errors: string[] }>(
    "/api/telemetry/collect",
    { tenantId, method: "POST", body: {} }
  );
}

// --- Cost Optimization: recommendations (apps/api/src/routes/recommendations.ts) ---

export interface RecommendationRow {
  id: string;
  rule_id: string;
  azure_resource_id: string | null;
  title: string;
  summary: string;
  category: string;
  severity: string;
  risk: string;
  estimated_monthly_savings: string | null;
  currency: string | null;
  confidence_score: string;
  evidence: Record<string, unknown>;
  status: string;
  first_detected_at: string;
  last_detected_at: string;
}

export function evaluateRecommendations(tenantId: string) {
  return request<{ ruleResults: { ruleId: string; candidatesFound: number }[] }>("/api/recommendations/evaluate", { tenantId, method: "POST", body: {} });
}

export function listRecommendations(tenantId: string, status: string = "open") {
  return request<RecommendationRow[]>("/api/recommendations", { tenantId, query: { status } });
}

export function dismissRecommendation(tenantId: string, id: string) {
  return request<void>(`/api/recommendations/${id}/dismiss`, { tenantId, method: "POST" });
}

export function uploadCustomTemplate(tenantId: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  const base = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";
  return fetch(`${base}/api/custom-templates/upload`, {
    method: "POST",
    headers: { "x-tenant-id": tenantId },
    body: form,
  }).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `upload failed: ${res.status}`);
    return body as {
      id: string;
      fileName: string;
      parameters: { name: string; type: string; description?: string; defaultValue?: unknown; allowedValues?: unknown[]; required: boolean }[];
      rawUrl: string;
      deployUrl: string;
    };
  });
}

export function listServiceVariables(tenantId: string) {
  return request<ServiceVariableRow[]>("/api/service-variables", { tenantId });
}

export function updateServiceVariable(tenantId: string, key: string, selectedValues: string[]) {
  return request<{ key: string; selectedValues: string[] }>(`/api/service-variables/${encodeURIComponent(key)}`, {
    tenantId,
    method: "PUT",
    body: { selectedValues },
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
