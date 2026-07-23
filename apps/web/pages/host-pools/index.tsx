import { useEffect, useState } from "react";
import { deleteHostPool, listHostPools, HostPoolRow } from "../../lib/api";
import { useTenantId } from "../../lib/useTenantId";
import HostPoolsLayout from "../../components/HostPoolsLayout";

/**
 * Host Pools — list/manage existing host pools. Creation now happens
 * exclusively via Deploy > Template (or Deploy > Bicep for a custom
 * template) — this page's old inline "+ New host pool" form (plain
 * free-text Subscription ID / Location inputs, no dropdowns) was retired
 * per Adam's direction, since Deploy already covers creation with the
 * better UX (subscription dropdown sourced from the registry, region
 * dropdown sourced from Settings > Service Variables, right-side slide-out
 * panel) and keeping both around risked the two flows drifting apart.
 */
export default function HostPools() {
  const [tenantId] = useTenantId();
  const [pools, setPools] = useState<HostPoolRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
      <HostPoolsLayout>
        <p className="warn">No tenant selected. Complete <a href="/onboarding">Onboarding</a> first.</p>
      </HostPoolsLayout>
    );
  }

  return (
    <HostPoolsLayout>
      <p>Tenant: <span className="mono">{tenantId}</span></p>
      {error && <p className="err">{error}</p>}

      <a href="/deploy">
        <button>+ New Host Pool (via Deploy)</button>
      </a>

      {loading ? (
        <p>Loading…</p>
      ) : pools.length === 0 ? (
        <p>
          No host pools yet. Head to <a href="/deploy">Deploy</a> to create one from a template.
        </p>
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
    </HostPoolsLayout>
  );
}
