import DeployLayout from "../../components/DeployLayout";

export default function DeployBicep() {
  return (
    <DeployLayout>
      <div className="card">
        <p className="warn">
          Paste-your-own-Bicep deployment isn&apos;t built yet — this tab is a placeholder so the L2
          layout matches the planned shape. See <code>infra/bicep/</code> in the repo for the Bicep
          templates this product already ships (RBAC delegation, host pool, session host).
        </p>
      </div>
    </DeployLayout>
  );
}
