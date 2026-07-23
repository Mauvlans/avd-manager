import { useEffect, useState } from "react";
import SettingsLayout from "../components/SettingsLayout";
import { getOnboardingRegistry, SubscriptionsRegistryRow } from "../lib/api";
import { useTenantId } from "../lib/useTenantId";

/**
 * Settings > General — landing tab, now including an "Onboarded
 * Subscriptions" section per Adam's request. Lists every subscription
 * this tenant has granted RBAC/Graph consent for, showing the real
 * Azure subscription displayName (e.g. "MSFT - External Sub - Mauvlan")
 * — the same subscription_display_name field Host Pools' table already
 * uses — rather than a raw GUID, plus each subscription's consent/RBAC
 * grant status and resource group scope at a glance.
 */
export default function Settings() {
  const [tenantId] = useTenantId();
  const [registryRows, setRegistryRows] = useState<SubscriptionsRegistryRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tenantId) return;
    setLoading(true);
    setError("");
    getOnboardingRegistry(tenantId)
      .then((rows) => setRegistryRows(rows.filter((r) => r.subscription_id)))
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [tenantId]);

  return (
    <SettingsLayout>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Onboarded Subscriptions</h2>
        <p>
          Every Azure subscription this tenant has granted Graph consent and/or an RBAC role to.
          Manage which resource groups within each are actively monitored under{" "}
          <a href="/settings/monitored-resource-groups">Monitored Resource Groups</a>.
        </p>
        {error && <p className="err">{error}</p>}
        {!tenantId ? (
          <p className="warn">No tenant selected. Complete <a href="/onboarding">Onboarding</a> first.</p>
        ) : loading ? (
          <p>Loading…</p>
        ) : registryRows.length === 0 ? (
          <p>No subscriptions onboarded yet — complete the RBAC deployment step in Onboarding.</p>
        ) : (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Subscription</th>
                <th>Graph consent</th>
                <th>RBAC grant</th>
                <th>Resource groups</th>
                <th>Last verified</th>
              </tr>
            </thead>
            <tbody>
              {registryRows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.subscription_display_name || r.subscription_id}
                    <br />
                    <span className="mono" style={{ fontSize: 12 }}>{r.subscription_id}</span>
                  </td>
                  <td>{r.graph_consent_status}</td>
                  <td>{r.rbac_grant_status}</td>
                  <td>{r.resource_groups.length > 0 ? r.resource_groups.join(", ") : "—"}</td>
                  <td>{r.rbac_last_verified_at ? new Date(r.rbac_last_verified_at).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Onboarding</h2>
        <p>
          Register a new customer tenant: Graph admin consent, Deploy-to-Azure RBAC role deployment,
          and live grant-status tracking.
        </p>
        <a href="/onboarding">Go to Onboarding →</a>
      </div>
    </SettingsLayout>
  );
}
