import { useEffect, useState } from "react";
import { getGraphConsentUrl, getDeployToAzureUrl, getOnboardingRegistry, SubscriptionsRegistryRow } from "../lib/api";
import { useTenantId } from "../lib/useTenantId";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";

interface DeviceCodeSession {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
}

type PollOutcome =
  | { status: "pending" }
  | { status: "authorized"; accessToken: string; refreshToken?: string }
  | { status: "expired" }
  | { status: "denied"; error: string };

interface CreatedAppRegistration {
  appId: string;
  objectId: string;
  clientSecret: string;
  servicePrincipalId: string;
  adminConsentGranted: boolean;
  activated: boolean;
}

/**
 * Tenant onboarding wizard, mirroring the flow implemented in
 * apps/api/src/services/onboardingService.ts + routes/onboarding.ts:
 *   0. Platform Setup (device-code sign-in), only shown if the platform's
 *      own Entra app registration hasn't been created yet — was a separate
 *      /setup page, folded in here so there's a single wizard instead of
 *      requiring the admin to visit two pages and copy/paste a client id
 *      between them.
 *   1. Create tenant row (POST /api/onboarding/tenants)
 *   2. Get + visit Graph admin-consent URL (grant a)
 *   3. Get + visit Deploy-to-Azure Bicep RBAC template URL (grant b)
 *   4. Poll GET /api/onboarding/tenants/:id/registry every few seconds to
 *      show live graph_consent_status/rbac_grant_status once the callback
 *      endpoints fire — no more linking away to the audit log.
 */
