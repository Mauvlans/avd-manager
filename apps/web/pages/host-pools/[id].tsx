import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import {
  deallocateSessionHost,
  getHostPool,
  HostPoolRow,
  listSessionHosts,
  SessionHostRow,
  startSessionHost,
} from "../../lib/api";
import { useTenantId } from "../../lib/useTenantId";

/**
 * Scaling-policy CRUD used to live on this page (custom engine, retired —
 * see apps/api/src/routes/scalingPlans.ts's header comment). Native AVD
 * Scaling Plans are managed on their own page (/scaling-plans) since they
 * are ARM resources scoped to subscription+resourceGroup, not something
 * that hangs off a single host pool the way the old DB-backed policies
 * did — a plan can (and normally does) apply to several host pools via
 * its hostPoolReferences array.
 */
export default function HostPoolDetail() {
  const router = useRouter();
  const id = router.query.id as string | undefined;
  const [tenantId] = useTenantId();
  const [pool, setPool] = useState<HostPoolRow | null>(null);
  const [sessionHosts, setSessionHosts] = useState<SessionHostRow[]>([]);
  const [sessionHostsError, setSessionHostsError] = useState("");
  const [sessionHostActionPending, setSessionHostActionPending] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function refresh() {
    if (!tenantId || !id) return;
    setError("");
    try {
      const p = await getHostPool(tenantId, id);
      setPool(p);
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
        ARM long-running-operation polling) used elsewhere in this app. In this sandbox (no live
        Azure subscription/RBAC grant), ARM calls will fail with the FakeTokenProvider's token;
        that failure is surfaced below, not hidden.
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

      <h2>Scaling</h2>
      <p className="warn">
        Autoscaling for this host pool is managed via native Azure AVD Scaling Plans, not a custom
        engine — see the <a href="/scaling-plans">Scaling Plans</a> page to view, create, or attach
        a plan to this host pool (subscription: <span className="mono">{pool.subscription_id}</span>,
        resource group: {pool.resource_group}).
      </p>
    </div>
  );
}
