import type { ScalingActionType, ScalingDecision, ScalingPolicy, SessionHost } from "@avd-manager/shared";

/**
 * Pure, side-effect-free evaluator: given a scaling policy, current session
 * host state, and (optionally) a $/hr cost-per-host estimate, produces a
 * ScalingDecision. No Azure calls happen here — this is the safety-critical
 * logic and is fully unit tested with fixtures.
 *
 * SAFETY: this evaluator NEVER returns more actions than
 * policy.safetyCaps.maxHostsPerAction, and NEVER returns a decision whose
 * estimatedCostDeltaUsdPerHour exceeds policy.safetyCaps.maxCostDeltaPerActionUsdPerHour.
 * If the "ideal" scaling action would exceed either cap, the decision is
 * clamped and clampedBySafetyCaps=true + clampReason is set. Callers
 * (the timer function) must never bypass this and must log clamps loudly.
 */
export class ScalingPolicyEvaluator {
  evaluate(
    policy: ScalingPolicy,
    hosts: SessionHost[],
    costPerHostUsdPerHour: number,
    now: Date = new Date()
  ): ScalingDecision {
    if (!policy.enabled) {
      return this.noOpDecision(policy, "policy is disabled");
    }

    let desiredActions: { hostName: string; action: ScalingActionType; reason: string }[] = [];

    if (policy.mode === "schedule" && policy.scheduleConfig) {
      desiredActions = this.evaluateSchedule(policy, hosts, now);
    } else if (policy.mode === "dynamic_threshold" && policy.dynamicConfig) {
      desiredActions = this.evaluateDynamicThreshold(policy, hosts);
    } else {
      return this.noOpDecision(policy, "policy missing required config for its mode");
    }

    return this.applySafetyCaps(policy, desiredActions, costPerHostUsdPerHour, now);
  }

  private noOpDecision(policy: ScalingPolicy, reason: string): ScalingDecision {
    return {
      hostPoolId: policy.hostPoolId,
      policyId: policy.id,
      actions: [],
      estimatedCostDeltaUsdPerHour: 0,
      clampedBySafetyCaps: false,
      clampReason: null,
      evaluatedAt: new Date().toISOString(),
    };
  }

  private evaluateSchedule(
    policy: ScalingPolicy,
    hosts: SessionHost[],
    now: Date
  ): { hostName: string; action: ScalingActionType; reason: string }[] {
    const config = policy.scheduleConfig!;
    // Find the most recently-passed ramp entry for "today" (simplified: cron
    // minute-hour match against `now`, in policy.scheduleConfig.timeZone —
    // full cron parsing intentionally out of scope for v1; we support simple
    // "M H" (minute hour, run daily) entries).
    let targetRunningHosts: number | null = null;
    for (const entry of config.ramp) {
      const [minuteStr, hourStr] = entry.cron.split(" ");
      const minute = Number(minuteStr);
      const hour = Number(hourStr);
      const entryMinutesOfDay = hour * 60 + minute;
      const nowMinutesOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
      if (entryMinutesOfDay <= nowMinutesOfDay) {
        targetRunningHosts = entry.targetRunningHosts;
      }
    }
    if (targetRunningHosts === null) return [];

    const runningHosts = hosts.filter((h) => h.status === "Available");
    const stoppedHosts = hosts.filter((h) => h.status !== "Available");

    const actions: { hostName: string; action: ScalingActionType; reason: string }[] = [];
    if (runningHosts.length < targetRunningHosts) {
      const needed = targetRunningHosts - runningHosts.length;
      for (const h of stoppedHosts.slice(0, needed)) {
        actions.push({ hostName: h.name, action: "start_host", reason: "schedule ramp-up" });
      }
    } else if (runningHosts.length > targetRunningHosts) {
      const excess = runningHosts.length - targetRunningHosts;
      // Prefer hosts with zero sessions to avoid disrupting users.
      const idleFirst = [...runningHosts].sort((a, b) => a.sessions - b.sessions);
      for (const h of idleFirst.slice(0, excess)) {
        actions.push({ hostName: h.name, action: "deallocate_host", reason: "schedule ramp-down" });
      }
    }
    return actions;
  }

