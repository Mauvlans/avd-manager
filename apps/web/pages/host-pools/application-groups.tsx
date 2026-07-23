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

/**
 * Application Groups — real Azure AVD Application Groups
 * (Microsoft.DesktopVirtualization/applicationGroups), managed via thin
 * ARM wrappers. Part of the Host Pools L2 tab experience (Host Pools /
 * Application Groups / Workspaces) per Adam's mock. No local DB table —
 * ARM is the sole source of truth, matching /scaling-plans' precedent for
 * ARM-native-only resources scoped to subscription+resourceGroup.
 */
export default function ApplicationGroups() {
  const [tenantId] = useTenantId();
  const [subscriptionId, setSubscriptionId] = useState("");
  const [resourceGroup, setResourceGroup] = useState("");
  const [knownScopes, setKnownScopes] = useState<{ subscriptionId: string; resourceGroup: string }[]>([]);
  const [groups, setGroups] = useState<ApplicationGroupRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [form, setForm] = useState({
    name: "",
    location: "eastus",
    friendlyName: "",
    hostPoolArmPath: "",
    applicationGroupType: "Desktop" as "Desktop" | "RemoteApp",
  });

  // Adam reported the table appeared empty on this page — root cause: it
  // required Subscription ID + Resource Group to be typed in manually
  // before it would even attempt to load anything, with no way to
  // discover what to type. Default both from the tenant's existing host
  // pools (same subscription/resource-group scope application groups
  // actually live in), de-duplicated, so the page shows real data
  // immediately instead of a blank table with two empty required fields.
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
      setShowForm(false);
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
      <p className="warn">
        Real Azure AVD Application Groups (Microsoft.DesktopVirtualization/applicationGroups),
        managed here via thin ARM wrappers. Each group is scoped to exactly one host pool
        (set at create time and effectively immutable) and is either a whole-desktop group
        ("Desktop") or a RemoteApp-publishing group ("RemoteApp") — the type must be
        compatible with the host pool's own preferred app group type.
      </p>
      <p>Tenant: <span className="mono">{tenantId}</span></p>

      <div className="card">
        {knownScopes.length > 0 && (
          <>
            <label>Subscription / Resource Group (from your existing host pools)</label>
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

      {error && <p className="err">{error}</p>}

      <button onClick={() => setShowForm((s) => !s)} disabled={!subscriptionId || !resourceGroup}>
        {showForm ? "Cancel" : "+ New application group"}
      </button>

      {showForm && (
        <div className="card" style={{ marginTop: 16 }}>
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
          <button onClick={handleCreate} disabled={!form.name || !form.hostPoolArmPath}>
            Create
          </button>
        </div>
      )}

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
    </HostPoolsLayout>
  );
}
