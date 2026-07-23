import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { getApplicationGroup, ApplicationGroupRow } from "../../lib/api";
import { useTenantId } from "../../lib/useTenantId";
import HostPoolsLayout from "../../components/HostPoolsLayout";

/**
 * Application Group detail page, per Adam's request to make Application
 * Groups clickable "like host pools" (pages/host-pools/[id].tsx). Unlike
 * Host Pools, application groups have no local DB row/id — ARM is the
 * sole source of truth (see armApplicationGroupClient.ts) — so this
 * route is keyed by the group's real ARM name plus its (subscriptionId,
 * resourceGroup) scope, passed as query params from the Application
 * Groups table's link, rather than a DB-generated id.
 */
export default function ApplicationGroupDetail() {
  const router = useRouter();
  const name = router.query.name as string | undefined;
  const subscriptionId = router.query.subscriptionId as string | undefined;
  const resourceGroup = router.query.resourceGroup as string | undefined;
  const [tenantId] = useTenantId();
  const [group, setGroup] = useState<ApplicationGroupRow | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tenantId || !name || !subscriptionId || !resourceGroup) return;
    setLoading(true);
    setError("");
    getApplicationGroup(tenantId, subscriptionId, resourceGroup, name)
      .then(setGroup)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [tenantId, name, subscriptionId, resourceGroup]);

  if (!tenantId) return <HostPoolsLayout><p className="warn">No tenant selected. Complete onboarding first.</p></HostPoolsLayout>;
  if (loading || !group) return <HostPoolsLayout>{error ? <p className="err">{error}</p> : <p>Loading…</p>}</HostPoolsLayout>;

  return (
    <HostPoolsLayout>
      <h2 style={{ marginTop: 0 }}>{group.friendlyName || group.name}</h2>
      {error && <p className="err">{error}</p>}
      <div className="card">
        <p><strong>Name:</strong> {group.name}</p>
        <p><strong>Subscription:</strong> <span className="mono">{subscriptionId}</span></p>
        <p><strong>Resource group:</strong> {resourceGroup}</p>
        <p><strong>Location:</strong> {group.location}</p>
        <p><strong>Type:</strong> {group.applicationGroupType}</p>
        <p>
          <strong>Host pool:</strong>{" "}
          <a href={`/host-pools`}>{group.hostPoolArmPath.split("/").pop()}</a>
        </p>
        <p>
          <strong>Published to workspace:</strong>{" "}
          {group.workspaceArmPath ? (
            <a href="/host-pools/workspaces">{group.workspaceArmPath.split("/").pop()}</a>
          ) : (
            "—"
          )}
        </p>
        {group.description && <p><strong>Description:</strong> {group.description}</p>}
      </div>
    </HostPoolsLayout>
  );
}
