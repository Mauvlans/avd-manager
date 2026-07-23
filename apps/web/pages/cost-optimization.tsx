import { useEffect, useState } from "react";
import {
  triggerResourceCollection,
  listResources,
  getResourceSummary,
  listCollectionRuns,
  ResourceRow,
  ResourceTypeSummary,
  CollectionRunRow,
} from "../lib/api";
import { useTenantId } from "../lib/useTenantId";

/**
 * Cost Optimization — Phase 1 (per Adam's plan, message.txt): resource
 * inventory, the foundation everything else in the plan builds on
 * ("Discover AVD and supporting Azure resources" is step 1 of the
 * product objective). Real Azure Resource Graph collection (§ 4.1), real
 * Postgres upserts, real RLS — not simulated data. Later phases (cost
 * import, telemetry, recommendation engine) build on this table.
 */
export default function CostOptimization() {
  const [tenantId] = useTenantId();
  const [resources, setResources] = useState<ResourceRow[]>([]);
  const [summary, setSummary] = useState<ResourceTypeSummary[]>([]);
  const [runs, setRuns] = useState<CollectionRunRow[]>([]);
  const [typeFilter, setTypeFilter] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [collectResult, setCollectResult] = useState<{ discovered: number; inserted: number; updated: number; softDeleted: number } | null>(null);

  async function refresh() {
    if (!tenantId) return;
    setLoading(true);
    setError("");
    try {
      const [resourceRows, summaryRows, runRows] = await Promise.all([
        listResources(tenantId, typeFilter ? { resourceType: typeFilter } : undefined),
        getResourceSummary(tenantId),
        listCollectionRuns(tenantId),
      ]);
      setResources(resourceRows);
      setSummary(summaryRows);
      setRuns(runRows);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, typeFilter]);

  async function handleCollect() {
    if (!tenantId) return;
    setCollecting(true);
    setError("");
    setCollectResult(null);
    try {
      const result = await triggerResourceCollection(tenantId);
      setCollectResult(result);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCollecting(false);
    }
  }

  if (!tenantId) {
    return (
      <div>
        <h1>Cost Optimization</h1>
        <p className="warn">No tenant selected. Complete <a href="/onboarding">Onboarding</a> first.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Cost Optimization</h1>
      <p className="warn">
        Phase 1 foundation: resource inventory via real Azure Resource Graph queries across every
        RBAC-granted subscription. This is the discovery layer the cost/telemetry/recommendation
        phases build on — read-only, no changes made to your environment.
      </p>
      {error && <p className="err">{error}</p>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Run Inventory Collection</h2>
        <p>Queries Azure Resource Graph across every subscription this tenant has an active RBAC grant for.</p>
        <button onClick={handleCollect} disabled={collecting}>
          {collecting ? "Collecting…" : "Run Collection Now"}
        </button>
        {collectResult && (
          <p style={{ marginTop: 8 }}>
            Discovered {collectResult.discovered} resource(s) — {collectResult.inserted} new,{" "}
            {collectResult.updated} updated, {collectResult.softDeleted} no longer present.
          </p>
        )}
      </div>

      {summary.length > 0 && (
        <div className="overview-grid" style={{ marginTop: 16 }}>
          {summary.map((s) => (
            <div key={s.resource_type} className="overview-card">
              <div style={{ fontSize: 12, opacity: 0.7 }}>{s.resource_type.split("/").pop()}</div>
              <div style={{ fontSize: 28, fontWeight: 600 }}>{s.count}</div>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <label>Filter by resource type</label>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {summary.map((s) => (
            <option key={s.resource_type} value={s.resource_type}>
              {s.resource_type}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : resources.length === 0 ? (
        <p>No resources discovered yet. Run a collection above.</p>
      ) : (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Resource Group</th>
              <th>Location</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {resources.map((r) => (
              <tr key={r.id}>
                <td>{r.resource_name}</td>
                <td className="mono" style={{ fontSize: 12 }}>{r.resource_type}</td>
                <td>{r.resource_group}</td>
                <td>{r.location}</td>
                <td>{new Date(r.last_seen_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {runs.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Recent Collection Runs</h2>
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Records</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.started_at).toLocaleString()}</td>
                  <td>{r.status}</td>
                  <td>{r.record_count ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
