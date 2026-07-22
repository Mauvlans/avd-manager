/**
 * Settings — L1 landing page for setup/configuration surfaces, as opposed
 * to the day-to-day operational pages (Host Pools, Scaling Plans, Cost,
 * Audit Log). Currently just links to Onboarding (its one sub-item in the
 * sidebar); more settings (platform app registration status, environment
 * config, etc.) can land here later without another nav restructure.
 */
export default function Settings() {
  return (
    <div>
      <h1>Settings</h1>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Onboarding</h2>
        <p>
          Register a new customer tenant: Graph admin consent, Deploy-to-Azure RBAC role deployment,
          and live grant-status tracking.
        </p>
        <a href="/onboarding">Go to Onboarding →</a>
      </div>
    </div>
  );
}
