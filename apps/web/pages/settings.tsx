import SettingsLayout from "../components/SettingsLayout";

/**
 * Settings > General — landing tab. See components/SettingsLayout.tsx for
 * the L2 tab bar shared by every Settings page.
 */
export default function Settings() {
  return (
    <SettingsLayout>
      <div className="card">
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
