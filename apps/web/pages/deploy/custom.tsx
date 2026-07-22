import DeployLayout from "../../components/DeployLayout";

export default function DeployCustom() {
  return (
    <DeployLayout>
      <div className="card">
        <p className="warn">
          Custom deployment (build a host pool from scratch without a template preset) isn&apos;t
          built yet — this tab is a placeholder so the L2 layout matches the planned shape. Use the{" "}
          <a href="/deploy">Template</a> tab for now, or create a host pool directly from{" "}
          <a href="/host-pools">Host Pools</a>.
        </p>
      </div>
    </DeployLayout>
  );
}
