import { useEffect, useState } from "react";
import {
  ApplicationGroupRow,
  createOrUpdateApplicationGroup,
  deleteApplicationGroup,
  listApplicationGroups,
  listHostPools,
} from "../../lib/api";
import { useTenantId } from "../../lib/useTenantId";
import HostPoolsLayout from "../../components/HostPoolsLayout";
import SidePanel from "../../components/SidePanel";

/**
 * Application Groups — real Azure AVD Application Groups
 * (Microsoft.DesktopVirtualization/applicationGroups), managed via thin
 * ARM wrappers. Part of the Host Pools L2 tab experience per Adam's mock.
 * No local DB table — ARM is the sole source of truth.
 *
 * Rebuilt per Adam's explicit ask ("add a table to Application Groups to
 * mirror host pool with a create button") to match Host Pools'
 * (pages/host-pools/index.tsx) exact pattern: a "+ Create" button that
 * opens a SidePanel (Deploy > Template's right-side slide-out blade
 * style) instead of an inline toggle form, table styling identical to
 * Host Pools' table.
 */
export default function ApplicationGroups() {
  const [tenantId] = useTenantId();
  const [subscriptionId, setSubscriptionId] = useState("");
  const [resourceGroup, setResourceGroup] = useState("");
  const [knownScopes, setKnownScopes] = useState<{ subscriptionId: string; resourceGroup: string }[]>([]);
  const [groups, setGroups] = useState<ApplicationGroupRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  const [form, setForm] = useState({
    name: "",
    location: "eastus",
    friendlyName: "",
    hostPoolArmPath: "",
    applicationGroupType: "Desktop" as "Desktop" | "RemoteApp",
  });

  // Default Subscription ID / Resource Group from the tenant's existing
  // host pools (same scope application groups actually live in) instead
  // of requiring manual entry — see the earlier fix for the "table
  // appears empty" bug.
  useEffect(() => {
    if (!tenantId) return;
    listHostPools(tenantId)
      .then((pools) => {
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
        if (scopes.length > 0 && !subscriptionId && !resourceGroup) {
          setSubscriptionId(scopes[0].subscriptionId);
          setResourceGroup(scopes[0].resourceGroup);
        }
      })
      .catch(() => {
        /* non-fatal — falls back to manual entry below */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function refresh() {
    if (!tenantId || !subscriptionId || !resourceGroup) return;
    setLoading(true);
    setError("");
    try {
      setGroups(await listApplicationGroups(tenantId, subscriptionId, resourceGroup));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, subscriptionId, resourceGroup]);

  function openCreatePanel() {
    setForm({
      name: "",
      location: "eastus",
      friendlyName: "",
      hostPoolArmPath: "",
      applicationGroupType: "Desktop",
    });
    setError("");
    setPanelOpen(true);
  }

  async function handleCreate() {
    setError("");
    try {
      await createOrUpdateApplicationGroup(tenantId, form.name, {
        subscriptionId,
        resourceGroup,
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

  async function handleDelete(name: string) {
    setError("");
    try {
      await deleteApplicationGroup(tenantId, name, subscriptionId, resourceGroup);
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

      <div className="card">
        {knownScopes.length > 0 && (
          <>
            <label>Subscription / Resource Group</label>
            <select
              value={`${subscriptionId}/${resourceGroup}`}
              onChange={(e) => {
                const [sub, rg] = e.target.value.split("/");
                setSubscriptionId(sub);
                setResourceGroup(rg);
              }}
            >
              {knownScopes.map((s) => (
                <option key={`${s.subscriptionId}/${s.resourceGroup}`} value={`${s.subscriptionId}/${s.resourceGroup}`}>
                  {s.resourceGroup} ({s.subscriptionId})
                </option>
              ))}
              <option value="/">Other (enter manually)…</option>
            </select>
          </>
        )}
        {(knownScopes.length === 0 || subscriptionId === "") && (
          <>
            <label>Subscription ID</label>
            <input value={subscriptionId} onChange={(e) => setSubscriptionId(e.target.value)} />
            <label>Resource group</label>
            <input value={resourceGroup} onChange={(e) => setResourceGroup(e.target.value)} />
          </>
        )}
      </div>

      <button onClick={openCreatePanel} disabled={!subscriptionId || !resourceGroup}>
        + Create
      </button>

      {loading ? (
        <p>Loading…</p>
      ) : groups.length === 0 ? (
        <p>No application groups found for this subscription/resource group.</p>
      ) : (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Host pool</th>
              <th>Published to workspace</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
                <td>{g.friendlyName || g.name}</td>
                <td>{g.applicationGroupType}</td>
                <td>{g.hostPoolArmPath.split("/").pop()}</td>
                <td>{g.workspaceArmPath ? g.workspaceArmPath.split("/").pop() : "—"}</td>
                <td>
                  <button className="secondary" onClick={() => handleDelete(g.name)}>
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
          <button onClick={handleCreate} disabled={!form.name || !form.hostPoolArmPath}>
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
