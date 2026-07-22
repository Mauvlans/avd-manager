import { useEffect, useState } from "react";
import { useTenantId } from "../lib/useTenantId";
import {
  getOnboardingRegistry,
  listHostPools,
  listScalingPlans,
  listAuditLog,
  SubscriptionsRegistryRow,
  HostPoolRow,
  ScalingPlanRow,
  AuditLogRow,
} from "../lib/api";

/**
 * Overview / dashboard landing page — the L1 "Overview" menu item. Adam's
 * ask: "introduce a L1 menu and an Overview page for managing your
 * environment." This surfaces, at a glance, the same underlying data
 * that's currently only visible by clicking into each individual page
 * (onboarding registry status, host pool count, scaling plan count, recent
 * audit activity) — read-only summary, no new backend endpoints needed for
 * v1 since every metric here is a small slice of an existing list
 * endpoint's response.
 */
export default function Overview() {
  const [tenantId] = useTenantId();
  const [registryRows, setRegistryRows] = useState<SubscriptionsRegistryRow[]>([]);
  const [hostPools, setHostPools] = useState<HostPoolRow[]>([]);
  const [scalingPlans, setScalingPlans] = useState<ScalingPlanRow[]>([]);
  const [recentAudit, setRecentAudit] = useState<AuditLogRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tenantId) return;
    setLoading(true);
    setError("");

    // Independent fetches — a failure in one (e.g. scaling plans needing a
    // subscription/resource-group we don't have handy without a host pool
    // to derive them from) shouldn't blank out the others.
    getOnboardingRegistry(tenantId)
      .then(setRegistryRows)
      .catch((err) => setError((prev) => prev || (err as Error).message));

    listHostPools(tenantId)
      .then(setHostPools)
      .catch((err) => setError((prev) => prev || (err as Error).message));

    listAuditLog(tenantId, 5)
      .then(setRecentAudit)
      .catch(() => {
        /* non-fatal — audit log is a nice-to-have on this page */
      })
      .finally(() => setLoading(false));
  }, [tenantId]);

  // Scaling plans are scoped to subscription+resourceGroup, not just
  // tenant, so they can only be fetched once we know at least one host
  // pool's location — same constraint the scaling-plans.tsx page itself
  // has. Overview reuses the first host pool's subscription/RG as a
  // best-effort default; if there are no host pools yet, this section
  // just shows zero rather than erroring.
  useEffect(() => {
    if (!tenantId || hostPools.length === 0) return;
    const first = hostPools[0];
    listScalingPlans(tenantId, first.subscription_id, first.resource_group)
      .then(setScalingPlans)
      .catch(() => {
        /* non-fatal on Overview — the Scaling Plans page itself surfaces errors in detail */
      });
  }, [tenantId, hostPools]);

  const grant = registryRows[0];

  if (!tenantId) {
    return (
      <div>
        <h1>Overview</h1>
        <div className="card">
          <p>
            No tenant selected yet. Start with <a href="/onboarding">Onboarding</a> to register a
            customer tenant and complete the Graph consent + RBAC deployment steps — this page will
            populate once a tenant is active.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1>Overview</h1>
      <p className="mono">
        Tenant: <span>{tenantId}</span>
      </p>
      {error && <p className="err">{error}</p>}
      {loading && <p className="warn">Loading…</p>}

      <div className="overview-grid">
        <div className="overview-card">
          <div className="metric-label">Graph Consent</div>
          <div className="metric">
            <span className={`badge ${grant?.graph_consent_status ?? "not_requested"}`}>
              {grant?.graph_consent_status ?? "not_requested"}
            </span>
          </div>
        </div>
        <div className="overview-card">
          <div className="metric-label">RBAC Grant</div>
          <div className="metric">
            <span className={`badge ${grant?.rbac_grant_status ?? "not_requested"}`}>
              {grant?.rbac_grant_status ?? "not_requested"}
            </span>
          </div>
          {grant?.rbac_last_verified_at && (
            <div className="metric-label">Verified {new Date(grant.rbac_last_verified_at).toLocaleString()}</div>
          )}
        </div>
        <div className="overview-card">
          <div className="metric-label">Host Pools</div>
          <div className="metric">{hostPools.length}</div>
        </div>
        <div className="overview-card">
          <div className="metric-label">Session Hosts</div>
          <div className="metric">{hostPools.reduce((sum, h) => sum + (h.session_host_count ?? 0), 0)}</div>
        </div>
        <div className="overview-card">
          <div className="metric-label">Scaling Plans</div>
          <div className="metric">{scalingPlans.length}</div>
        </div>
      </div>

      {grant?.rbac_grant_status === "drifted" && (
        <div className="card">
          <p className="err">
            RBAC drift detected: {grant.rbac_drift_details ?? "the expected role assignment could not be verified"}
          </p>
        </div>
      )}

      <h2>Recent Activity</h2>
      <div className="card">
        {recentAudit.length === 0 ? (
          <p className="warn">No audit activity yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Resource</th>
              </tr>
            </thead>
            <tbody>
              {recentAudit.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.created_at).toLocaleString()}</td>
                  <td className="mono">{row.actor}</td>
                  <td>{row.action}</td>
                  <td className="mono">{row.resource_type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ marginTop: 12 }}>
          <a href="/audit-log">View full audit log →</a>
        </p>
      </div>
    </div>
  );
}
