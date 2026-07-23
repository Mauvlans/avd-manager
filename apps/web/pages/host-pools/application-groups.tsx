import { useEffect, useState } from "react";
import {
  ApplicationGroupRow,
  createOrUpdateApplicationGroup,
  deleteApplicationGroup,
  listApplicationGroups,
  listHostPools,
  getOnboardingRegistry,
} from "../../lib/api";
import { useTenantId } from "../../lib/useTenantId";
import HostPoolsLayout from "../../components/HostPoolsLayout";
import SidePanel from "../../components/SidePanel";

interface ApplicationGroupTableRow extends ApplicationGroupRow {
  subscriptionId: string;
  resourceGroup: string;
}

/**
 * Application Groups — real Azure AVD Application Groups
 * (Microsoft.DesktopVirtualization/applicationGroups), managed via thin
 * ARM wrappers. Part of the Host Pools L2 tab experience per Adam's mock.
 * No local DB table — ARM is the sole source of truth.
 *
 * Per Adam's explicit ask ("Host Pools under application groups need to
 * look like host pools table and should not have a dropdown for resource
 * group but both resource group and subscription should be in the
 * table"): removed the scope-selector dropdown entirely. Instead, mirrors
 * Host Pools' index page pattern exactly — automatically discovers every
 * distinct (subscription, resourceGroup) scope from the tenant's existing
 * host pools (application groups only exist scoped to a host pool, so
 * this is the same real scope discovery Host Pools' app-group-count
 * column already uses), fetches application groups across ALL of them,
 * and shows Subscription and Resource Group as real table columns rather
 * than a filter the admin has to pick before seeing anything.
 */
