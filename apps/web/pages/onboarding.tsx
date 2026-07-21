import { useEffect, useState } from "react";
import { createTenant, getGraphConsentUrl, getDeployToAzureUrl, getOnboardingRegistry, SubscriptionsRegistryRow } from "../lib/api";
import { useTenantId } from "../lib/useTenantId";

/**
 * Tenant onboarding wizard, mirroring the flow implemented in
 * apps/api/src/services/onboardingService.ts + routes/onboarding.ts:
 *   1. Create tenant row (POST /api/onboarding/tenants)
 *   2. Get + visit Graph admin-consent URL (grant a)
 *   3. Get + visit Deploy-to-Azure Bicep RBAC template URL (grant b)
 *   4. Poll GET /api/onboarding/tenants/:id/registry every few seconds to
 *      show live graph_consent_status/rbac_grant_status once the callback
 *      endpoints fire — no more linking away to the audit log.
 */
export default function Onboarding() {
  const [tenantId, setTenantId] = useTenantId();
  const [displayName, setDisplayName] = useState("");
  const [entraTenantId, setEntraTenantId] = useState("");
  const [subscriptionId, setSubscriptionId] = useState("");
  const [consentUrl, setConsentUrl] = useState("");
  const [deployUrl, setDeployUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [registryRows, setRegistryRows] = useState<SubscriptionsRegistryRow[]>([]);
  const [registryError, setRegistryError] = useState("");
  const [registryLoading, setRegistryLoading] = useState(false);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    async function poll() {
      setRegistryLoading(true);
      try {
        const rows = await getOnboardingRegistry(tenantId);
        if (!cancelled) {
          setRegistryRows(rows);
          setRegistryError("");
        }
      } catch (err) {
        if (!cancelled) setRegistryError((err as Error).message);
      } finally {
        if (!cancelled) setRegistryLoading(false);
      }
    }
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tenantId]);


  async function handleCreateTenant() {
    setError("");
    setBusy(true);
    try {
      const tenant = await createTenant({ displayName, entraTenantId });
      setTenantId(tenant.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleGetConsentUrl() {
    setError("");
    try {
      const { url } = await getGraphConsentUrl(tenantId);
      setConsentUrl(url);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleGetDeployUrl() {
    setError("");
    try {
      const { url } = await getDeployToAzureUrl(tenantId, subscriptionId || undefined);
      setDeployUrl(url);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <h1>Tenant Onboarding</h1>
      {error && <p className="err">{error}</p>}

      <div className="step">
        <div className="step-num">1</div>
        <div className="card" style={{ flex: 1 }}>
          <h2 style={{ marginTop: 0 }}>Create tenant</h2>
          <label>Display name</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Contoso Ltd" />
          <label>Customer's Entra (AAD) tenant GUID</label>
          <input
            value={entraTenantId}
            onChange={(e) => setEntraTenantId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
          <button onClick={handleCreateTenant} disabled={busy || !displayName || !entraTenantId}>
            Create tenant
          </button>
          {tenantId && (
            <p style={{ marginTop: 12 }}>
              Tenant created: <span className="mono">{tenantId}</span>
            </p>
          )}
        </div>
      </div>

      <div className="step">
        <div className="step-num">2</div>
        <div className="card" style={{ flex: 1 }}>
          <h2 style={{ marginTop: 0 }}>Graph admin consent (grant a)</h2>
          <p>
            Send the customer's Entra admin this link. It requests the Graph application
            permissions our multi-tenant app registration needs (read directory objects for host
            pool assignment lookups, etc.) — no Azure Lighthouse involved.
          </p>
          <button className="secondary" onClick={handleGetConsentUrl} disabled={!tenantId}>
            Generate admin-consent link
          </button>
          {consentUrl && (
            <p className="mono" style={{ marginTop: 12 }}>
              <a href={consentUrl} target="_blank" rel="noreferrer">
                {consentUrl}
              </a>
            </p>
          )}
        </div>
      </div>

      <div className="step">
        <div className="step-num">3</div>
        <div className="card" style={{ flex: 1 }}>
          <h2 style={{ marginTop: 0 }}>Deploy-to-Azure RBAC role (grant b)</h2>
          <p>
            The customer runs this Deploy-to-Azure template in their own subscription. It creates
            a least-privilege custom RBAC role scoped to AVD host-pool/session-host management and
            assigns it to our app's service principal — a separate grant from Graph consent above.
          </p>
          <label>Subscription ID (optional hint)</label>
          <input
            value={subscriptionId}
            onChange={(e) => setSubscriptionId(e.target.value)}
            placeholder="11111111-1111-1111-1111-111111111111"
          />
          <button className="secondary" onClick={handleGetDeployUrl} disabled={!tenantId}>
            Generate Deploy-to-Azure link
          </button>
          {deployUrl && (
            <p className="mono" style={{ marginTop: 12 }}>
              <a href={deployUrl} target="_blank" rel="noreferrer">
                {deployUrl}
              </a>
            </p>
          )}
        </div>
      </div>

      <div className="step">
        <div className="step-num">4</div>
        <div className="card" style={{ flex: 1 }}>
          <h2 style={{ marginTop: 0 }}>Grant status</h2>
          <p>
            Polls <span className="mono">GET /api/onboarding/tenants/:id/registry</span> every 5s
            once a tenant exists, showing the live <span className="mono">subscriptions_registry</span> row(s):
            Graph consent status, RBAC grant status, subscription id, resource groups in scope, and
            the last permission health-check result (from the RBAC drift-detection job).
          </p>
          {!tenantId && <p className="warn">Create a tenant in step 1 first.</p>}
          {registryError && <p className="err">{registryError}</p>}
          {tenantId && !registryError && registryRows.length === 0 && (
            <p>{registryLoading ? "Checking…" : "No subscriptions_registry rows yet — complete steps 2/3 above, or wait for the callback to fire."}</p>
          )}
          {registryRows.map((row) => (
            <div key={row.id} className="mono" style={{ marginTop: 12, borderTop: "1px solid #333", paddingTop: 8 }}>
              <div>Subscription: {row.subscription_id}</div>
              <div>Graph consent: {row.graph_consent_status}{row.graph_consent_granted_at ? ` (granted ${row.graph_consent_granted_at})` : ""}</div>
              <div>
                RBAC grant: {row.rbac_grant_status}
                {row.rbac_last_verified_at ? ` (last verified ${row.rbac_last_verified_at})` : ""}
              </div>
              {row.rbac_drift_details && <div className="err">Drift: {row.rbac_drift_details}</div>}
              <div>Resource groups in scope: {row.resource_groups.length ? row.resource_groups.join(", ") : "(none yet)"}</div>
            </div>
          ))}
          <p style={{ marginTop: 12 }}>
            Full history of these events is also in the <a href="/audit-log">Audit Log</a>.
          </p>
        </div>
      </div>


      <div className="step">
        <div className="step-num">5</div>
        <div className="card" style={{ flex: 1 }}>
          <h2 style={{ marginTop: 0 }}>Done</h2>
          <p>Once both grants show as granted in the audit log, proceed to <a href="/host-pools">Host Pools</a> to provision your first host pool.</p>
        </div>
      </div>
    </div>
  );
}
