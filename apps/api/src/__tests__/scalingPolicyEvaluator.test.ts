import { ScalingPolicyEvaluator } from "../services/scalingPolicyEvaluator";
import type { ScalingPolicy, SessionHost } from "@avd-manager/shared";

function basePolicy(overrides: Partial<ScalingPolicy> = {}): ScalingPolicy {
  return {
    id: "policy-1",
    tenantId: "tenant-1",
    hostPoolId: "pool-1",
    name: "test policy",
    mode: "dynamic_threshold",
    enabled: true,
    scheduleConfig: null,
    dynamicConfig: {
      cpuPercentScaleOutThreshold: 80,
      cpuPercentScaleInThreshold: 20,
      sessionsPerHostScaleOutThreshold: 5,
      minRunningHosts: 1,
      maxRunningHosts: 10,
      scaleInGracePeriodMinutes: 15,
    },
    safetyCaps: { maxHostsPerAction: 2, maxCostDeltaPerActionUsdPerHour: 5 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function host(overrides: Partial<SessionHost> = {}): SessionHost {
  return {
    name: "host-1",
    hostPoolId: "pool-1",
    resourceId: "/subscriptions/x",
    status: "Available",
    sessions: 0,
    allowNewSession: true,
    vmSize: "Standard_D2s_v5",
    lastHeartBeat: null,
    ...overrides,
  };
}

describe("ScalingPolicyEvaluator", () => {
  const evaluator = new ScalingPolicyEvaluator();

  it("returns no-op when policy disabled", () => {
    const decision = evaluator.evaluate(basePolicy({ enabled: false }), [], 0.1);
    expect(decision.actions).toHaveLength(0);
  });

  it("scales out when avg sessions/host exceeds threshold, within caps", () => {
    const hosts = [
      host({ name: "h1", sessions: 8 }),
      host({ name: "h2", status: "Shutdown", sessions: 0 }),
      host({ name: "h3", status: "Shutdown", sessions: 0 }),
    ];
    const decision = evaluator.evaluate(basePolicy(), hosts, 0.1);
    expect(decision.actions.length).toBeGreaterThan(0);
    expect(decision.actions.every((a) => a.action === "start_host")).toBe(true);
    expect(decision.clampedBySafetyCaps).toBe(false);
  });

  it("clamps scale-out to maxHostsPerAction even if more hosts are eligible", () => {
    const hosts = [
      host({ name: "h1", sessions: 10 }),
      host({ name: "h2", status: "Shutdown" }),
      host({ name: "h3", status: "Shutdown" }),
      host({ name: "h4", status: "Shutdown" }),
      host({ name: "h5", status: "Shutdown" }),
    ];
    const policy = basePolicy({ safetyCaps: { maxHostsPerAction: 1, maxCostDeltaPerActionUsdPerHour: 100 } });
    const decision = evaluator.evaluate(policy, hosts, 0.1);
    expect(decision.actions).toHaveLength(1);
    expect(decision.clampedBySafetyCaps).toBe(true);
    expect(decision.clampReason).toMatch(/maxHostsPerAction/);
  });

  it("clamps scale-out actions when estimated cost delta exceeds cap", () => {
    const hosts = [
      host({ name: "h1", sessions: 10 }),
      host({ name: "h2", status: "Shutdown" }),
      host({ name: "h3", status: "Shutdown" }),
      host({ name: "h4", status: "Shutdown" }),
    ];
    // maxHostsPerAction=10 lets 3 start_host actions through, but a $1/hr
    // cost cap with a $0.50/hr host price should clamp to 2 actions ($1.00).
    const policy = basePolicy({ safetyCaps: { maxHostsPerAction: 10, maxCostDeltaPerActionUsdPerHour: 1.0 } });
    const decision = evaluator.evaluate(policy, hosts, 0.5);
    expect(decision.actions.length).toBeLessThanOrEqual(2);
    expect(decision.clampedBySafetyCaps).toBe(true);
    expect(Math.abs(decision.estimatedCostDeltaUsdPerHour)).toBeLessThanOrEqual(1.0);
  });

  it("scales in idle hosts above the min-running floor", () => {
    const hosts = [
      host({ name: "h1", sessions: 0 }),
      host({ name: "h2", sessions: 0 }),
      host({ name: "h3", sessions: 1 }),
    ];
    const policy = basePolicy({
      dynamicConfig: {
        cpuPercentScaleOutThreshold: 80,
        cpuPercentScaleInThreshold: 20,
        sessionsPerHostScaleOutThreshold: 999, // never scale out in this test
        minRunningHosts: 1,
        maxRunningHosts: 10,
        scaleInGracePeriodMinutes: 15,
      },
    });
    const decision = evaluator.evaluate(policy, hosts, 0.1);
    expect(decision.actions.every((a) => a.action === "deallocate_host")).toBe(true);
    // 3 running, floor 1 => at most 2 removable, and only idle ones (h1,h2) qualify
    expect(decision.actions.length).toBeLessThanOrEqual(2);
  });

  it("never scales below minRunningHosts", () => {
    const hosts = [host({ name: "h1", sessions: 0 })];
    const policy = basePolicy({
      dynamicConfig: {
        cpuPercentScaleOutThreshold: 80,
        cpuPercentScaleInThreshold: 20,
        sessionsPerHostScaleOutThreshold: 999,
        minRunningHosts: 1,
        maxRunningHosts: 10,
        scaleInGracePeriodMinutes: 15,
      },
    });
    const decision = evaluator.evaluate(policy, hosts, 0.1);
    expect(decision.actions).toHaveLength(0);
  });

  it("schedule mode ramps to target running host count", () => {
    const now = new Date();
    now.setUTCHours(9, 0, 0, 0);
    const policy = basePolicy({
      mode: "schedule",
      dynamicConfig: null,
      scheduleConfig: {
        timeZone: "UTC",
        ramp: [
          { cron: "0 8", targetRunningHosts: 3 },
          { cron: "0 18", targetRunningHosts: 1 },
        ],
      },
    });
    const hosts = [
      host({ name: "h1", status: "Available" }),
      host({ name: "h2", status: "Shutdown" }),
      host({ name: "h3", status: "Shutdown" }),
    ];
    const decision = evaluator.evaluate(policy, hosts, 0.1, now);
    expect(decision.actions.filter((a) => a.action === "start_host")).toHaveLength(2);
  });
});
