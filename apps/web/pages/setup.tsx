import { useState } from "react";

/**
 * Platform bootstrap wizard: creates AVD Manager's own multi-tenant Entra
 * app registration via device-code sign-in, so an operator never has to
 * click through the Entra portal manually. Mirrors the "Run setup
 * wizard…" pattern in the W365Import project — a well-known Microsoft
 * client (Graph PowerShell's) is pre-authorized to create app
 * registrations/grant consent on Graph's behalf, which lets a brand-new
 * app bootstrap itself without needing credentials of its own yet.
 *
 * This is a ONE-TIME, per-environment operation, not part of the
 * per-customer tenant onboarding wizard (/onboarding) — it produces the
 * ENTRA_APP_CLIENT_ID / ENTRA_APP_CLIENT_SECRET this whole platform runs
 * as, which the per-customer onboarding flow then uses to build
 * Graph-consent links for each customer tenant.
 */

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
}

export default function Setup() {
  const [session, setSession] = useState<DeviceCodeSession | null>(null);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [result, setResult] = useState<CreatedAppRegistration | null>(null);
  const [busy, setBusy] = useState(false);

  async function startDeviceCode() {
    setError("");
    setResult(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/setup/device-code`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "device-code request failed");
      setSession(data);
      setStatus("Waiting for you to sign in…");
      poll(data.device_code, data.interval || 5);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function poll(deviceCode: string, intervalSeconds: number) {
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
          setError("Device code expired — click Start again.");
          setBusy(false);
          return;
        }
        if (outcome.status === "denied") {
          setError(`Sign-in denied: ${outcome.error}`);
          setBusy(false);
          return;
        }
        // authorized
        setStatus("Signed in — creating app registration…");
        const completeRes = await fetch(`${API_BASE}/api/setup/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken: outcome.accessToken, displayName: "AVD Manager (dev)" }),
        });
        const completeData = await completeRes.json();
        if (!completeRes.ok) throw new Error(completeData.error || "app registration creation failed");
        setResult(completeData);
        setStatus("Done.");
        setBusy(false);
      } catch (err) {
        setError((err as Error).message);
        setBusy(false);
      }
    };
    attempt();
  }

  return (
    <div>
      <h1>Platform Setup</h1>
      <p>
        One-time, per-environment: creates AVD Manager&apos;s own multi-tenant Entra app registration
        (Graph permissions + admin consent + client secret) so the per-customer{" "}
        <a href="/onboarding">Onboarding</a> wizard has a real client ID to build consent links with.
      </p>
      {error && <p className="err">{error}</p>}

      <div className="card">
        <button onClick={startDeviceCode} disabled={busy}>
          Start setup (device-code sign-in)
        </button>

        {session && !result && (
          <div style={{ marginTop: 16 }}>
            <p>
              Go to{" "}
              <a href={session.verification_uri} target="_blank" rel="noreferrer">
                {session.verification_uri}
              </a>{" "}
              and enter this code:
            </p>
            <p className="mono" style={{ fontSize: 24 }}>
              {session.user_code}
            </p>
            <p>{status}</p>
          </div>
        )}

        {result && (
          <div style={{ marginTop: 16 }}>
            <p className="ok">
              App registration created{result.adminConsentGranted ? " and admin consent granted." : " — admin consent grant failed for one or more scopes, check server logs."}
            </p>
            <p>
              Set these in the API&apos;s environment and restart it, then the Onboarding wizard&apos;s
              consent links will use your real app instead of the placeholder:
            </p>
            <pre className="mono">
              {`ENTRA_APP_CLIENT_ID=${result.appId}\nENTRA_APP_CLIENT_SECRET=${result.clientSecret}`}
            </pre>
            <p className="warn">
              This client secret is shown once — copy it now. It is not stored anywhere by this app.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