export default function Onboarding() {
  const [tenantId, setTenantId] = useTenantId();
  const [consentNonce, setConsentNonce] = useState("");
  const [subscriptionId, setSubscriptionId] = useState("");
  const [consentUrl, setConsentUrl] = useState("");
  const [deployUrl, setDeployUrl] = useState("");
  const [deploySpObjectId, setDeploySpObjectId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [registryRows, setRegistryRows] = useState<SubscriptionsRegistryRow[]>([]);
  const [registryError, setRegistryError] = useState("");
  const [registryLoading, setRegistryLoading] = useState(false);

  // Pick up tenantId from the query string once the browser returns from
  // Microsoft's admin-consent redirect (see routes/onboarding.ts's
  // graph-consent/callback — it 302s the browser tab back here with
  // ?tenantId=...&consentDone=1 instead of returning bare JSON, since that
  // tab is a full top-level navigation, not an XHR our SPA code can read
  // directly). This is what replaces the old manual "type in a tenant
  // GUID and click Create" step entirely.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const fromRedirect = params.get("tenantId");
    const consentError = params.get("consentError");
    if (fromRedirect) {
      setTenantId(fromRedirect);
      window.history.replaceState({}, "", "/onboarding");
    } else if (consentError) {
      setError(`Graph consent redirect error: ${consentError}`);
      window.history.replaceState({}, "", "/onboarding");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Platform Setup (step 0) ---
  const [platformConfigured, setPlatformConfigured] = useState<boolean | null>(null);
  const [platformClientId, setPlatformClientId] = useState("");
  const [setupSession, setSetupSession] = useState<DeviceCodeSession | null>(null);
  const [setupStatus, setSetupStatus] = useState("");
  const [setupError, setSetupError] = useState("");
  const [setupResult, setSetupResult] = useState<CreatedAppRegistration | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);

  useEffect(() => {
    checkPlatformStatus();
  }, []);

  async function checkPlatformStatus() {
    try {
      const res = await fetch(`${API_BASE}/api/onboarding/platform-status`);
      const data = await res.json();
      setPlatformConfigured(data.configured);
      setPlatformClientId(data.clientId);
    } catch (err) {
      // Non-fatal — the rest of the wizard still works with the placeholder
      // client id if this check fails for some reason.
      setPlatformConfigured(false);
    }
  }

  async function startPlatformSetup() {
    setSetupError("");
    setSetupResult(null);
    setSetupBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/setup/device-code`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "device-code request failed");
      setSetupSession(data);
      setSetupStatus("Waiting for you to sign in…");
      pollDeviceCode(data.device_code, data.interval || 5);
    } catch (err) {
      setSetupError((err as Error).message);
      setSetupBusy(false);
    }
  }

  async function pollDeviceCode(deviceCode: string, intervalSeconds: number) {
    const attempt = async (): Promise<void> => {
      try {
        const res = await fetch(`${API_BASE}/api/setup/device-code/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode }),
        });
        const outcome: PollOutcome = await res.json();
        if (outcome.status === "pending") {
          setTimeout(attempt, intervalSeconds * 1000);
          return;
        }
        if (outcome.status === "expired") {
          setSetupError("Device code expired — click Start again.");
          setSetupBusy(false);
          return;
        }
        if (outcome.status === "denied") {
          setSetupError(`Sign-in denied: ${outcome.error}`);
          setSetupBusy(false);
          return;
        }
        setSetupStatus("Signed in — creating app registration…");
        const completeRes = await fetch(`${API_BASE}/api/setup/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken: outcome.accessToken, displayName: "AVD Manager (dev)" }),
        });
        const completeData = await completeRes.json();
        if (!completeRes.ok) throw new Error(completeData.error || "app registration creation failed");
        setSetupResult(completeData);
        setSetupStatus("Done — activated immediately, no restart needed.");
        setSetupBusy(false);
        checkPlatformStatus();
      } catch (err) {
        setSetupError((err as Error).message);
        setSetupBusy(false);
      }
    };
    attempt();
  }

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

  async function handleGetConsentUrl() {
    setError("");
    try {
      const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const { url } = await getGraphConsentUrl(nonce);
      setConsentNonce(nonce);
      setConsentUrl(url);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleGetDeployUrl() {
    setError("");
    try {
      const { url, avdManagerServicePrincipalObjectId } = await getDeployToAzureUrl(
        tenantId,
        subscriptionId || undefined
      );
      setDeployUrl(url);
      setDeploySpObjectId(avdManagerServicePrincipalObjectId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <h1>Tenant Onboarding</h1>
      {error && <p className="err">{error}</p>}

      {platformConfigured === false && (
        <div className="step">
          <div className="step-num">0</div>
          <div className="card" style={{ flex: 1 }}>
            <h2 style={{ marginTop: 0 }}>Platform Setup (one-time, run once per environment)</h2>
            <p>
              AVD Manager doesn&apos;t have its own Entra app registration yet — the admin-consent link
              below would use a placeholder client id. Sign in as a Global Admin (device-code flow, no
              password ever touches this app) to create it automatically.
            </p>
            {setupError && <p className="err">{setupError}</p>}
            <button onClick={startPlatformSetup} disabled={setupBusy}>
              Start setup (device-code sign-in)
            </button>
            {setupSession && !setupResult && (
              <div style={{ marginTop: 12 }}>
                <p>
                  Go to{" "}
                  <a href={setupSession.verification_uri} target="_blank" rel="noreferrer">
                    {setupSession.verification_uri}
                  </a>{" "}
                  and enter this code:
                </p>
                <p className="mono" style={{ fontSize: 24 }}>
                  {setupSession.user_code}
                </p>
                <p>{setupStatus}</p>
              </div>
            )}
            {setupResult && (
              <div style={{ marginTop: 12 }}>
                <p className="ok">
                  App registration created and activated immediately — the consent link in step 2 below
                  now uses it, no restart needed.
                </p>
                <p>
                  For this to survive a restart, also set these in the API&apos;s environment:
                </p>
                <pre className="mono">
                  {`ENTRA_APP_CLIENT_ID=${setupResult.appId}\nENTRA_APP_CLIENT_SECRET=${setupResult.clientSecret}`}
                </pre>
                <p className="warn">This client secret is shown once — copy it now if you want it persisted.</p>
              </div>
            )}
          </div>
        </div>
      )}
      {platformConfigured === true && (
        <p className="ok" style={{ marginBottom: 24 }}>
          Platform is configured (client id <span className="mono">{platformClientId}</span>). Consent
          links below use this real app registration.
        </p>
      )}

      <div className="step">
        <div className="step-num">1</div>
        <div className="card" style={{ flex: 1 }}>
          <h2 style={{ marginTop: 0 }}>Graph admin consent (grant a)</h2>
          {tenantId ? (
            <p className="ok">
              Consent recorded — tenant <span className="mono">{tenantId}</span> created automatically.
              Move on to step 2 below.
            </p>
          ) : (
            <>
              <p>
                Send the customer&apos;s Entra admin this link. It requests the Graph application
                permissions our multi-tenant app registration needs (read directory objects for host
                pool assignment lookups, etc.) — no Azure Lighthouse involved.
              </p>
              <p>
                No need to type in the customer&apos;s tenant GUID or a display name — Microsoft&apos;s own
                consent redirect tells us who just granted consent, and the tenant record is created
                automatically from that.
              </p>
              <button className="secondary" onClick={handleGetConsentUrl}>
                Generate admin-consent link
              </button>
              {consentUrl && (
                <>
                  <p className="mono" style={{ marginTop: 12 }}>
                    <a href={consentUrl} target="_blank" rel="noreferrer">
                      {consentUrl}
                    </a>
                  </p>
                  <p className="warn" style={{ marginTop: 12 }}>
                    Open the link above in a new tab and complete sign-in — that tab will redirect back
                    here once consent is recorded (this card updates automatically, no need to click
                    anything else here).
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div className="step">
        <div className="step-num">2</div>
        <div className="card" style={{ flex: 1 }}>
          <h2 style={{ marginTop: 0 }}>Deploy-to-Azure RBAC role (grant b)</h2>
          <p>
            The customer runs this Deploy-to-Azure template in their own subscription. It creates
            a least-privilege custom RBAC role scoped to AVD host-pool/session-host management and
            assigns it to our app&apos;s service principal — a separate grant from Graph consent above.
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
            <>
              <p className="mono" style={{ marginTop: 12 }}>
                <a href={deployUrl} target="_blank" rel="noreferrer">
                  {deployUrl}
                </a>
              </p>
              {deploySpObjectId ? (
                <div style={{ marginTop: 12, padding: 8, border: "1px solid #444", borderRadius: 4 }}>
                  <p style={{ marginTop: 0 }}>
                    Azure has no way to pre-fill this from the link above — the customer&apos;s admin
                    must paste it manually into the &quot;Avd Manager Service Principal Object Id&quot;
                    field on the deployment page that opens:
                  </p>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <code className="mono" style={{ flex: 1 }}>
                      {deploySpObjectId}
                    </code>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => navigator.clipboard.writeText(deploySpObjectId)}
                    >
                      Copy
                    </button>
                  </div>
                </div>
              ) : (
                <p className="warn" style={{ marginTop: 12 }}>
                  No service principal id available yet — make sure step 1 (Graph consent) completed
                  first.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="step">
        <div className="step-num">3</div>
        <div className="card" style={{ flex: 1 }}>
          <h2 style={{ marginTop: 0 }}>Grant status</h2>
          <p>
            Polls <span className="mono">GET /api/onboarding/tenants/:id/registry</span> every 5s
            once a tenant exists, showing the live <span className="mono">subscriptions_registry</span> row(s):
            Graph consent status, RBAC grant status, subscription id, resource groups in scope, and
            the last permission health-check result (from the RBAC drift-detection job).
          </p>
          {!tenantId && <p className="warn">Complete step 1 (Graph consent) first.</p>}
          {registryError && <p className="err">{registryError}</p>}
          {tenantId && !registryError && registryRows.length === 0 && (
            <p>{registryLoading ? "Checking…" : "No subscriptions_registry rows yet — complete step 2 above, or wait for the callback to fire."}</p>
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
        <div className="step-num">4</div>
        <div className="card" style={{ flex: 1 }}>
          <h2 style={{ marginTop: 0 }}>Done</h2>
          <p>Once both grants show as granted in the audit log, proceed to <a href="/host-pools">Host Pools</a> to provision your first host pool.</p>
        </div>
      </div>
    </div>
  );
}