export default function ApplicationGroups() {
  const [tenantId] = useTenantId();
  const [groups, setGroups] = useState<ApplicationGroupTableRow[]>([]);
  const [subscriptionNames, setSubscriptionNames] = useState<Record<string, string>>({});
  const [knownScopes, setKnownScopes] = useState<{ subscriptionId: string; resourceGroup: string }[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  const [form, setForm] = useState({
    name: "",
    location: "eastus",
    friendlyName: "",
    hostPoolArmPath: "",
    applicationGroupType: "Desktop" as "Desktop" | "RemoteApp",
    subscriptionId: "",
    resourceGroup: "",
  });

  async function refresh() {
    if (!tenantId) return;
    setLoading(true);
    setError("");
    try {
      const [pools, registryRows] = await Promise.all([listHostPools(tenantId), getOnboardingRegistry(tenantId)]);

      const names: Record<string, string> = {};
      for (const r of registryRows) {
        if (r.subscription_id) names[r.subscription_id] = r.subscription_display_name || r.subscription_id;
      }
      setSubscriptionNames(names);

      const seen = new Set<string>();
      const scopes = pools
        .map((p) => ({ subscriptionId: p.subscription_id, resourceGroup: p.resource_group }))
        .filter((s) => {
          const key = `${s.subscriptionId}/${s.resourceGroup}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      setKnownScopes(scopes);

      const allGroups: ApplicationGroupTableRow[] = [];
      await Promise.all(
        scopes.map(async (scope) => {
          try {
            const scoped = await listApplicationGroups(tenantId, scope.subscriptionId, scope.resourceGroup);
            for (const g of scoped) {
              allGroups.push({ ...g, subscriptionId: scope.subscriptionId, resourceGroup: scope.resourceGroup });
            }
          } catch {
            // Non-fatal — a scope with no RBAC yet shouldn't blank the
            // whole table; other scopes' groups still render.
          }
        })
      );
      setGroups(allGroups);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  function openCreatePanel() {
    setForm({
      name: "",
      location: "eastus",
      friendlyName: "",
      hostPoolArmPath: "",
      applicationGroupType: "Desktop",
      subscriptionId: knownScopes[0]?.subscriptionId ?? "",
      resourceGroup: knownScopes[0]?.resourceGroup ?? "",
    });
    setError("");
    setPanelOpen(true);
  }

  async function handleCreate() {
    setError("");
    try {
      await createOrUpdateApplicationGroup(tenantId, form.name, {
        subscriptionId: form.subscriptionId,
        resourceGroup: form.resourceGroup,
        location: form.location,
        friendlyName: form.friendlyName || undefined,
        hostPoolArmPath: form.hostPoolArmPath,
        applicationGroupType: form.applicationGroupType,
      });
      setPanelOpen(false);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(row: ApplicationGroupTableRow) {
    setError("");
    try {
      await deleteApplicationGroup(tenantId, row.name, row.subscriptionId, row.resourceGroup);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!tenantId) {
    return (
      <HostPoolsLayout>
        <p className="warn">No tenant selected. Complete <a href="/onboarding">Onboarding</a> first.</p>
      </HostPoolsLayout>
    );
  }

  return (
    <HostPoolsLayout>
      {error && <p className="err">{error}</p>}

      <button onClick={openCreatePanel} disabled={knownScopes.length === 0}>
        + Create
      </button>

      {loading ? (
        <p>Loading…</p>
      ) : groups.length === 0 ? (
        <p>No application groups found. {knownScopes.length === 0 && "Create a host pool first."}</p>
      ) : (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Resource Group</th>
              <th>Subscription</th>
              <th>Type</th>
              <th>Host pool</th>
              <th>Published to workspace</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
                <td>
                  <a
                    href={`/host-pools/application-group-detail?name=${encodeURIComponent(g.name)}&subscriptionId=${encodeURIComponent(g.subscriptionId)}&resourceGroup=${encodeURIComponent(g.resourceGroup)}`}
                  >
                    {g.friendlyName || g.name}
                  </a>
                </td>
                <td>{g.resourceGroup}</td>
                <td>{subscriptionNames[g.subscriptionId] ?? g.subscriptionId}</td>
                <td>{g.applicationGroupType}</td>
                <td>{g.hostPoolArmPath.split("/").pop()}</td>
                <td>{g.workspaceArmPath ? g.workspaceArmPath.split("/").pop() : "—"}</td>
                <td>
                  <button className="secondary" onClick={() => handleDelete(g)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <SidePanel open={panelOpen} onClose={() => setPanelOpen(false)} title="Create Application Group">
        <p className="warn">
          Scoped to exactly one host pool (set here, effectively immutable afterward) — either a
          whole-desktop group ("Desktop") or a RemoteApp-publishing group ("RemoteApp"), which must be
          compatible with the host pool's own preferred app group type.
        </p>

        <label>Subscription / Resource Group</label>
        {knownScopes.length > 0 ? (
          <select
            value={`${form.subscriptionId}/${form.resourceGroup}`}
            onChange={(e) => {
              const [sub, rg] = e.target.value.split("/");
              setForm({ ...form, subscriptionId: sub, resourceGroup: rg });
            }}
          >
            {knownScopes.map((s) => (
              <option key={`${s.subscriptionId}/${s.resourceGroup}`} value={`${s.subscriptionId}/${s.resourceGroup}`}>
                {s.resourceGroup} ({subscriptionNames[s.subscriptionId] ?? s.subscriptionId})
              </option>
            ))}
          </select>
        ) : (
          <p className="warn" style={{ marginTop: 0 }}>No host pools yet — create one first via Deploy.</p>
        )}

        <label>Name</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />

        <label>Friendly name</label>
        <input value={form.friendlyName} onChange={(e) => setForm({ ...form, friendlyName: e.target.value })} />

        <label>Location</label>
        <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />

        <label>Host pool ARM resource id</label>
        <input
          placeholder="/subscriptions/.../resourceGroups/.../providers/Microsoft.DesktopVirtualization/hostPools/..."
          value={form.hostPoolArmPath}
          onChange={(e) => setForm({ ...form, hostPoolArmPath: e.target.value })}
        />

        <label>Application group type</label>
        <select
          value={form.applicationGroupType}
          onChange={(e) => setForm({ ...form, applicationGroupType: e.target.value as any })}
        >
          <option value="Desktop">Desktop</option>
          <option value="RemoteApp">RemoteApp</option>
        </select>

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button onClick={handleCreate} disabled={!form.name || !form.hostPoolArmPath || !form.subscriptionId}>
            Create
          </button>
          <button className="secondary" onClick={() => setPanelOpen(false)}>
            Cancel
          </button>
        </div>
      </SidePanel>
    </HostPoolsLayout>
  );
}
