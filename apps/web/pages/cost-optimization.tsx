import { useEffect, useState } from "react";
import {
  triggerResourceCollection,
  listResources,
  getResourceSummary,
  listCollectionRuns,
  triggerTelemetryCollection,
  triggerCostIngestion,
  getCostSummary,
  getCostByService,
  evaluateRecommendations,
  listRecommendations,
  dismissRecommendation,
  ResourceRow,
  ResourceTypeSummary,
  CollectionRunRow,
  CostSummaryRow,
  CostByServiceRow,
  RecommendationRow,
} from "../lib/api";
import { useTenantId } from "../lib/useTenantId";

/**
 * Cost Optimization — per Adam's plan (message.txt). Real Azure data
 * throughout: Resource Graph inventory (Phase 1), Cost Management +
 * Azure Monitor telemetry (Phase 2/3), and a real recommendation engine
 * evaluated against that collected data (Phase 4). Read-only.
 */
export default function CostOptimization() {
  const [tenantId] = useTenantId();
  const [resources, setResources] = useState<ResourceRow[]>([]);
  const [summary, setSummary] = useState<ResourceTypeSummary[]>([]);
  const [runs, setRuns] = useState<CollectionRunRow[]>([]);
  const [costSummary, setCostSummary] = useState<CostSummaryRow[]>([]);
  const [costByService, setCostByService] = useState<CostByServiceRow[]>([]);
  const [recommendations, setRecommendations] = useState<RecommendationRow[]>([]);
  const [typeFilter, setTypeFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  async function refresh() {
    if (!tenantId) return;
    try {
      const [resourceRows, summaryRows, runRows, costRows, costServiceRows, recRows] = await Promise.all([
        listResources(tenantId, typeFilter ? { resourceType: typeFilter } : undefined),
        getResourceSummary(tenantId),
        listCollectionRuns(tenantId),
        getCostSummary(tenantId).catch(() => []),
        getCostByService(tenantId).catch(() => []),
        listRecommendations(tenantId).catch(() => []),
      ]);
      setResources(resourceRows);
      setSummary(summaryRows);
      setRuns(runRows);
      setCostSummary(costRows);
      setCostByService(costServiceRows);
      setRecommendations(recRows);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, typeFilter]);

  async function run(action: string, fn: () => Promise<unknown>) {
    if (!tenantId) return;
    setBusy(action);
    setError("");
    setLastResult(null);
    try {
      const result = await fn();
      setLastResult(JSON.stringify(result));
      await refresh();
    } catch (err) {
      setError(`${action}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleDismiss(id: string) {
    if (!tenantId) return;
    await dismissRecommendation(tenantId, id);
    refresh();
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
        Real Azure data throughout — resource inventory (Resource Graph), cost (Cost Management),
        telemetry (Azure Monitor + AVD session state), and recommendations evaluated against that
        real data. Read-only: nothing here changes your Azure environment.
      </p>
      {error && <p className="err">{error}</p>}
      {lastResult && <p style={{ fontSize: 12, opacity: 0.7 }}>{lastResult}</p>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Collection</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => run("resources", () => triggerResourceCollection(tenantId))} disabled={busy !== null}>
            {busy === "resources" ? "Collecting…" : "Run Resource Inventory"}
          </button>
          <button onClick={() => run("telemetry", () => triggerTelemetryCollection(tenantId))} disabled={busy !== null}>
            {busy === "telemetry" ? "Collecting…" : "Run Telemetry Collection"}
          </button>
          <button onClick={() => run("cost", () => triggerCostIngestion(tenantId))} disabled={busy !== null}>
            {busy === "cost" ? "Ingesting…" : "Run Cost Ingestion"}
          </button>
          <button onClick={() => run("recommendations", () => evaluateRecommendations(tenantId))} disabled={busy !== null}>
            {busy === "recommendations" ? "Evaluating…" : "Evaluate Recommendations"}
          </button>
        </div>
      </div>

      {recommendations.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Recommendations ({recommendations.length} open)</h2>
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Category</th>
                <th>Severity</th>
                <th>Est. Monthly Savings</th>
                <th>Confidence</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {recommendations.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.title}</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>{r.summary}</div>
                  </td>
                  <td>{r.category}</td>
                  <td>{r.severity}</td>
                  <td>
                    {r.estimated_monthly_savings !== null
                      ? `${r.currency ?? ""} ${Number(r.estimated_monthly_savings).toFixed(2)}`
                      : "not yet quantified"}
                  </td>
                  <td>{Number(r.confidence_score).toFixed(0)}%</td>
                  <td>
                    <button onClick={() => handleDismiss(r.id)}>Dismiss</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {costSummary.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Cost by Month (Amortized)</h2>
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Total Cost</th>
              </tr>
            </thead>
            <tbody>
              {costSummary.map((c) => (
                <tr key={c.month}>
                  <td>{c.month}</td>
                  <td>{c.currency} {Number(c.total_cost).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {costByService.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Cost by Service</h2>
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Total Cost</th>
              </tr>
            </thead>
            <tbody>
              {costByService.map((c, i) => (
                <tr key={i}>
                  <td>{c.service_family ?? "(uncategorized)"}</td>
                  <td>{c.currency} {Number(c.total_cost).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
        <label>Filter resources by type</label>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {summary.map((s) => (
            <option key={s.resource_type} value={s.resource_type}>
              {s.resource_type}
            </option>
          ))}
        </select>
      </div>

      {resources.length === 0 ? (
        <p>No resources discovered yet. Run collection above.</p>
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
                <th>Type</th>
                <th>Status</th>
                <th>Records</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.started_at).toLocaleString()}</td>
                  <td>{r.collector_type}</td>
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