  private evaluateDynamicThreshold(
    policy: ScalingPolicy,
    hosts: SessionHost[]
  ): { hostName: string; action: ScalingActionType; reason: string }[] {
    const config = policy.dynamicConfig!;
    const runningHosts = hosts.filter((h) => h.status === "Available");
    const stoppedHosts = hosts.filter((h) => h.status !== "Available");
    const totalSessions = runningHosts.reduce((sum, h) => sum + h.sessions, 0);
    const avgSessionsPerHost = runningHosts.length > 0 ? totalSessions / runningHosts.length : 0;

    const actions: { hostName: string; action: ScalingActionType; reason: string }[] = [];

    if (
      avgSessionsPerHost >= config.sessionsPerHostScaleOutThreshold &&
      runningHosts.length < config.maxRunningHosts
    ) {
      const toStart = Math.min(stoppedHosts.length, config.maxRunningHosts - runningHosts.length);
      for (const h of stoppedHosts.slice(0, toStart)) {
        actions.push({
          hostName: h.name,
          action: "start_host",
          reason: `avg sessions/host ${avgSessionsPerHost.toFixed(2)} >= threshold ${config.sessionsPerHostScaleOutThreshold}`,
        });
      }
    } else if (runningHosts.length > config.minRunningHosts) {
      const idle = runningHosts.filter((h) => h.sessions === 0);
      const maxToStop = runningHosts.length - config.minRunningHosts;
      for (const h of idle.slice(0, maxToStop)) {
        actions.push({
          hostName: h.name,
          action: "deallocate_host",
          reason: "idle host above minRunningHosts floor",
        });
      }
    }
    return actions;
  }

  private applySafetyCaps(
    policy: ScalingPolicy,
    desiredActions: { hostName: string; action: ScalingActionType; reason: string }[],
    costPerHostUsdPerHour: number,
    now: Date
  ): ScalingDecision {
    const caps = policy.safetyCaps;
    let actions = desiredActions;
    let clampedBySafetyCaps = false;
    let clampReason: string | null = null;

    if (actions.length > caps.maxHostsPerAction) {
      clampedBySafetyCaps = true;
      clampReason = `desired ${actions.length} host actions exceeds maxHostsPerAction cap of ${caps.maxHostsPerAction}; clamped`;
      actions = actions.slice(0, caps.maxHostsPerAction);
    }

    const startCount = actions.filter((a) => a.action === "start_host").length;
    const stopCount = actions.filter((a) => a.action === "deallocate_host" || a.action === "stop_host").length;
    let estimatedCostDeltaUsdPerHour = (startCount - stopCount) * costPerHostUsdPerHour;

    if (Math.abs(estimatedCostDeltaUsdPerHour) > caps.maxCostDeltaPerActionUsdPerHour) {
      // Trim actions of the dominant type until within cap.
      const isScaleOut = estimatedCostDeltaUsdPerHour > 0;
      const maxUnits = Math.floor(caps.maxCostDeltaPerActionUsdPerHour / costPerHostUsdPerHour);
      const dominantType: ScalingActionType = isScaleOut ? "start_host" : "deallocate_host";
      const dominant = actions.filter((a) => a.action === dominantType).slice(0, Math.max(maxUnits, 0));
      const others = actions.filter((a) => a.action !== dominantType);
      actions = [...others, ...dominant];
      clampedBySafetyCaps = true;
      clampReason = `${clampReason ? clampReason + "; " : ""}estimated cost delta exceeded maxCostDeltaPerActionUsdPerHour cap of ${caps.maxCostDeltaPerActionUsdPerHour}; clamped to ${dominant.length} ${dominantType} action(s)`;
      const newStart = actions.filter((a) => a.action === "start_host").length;
      const newStop = actions.filter((a) => a.action === "deallocate_host" || a.action === "stop_host").length;
      estimatedCostDeltaUsdPerHour = (newStart - newStop) * costPerHostUsdPerHour;
    }

    return {
      hostPoolId: policy.hostPoolId,
      policyId: policy.id,
      actions,
      estimatedCostDeltaUsdPerHour,
      clampedBySafetyCaps,
      clampReason,
      evaluatedAt: now.toISOString(),
    };
  }
}
