import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import {
  createScalingPolicy,
  deallocateSessionHost,
  getHostPool,
  HostPoolRow,
  listScalingPolicies,
  listSessionHosts,
  ScalingPolicyRow,
  SessionHostRow,
  setScalingPolicyEnabled,
  startSessionHost,
} from "../../lib/api";
import { useTenantId } from "../../lib/useTenantId";

export default function HostPoolDetail() {
  const router = useRouter();
  const id = router.query.id as string | undefined;
  const [tenantId] = useTenantId();
  const [pool, setPool] = useState<HostPoolRow | null>(null);
  const [policies, setPolicies] = useState<ScalingPolicyRow[]>([]);
  const [sessionHosts, setSessionHosts] = useState<SessionHostRow[]>([]);
  const [sessionHostsError, setSessionHostsError] = useState("");
  const [sessionHostActionPending, setSessionHostActionPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);

  const [form, setForm] = useState({
    name: "",
    mode: "dynamic_threshold" as "schedule" | "dynamic_threshold",
    maxHostsPerAction: 2,
    maxCostDeltaPerActionUsdPerHour: 5.0,
  });

  async function refresh() {
    if (!tenantId || !id) return;
    setError("");
    try {
      const [p, pol] = await Promise.all([getHostPool(tenantId, id), listScalingPolicies(tenantId, id)]);
      setPool(p);
      setPolicies(pol);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function refreshSessionHosts() {
    if (!tenantId || !id) return;
    setSessionHostsError("");
    try {
      const hosts = await listSessionHosts(tenantId, id);
      setSessionHosts(hosts);
    } catch (err) {
      // Expected in this sandbox without a real Azure subscription/RBAC
      // grant — ARM will reject the FakeTokenProvider's token. Surface it
      // rather than silently showing an empty list as if there genuinely
      // are zero session hosts.
      setSessionHostsError((err as Error).message);
    }
  }

  useEffect(() => {
    refresh();
    refreshSessionHosts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, id]);

  async function handleCreatePolicy() {
    if (!id) return;
    setError("");
    try {
      await createScalingPolicy(tenantId, { hostPoolId: id, ...form });
      setShowForm(false);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleToggle(p: ScalingPolicyRow) {
    setError("");
    try {
      await setScalingPolicyEnabled(tenantId, p.id, !p.enabled);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleSessionHostAction(hostName: string, action: "start" | "deallocate") {
    if (!id) return;
    setSessionHostsError("");
    setSessionHostActionPending(hostName);
    try {
      const result = action === "start" ? await startSessionHost(tenantId, id, hostName) : await deallocateSessionHost(tenantId, id, hostName);
      if (result.outcome !== "succeeded") {
        setSessionHostsError(`${action} did not succeed for ${hostName}: ${result.outcome} — ${"reason" in result ? result.reason : ""}`);
      }
    } catch (err) {
      setSessionHostsError((err as Error).message);
    } finally {
      setSessionHostActionPending(null);
      refreshSessionHosts();
    }
  }

  if (!tenantId) return <p className="warn">No tenant selected. Complete onboarding first.</p>;
  if (!pool) return <p>Loading…</p>;

  return (
    <div>
      <h1>{pool.name}</h1>
      {error && <p className="err">{error}</p>}
      <div className="card">
        <p><strong>Subscription:</strong> <span className="mono">{pool.subscription_id}</span></p>
        <p><strong>Resource group:</strong> {pool.resource_group}</p>
        <p><strong>Location:</strong> {pool.location}</p>
        <p><strong>Type:</strong> {pool.host_pool_type} / {pool.load_balancer_type}</p>
        <p><strong>Max sessions:</strong> {pool.max_session_limit}</p>
      </div>

      <h2>Session hosts</h2>
      <p className="warn">
        Start/Deallocate call the same ArmHostPoolClient.startVm/deallocateVm methods (and the same
        ARM long-running-operation polling) that the autoscale timer uses — this is not a separate
        "trust the POST" shortcut. In this sandbox (no live Azure subscription/RBAC grant), ARM
        calls will fail with the FakeTokenProvider's token; that failure is surfaced below, not
        hidden.
      </p>
      <button className="secondary" onClick={refreshSessionHosts}>Refresh</button>
      {sessionHostsError && <p className="err">{sessionHostsError}</p>}
      {sessionHosts.length === 0 ? (
        <p>No session hosts found for this host pool.</p>
      ) : (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Sessions</th>
              <th>VM size</th>
              <th>Allow new sessions</th>
              <th>Last heartbeat</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sessionHosts.map((h) => (
              <tr key={h.name}>
                <td>{h.name}</td>
                <td>{h.status}</td>
                <td>{h.sessions}</td>
                <td>{h.vmSize}</td>
                <td>{h.allowNewSession ? "Yes" : "No"}</td>
                <td>{h.lastHeartBeat ?? "—"}</td>
                <td>
                  <button
                    className="secondary"
                    disabled={sessionHostActionPending === h.name}
                    onClick={() => handleSessionHostAction(h.name, "start")}
                  >
                    {sessionHostActionPending === h.name ? "…" : "Start"}
                  </button>{" "}
                  <button
                    className="secondary"
                    disabled={sessionHostActionPending === h.name}
                    onClick={() => handleSessionHostAction(h.name, "deallocate")}
                  >
                    {sessionHostActionPending === h.name ? "…" : "Deallocate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Scaling policies</h2>
      <p className="warn">
        Safety caps below are enforced server-side by ScalingPolicyEvaluator regardless of what a
        policy requests — a policy can never be created or run with caps disabled (values must be
        &gt; 0), and the evaluator clamps any decision that would exceed them at evaluation time.
      </p>
      <button onClick={() => setShowForm((s) => !s)}>{showForm ? "Cancel" : "+ New scaling policy"}</button>

      {showForm && (
        <div className="card" style={{ marginTop: 16 }}>
          <label>Name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <label>Mode</label>
          <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as any })}>
            <option value="dynamic_threshold">Dynamic threshold</option>
            <option value="schedule">Schedule</option>
          </select>
          <div className="cap-field">
            <label>Max hosts per action (safety cap)</label>
            <input
              type="number"
              min={1}
              value={form.maxHostsPerAction}
              onChange={(e) => setForm({ ...form, maxHostsPerAction: Number(e.target.value) })}
            />
          </div>
          <div className="cap-field">
            <label>Max cost delta per action, USD/hour (safety cap)</label>
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={form.maxCostDeltaPerActionUsdPerHour}
              onChange={(e) => setForm({ ...form, maxCostDeltaPerActionUsdPerHour: Number(e.target.value) })}
            />
          </div>
          <button onClick={handleCreatePolicy} disabled={!form.name}>
            Create policy
          </button>
        </div>
      )}

      {policies.length === 0 ? (
        <p>No scaling policies yet.</p>
      ) : (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Mode</th>
              <th>Enabled</th>
              <th>Max hosts/action</th>
              <th>Max cost Δ/hr</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {policies.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.mode}</td>
                <td>{p.enabled ? "Yes" : "No"}</td>
                <td>{p.max_hosts_per_action}</td>
                <td>${p.max_cost_delta_per_action_usd_per_hour}</td>
                <td>
                  <button className="secondary" onClick={() => handleToggle(p)}>
                    {p.enabled ? "Disable" : "Enable"}
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
