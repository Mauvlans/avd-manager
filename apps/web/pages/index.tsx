export default function Home() {
  return (
    <div>
      <h1>AVD Manager</h1>
      <p>
        Manage multi-tenant Azure Virtual Desktop host pools, autoscaling policies, and cost
        estimates from a single control plane.
      </p>
      <div className="card">
        <p>Start with <a href="/onboarding">Onboarding</a> to register a new customer tenant, grant
        Graph admin consent, and deploy the Deploy-to-Azure RBAC role. Once a tenant is active,
        manage its <a href="/host-pools">Host Pools</a> and scaling policies, and check the{" "}
        <a href="/cost">Cost Dashboard</a>.</p>
      </div>
    </div>
  );
}
