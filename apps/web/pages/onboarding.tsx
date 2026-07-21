import { useEffect, useState } from "react";
import { createTenant, getGraphConsentUrl, getDeployToAzureUrl } from "../lib/api";
import { useTenantId } from "../lib/useTenantId";

/**
 * Tenant onboarding wizard, mirroring the flow implemented in
 * apps/api/src/services/onboardingService.ts + routes/onboarding.ts:
 *   1. Create tenant row (POST /api/onboarding/tenants)
 *   2. Get + visit Graph admin-consent URL (grant a)
 *   3. Get + visit Deploy-to-Azure Bicep RBAC template URL (grant b)
 *   4. Poll subscriptions_registry (via host-pools/scaling-policies calls
 *      once host pools exist) — for MVP we surface grant status by having
 *      the admin manually confirm/re-check, since there is no dedicated
 *      "get registry status" GET route yet (see PROGRESS.md: gap to add
 *      GET /api/onboarding/tenants/:id/registry).
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
          <p className="warn">
            The API records grant status via callback endpoints
            (POST /api/onboarding/graph-consent/callback and /api/onboarding/rbac-grant/callback)
            once the customer completes each step, but there is currently no dedicated
            "read current registry status" GET route to poll here — this is a known gap (see
            PROGRESS.md). For now, confirm grant completion via the Audit Log page, which will
            show <span className="mono">graph_consent_granted</span> / <span className="mono">rbac_granted</span> entries once
            the callbacks fire.
          </p>
          <a href="/audit-log">Go to Audit Log →</a>
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
