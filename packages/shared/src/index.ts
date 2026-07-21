// Shared domain types used by both the API and the web frontend.

export type GraphConsentStatus = "not_requested" | "pending" | "granted" | "revoked";
export type RbacGrantStatus = "not_requested" | "pending" | "granted" | "drifted" | "revoked";

export interface Tenant {
  id: string;
  displayName: string;
  entraTenantId: string; // customer's Entra (AAD) tenant GUID
  createdAt: string;
  status: "onboarding" | "active" | "suspended";
}

export interface SubscriptionRegistryEntry {
  id: string;
  tenantId: string;
  subscriptionId: string;
  resourceGroups: string[]; // resource groups in scope for this subscription
  rbacRoleDefinitionId: string | null; // custom role definition id once created
  rbacGrantStatus: RbacGrantStatus;
  rbacLastVerifiedAt: string | null;
  rbacDriftDetails: string | null;
  graphConsentStatus: GraphConsentStatus;
  graphConsentServicePrincipalId: string | null;
  graphConsentGrantedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type HostPoolType = "Personal" | "Pooled";
export type LoadBalancerType = "BreadthFirst" | "DepthFirst" | "Persistent";

export interface HostPool {
  id: string;
  tenantId: string;
  subscriptionId: string;
  resourceGroup: string;
  name: string;
  location: string;
  hostPoolType: HostPoolType;
  loadBalancerType: LoadBalancerType;
  maxSessionLimit: number;
  sessionHostCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionHost {
  name: string;
  hostPoolId: string;
  resourceId: string; // full ARM resource id of the underlying VM
  status: "Available" | "Unavailable" | "Shutdown" | "Disconnected" | "Upgrading" | "Unknown";
  sessions: number;
  allowNewSession: boolean;
  vmSize: string;
  lastHeartBeat: string | null;
}

export type ScalingMode = "schedule" | "dynamic_threshold";

export interface SafetyCaps {
  maxHostsPerAction: number; // max hosts started/stopped in a single evaluation cycle
  maxCostDeltaPerActionUsdPerHour: number; // max $/hr swing allowed in a single action
}

export interface SchedulePolicyConfig {
  timeZone: string;
  ramp: { cron: string; targetRunningHosts: number }[];
}

export interface DynamicThresholdPolicyConfig {
  cpuPercentScaleOutThreshold: number;
  cpuPercentScaleInThreshold: number;
  sessionsPerHostScaleOutThreshold: number;
  minRunningHosts: number;
  maxRunningHosts: number;
  scaleInGracePeriodMinutes: number;
}

export interface ScalingPolicy {
  id: string;
  tenantId: string;
  hostPoolId: string;
  name: string;
  mode: ScalingMode;
  enabled: boolean;
  scheduleConfig: SchedulePolicyConfig | null;
  dynamicConfig: DynamicThresholdPolicyConfig | null;
  safetyCaps: SafetyCaps;
  createdAt: string;
  updatedAt: string;
}

export type ScalingActionType = "start_host" | "stop_host" | "deallocate_host" | "no_op";

export interface ScalingDecision {
  hostPoolId: string;
  policyId: string;
  actions: { hostName: string; action: ScalingActionType; reason: string }[];
  estimatedCostDeltaUsdPerHour: number;
  clampedBySafetyCaps: boolean;
  clampReason: string | null;
  evaluatedAt: string;
}

export interface AuditLogEntry {
  id: string;
  tenantId: string;
  actor: string; // user id/email, or "system:autoscale-engine" etc.
  action: string;
  resourceType: string;
  resourceId: string;
  beforeState: unknown | null;
  afterState: unknown | null;
  createdAt: string;
}

export interface RetailPriceItem {
  armSkuName: string;
  armRegionName: string;
  retailPrice: number;
  unitOfMeasure: string;
  currencyCode: string;
  productName: string;
  meterName: string;
}
