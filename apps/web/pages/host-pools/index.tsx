import { useEffect, useState } from "react";
import { createHostPool, deleteHostPool, listHostPools, HostPoolRow } from "../../lib/api";
import { useTenantId } from "../../lib/useTenantId";

export default function HostPools() {
  const [tenantId] = useTenantId();
  const [pools, setPools] = useState<HostPoolRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [form, setForm] = useState({
    subscriptionId: "",
    resourceGroup: "",
    name: "",
    location: "eastus",
    hostPoolType: "Pooled",
    loadBalancerType: "BreadthFirst",
    maxSessionLimit: 10,
  });
  const [warning, setWarning] = useState("");

  async function refresh() {
    if (!tenantId) return;
    setLoading(true);
    setError("");
    try {
      setPools(await listHostPools(tenantId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function handleCreate() {
    setError("");
    setWarning("");
    try {
      const created = await createHostPool(tenantId, form as any);
      if (created.warning) setWarning(created.warning);
      setShowForm(false);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(id: string) {
    setError("");
    try {
      await deleteHostPool(tenantId, id);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!tenantId) {
    return (
      <div>
        <h1>Host Pools</h1>
        <p className="warn">No tenant selected. Complete <a href="/onboarding">Onboarding</a> first.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Host Pools</h1>
      <p>Tenant: <span className="mono">{tenantId}</span></p>
      {error && <p className="err">{error}</p>}
      {warning && <p className="warn">{warning}</p>}

      <button onClick={() => setShowForm((s) => !s)}>{showForm ? "Cancel" : "+ New host pool"}</button>

      {showForm && (
        <div className="card" style={{ marginTop: 16 }}>
          <label>Subscription ID</label>
          <input value={form.subscriptionId} onChange={(e) => setForm({ ...form, subscriptionId: e.target.value })} />
          <label>Resource group</label>
          <input value={form.resourceGroup} onChange={(e) => setForm({ ...form, resourceGroup: e.target.value })} />
          <label>Name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <label>Location</label>
          <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          <label>Host pool type</label>
          <select value={form.hostPoolType} onChange={(e) => setForm({ ...form, hostPoolType: e.target.value })}>
            <option value="Pooled">Pooled</option>
            <option value="Personal">Personal</option>
          </select>
          <label>Load balancer type</label>
          <select value={form.loadBalancerType} onChange={(e) => setForm({ ...form, loadBalancerType: e.target.value })}>
            <option value="BreadthFirst">BreadthFirst</option>
            <option value="DepthFirst">DepthFirst</option>
            <option value="Persistent">Persistent</option>
          </select>
          <label>Max session limit</label>
          <input
            type="number"
            value={form.maxSessionLimit}
            onChange={(e) => setForm({ ...form, maxSessionLimit: Number(e.target.value) })}
          />
          <button onClick={handleCreate}>Create</button>
        </div>
      )}

      {loading ? (
        <p>Loading…</p>
      ) : pools.length === 0 ? (
        <p>No host pools yet.</p>
      ) : (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>LB</th>
              <th>Location</th>
              <th>Max sessions</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pools.map((p) => (
              <tr key={p.id}>
                <td>
                  <a href={`/host-pools/${p.id}`}>{p.name}</a>
                </td>
                <td>{p.host_pool_type}</td>
                <td>{p.load_balancer_type}</td>
                <td>{p.location}</td>
                <td>{p.max_session_limit}</td>
                <td>
                  <button className="secondary" onClick={() => handleDelete(p.id)}>
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
