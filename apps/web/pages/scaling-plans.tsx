import { useEffect, useState } from "react";
import {
  attachScalingPlanToHostPool,
  createOrUpdateScalingPlan,
  deleteScalingPlan,
  detachScalingPlanFromHostPool,
  listScalingPlans,
  ScalingPlanRow,
} from "../lib/api";
import { useTenantId } from "../lib/useTenantId";

/**
 * Manages native Azure AVD Scaling Plans (Microsoft.DesktopVirtualization/
 * scalingPlans) via ARM — replaces the retired custom scaling-policy
 * config UI. There is no local DB table backing this page's data; every
 * list/create/attach call goes straight through the API's thin ARM
 * wrapper (armScalingPlanClient.ts) to Azure, matching Adam's decision not
 * to duplicate Azure's own scheduling logic.
 *
 * Scoped to subscriptionId + resourceGroup (an ARM concept), not to a
 * single host pool the way the old scaling-policy form was — a plan
 * attaches to one or more host pools via its hostPoolReferences array.
 */
export default function ScalingPlans() {
  const [tenantId] = useTenantId();
  const [subscriptionId, setSubscriptionId] = useState("");
  const [resourceGroup, setResourceGroup] = useState("");
  const [plans, setPlans] = useState<ScalingPlanRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [form, setForm] = useState({
    name: "",
    location: "eastus",
    friendlyName: "",
    timeZone: "UTC",
    hostPoolType: "Pooled" as "Pooled" | "Personal",
  });

  const [attachForm, setAttachForm] = useState({ planName: "", hostPoolArmPath: "" });

  async function refresh() {
    if (!tenantId || !subscriptionId || !resourceGroup) return;
    setLoading(true);
    setError("");
    try {
      setPlans(await listScalingPlans(tenantId, subscriptionId, resourceGroup));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, subscriptionId, resourceGroup]);

  // A minimal default single-schedule config — enough to create a valid
  // native scaling plan without asking an admin to hand-author every
  // ramp-up/peak/ramp-down field on first use; the full schedule shape
  // (see armScalingPlanClient.ts ScalingPlanSchedule) can still be edited
  // directly against ARM once created.
  function defaultSchedule() {
    return {
      name: "Weekdays",
      daysOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      rampUpStartTime: { hour: 6, minute: 0 },
      rampUpLoadBalancingAlgorithm: "BreadthFirst" as const,
      rampUpMinimumHostsPct: 20,
      rampUpCapacityThresholdPct: 60,
      peakStartTime: { hour: 9, minute: 0 },
      peakLoadBalancingAlgorithm: "BreadthFirst" as const,
      rampDownStartTime: { hour: 18, minute: 0 },
      rampDownLoadBalancingAlgorithm: "DepthFirst" as const,
      rampDownMinimumHostsPct: 10,
      rampDownCapacityThresholdPct: 90,
      rampDownForceLogoffUsers: false,
      rampDownWaitTimeMinutes: 30,
      rampDownStopHostsWhen: "ZeroSessions" as const,
      offPeakStartTime: { hour: 20, minute: 0 },
      offPeakLoadBalancingAlgorithm: "DepthFirst" as const,
    };
  }

  async function handleCreate() {
    setError("");
    try {
      await createOrUpdateScalingPlan(tenantId, form.name, {
        subscriptionId,
        resourceGroup,
        location: form.location,
        friendlyName: form.friendlyName || undefined,
        timeZone: form.timeZone,
        hostPoolType: form.hostPoolType,
        schedules: [defaultSchedule()],
        hostPoolReferences: [],
      });
      setShowForm(false);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(name: string) {
    setError("");
    try {
      await deleteScalingPlan(tenantId, name, subscriptionId, resourceGroup);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleAttach() {
    setError("");
    try {
      await attachScalingPlanToHostPool(tenantId, attachForm.planName, {
        subscriptionId,
        resourceGroup,
        hostPoolArmPath: attachForm.hostPoolArmPath,
        scalingPlanEnabled: true,
      });
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDetach(planName: string, hostPoolArmPath: string) {
    setError("");
    try {
      await detachScalingPlanFromHostPool(tenantId, planName, { subscriptionId, resourceGroup, hostPoolArmPath });
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!tenantId) {
    return (
      <div>
        <h1>Scaling Plans</h1>
        <p className="warn">No tenant selected. Complete <a href="/onboarding">Onboarding</a> first.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Scaling Plans</h1>
      <p className="warn">
        These are Azure's own native AVD Scaling Plans (Microsoft.DesktopVirtualization/scalingPlans),
        managed here via thin ARM wrappers — not a custom scheduler. Ramp-up/peak/ramp-down/off-peak
        scheduling is executed by Azure itself; this page only lets you view, create, and attach plans
        to host pools.
      </p>
      <p>Tenant: <span className="mono">{tenantId}</span></p>

      <div className="card">
        <label>Subscription ID</label>
        <input value={subscriptionId} onChange={(e) => setSubscriptionId(e.target.value)} />
        <label>Resource group</label>
        <input value={resourceGroup} onChange={(e) => setResourceGroup(e.target.value)} />
      </div>

      {error && <p className="err">{error}</p>}

      <button onClick={() => setShowForm((s) => !s)} disabled={!subscriptionId || !resourceGroup}>
        {showForm ? "Cancel" : "+ New scaling plan"}
      </button>

      {showForm && (
        <div className="card" style={{ marginTop: 16 }}>
          <label>Name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <label>Friendly name</label>
          <input value={form.friendlyName} onChange={(e) => setForm({ ...form, friendlyName: e.target.value })} />
          <label>Location</label>
          <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          <label>Time zone</label>
          <input value={form.timeZone} onChange={(e) => setForm({ ...form, timeZone: e.target.value })} />
          <label>Host pool type</label>
          <select value={form.hostPoolType} onChange={(e) => setForm({ ...form, hostPoolType: e.target.value as any })}>
            <option value="Pooled">Pooled</option>
            <option value="Personal">Personal</option>
          </select>
          <button onClick={handleCreate} disabled={!form.name}>Create</button>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Attach a plan to a host pool</h3>
        <label>Scaling plan name</label>
        <input value={attachForm.planName} onChange={(e) => setAttachForm({ ...attachForm, planName: e.target.value })} />
        <label>Host pool ARM resource id</label>
        <input
          placeholder="/subscriptions/.../resourceGroups/.../providers/Microsoft.DesktopVirtualization/hostPools/..."
          value={attachForm.hostPoolArmPath}
          onChange={(e) => setAttachForm({ ...attachForm, hostPoolArmPath: e.target.value })}
        />
        <button onClick={handleAttach} disabled={!attachForm.planName || !attachForm.hostPoolArmPath}>
          Attach
        </button>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : plans.length === 0 ? (
        <p>No scaling plans found for this subscription/resource group.</p>
      ) : (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Time zone</th>
              <th>Host pool type</th>
              <th>Attached host pools</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.timeZone}</td>
                <td>{p.hostPoolType}</td>
                <td>
                  {p.hostPoolReferences.length === 0
                    ? "—"
                    : p.hostPoolReferences.map((r) => (
                        <div key={r.hostPoolArmPath}>
                          {r.hostPoolArmPath.split("/").pop()} ({r.scalingPlanEnabled ? "enabled" : "disabled"}){" "}
                          <button className="secondary" onClick={() => handleDetach(p.name, r.hostPoolArmPath)}>
                            Detach
                          </button>
                        </div>
                      ))}
                </td>
                <td>
                  <button className="secondary" onClick={() => handleDelete(p.name)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
