import { useEffect, useState } from "react";
import {
  attachApplicationGroupToWorkspace,
  createOrUpdateWorkspace,
  deleteWorkspace,
  detachApplicationGroupFromWorkspace,
  listHostPools,
  listWorkspaces,
  WorkspaceRow,
} from "../../lib/api";
import { useTenantId } from "../../lib/useTenantId";
import HostPoolsLayout from "../../components/HostPoolsLayout";

/**
 * Workspaces — real Azure AVD Workspaces
 * (Microsoft.DesktopVirtualization/workspaces), managed via thin ARM
 * wrappers. Part of the Host Pools L2 tab experience (Host Pools /
 * Application Groups / Workspaces) per Adam's mock. No local DB table —
 * ARM is the sole source of truth. A workspace publishes one or more
 * Application Groups to end users (each workspace shows up as a feed URL
 * in the AVD client); attach/detach is a read-modify-write over the
 * workspace's applicationGroupReferences array, same pattern as scaling
 * plans' hostPoolReferences.
 */
export default function Workspaces() {
  const [tenantId] = useTenantId();
  const [subscriptionId, setSubscriptionId] = useState("");
  const [resourceGroup, setResourceGroup] = useState("");
  const [knownScopes, setKnownScopes] = useState<{ subscriptionId: string; resourceGroup: string }[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [form, setForm] = useState({ name: "", location: "eastus", friendlyName: "" });
  const [attachForm, setAttachForm] = useState({ workspaceName: "", applicationGroupArmPath: "" });

  // Same fix as application-groups.tsx: default Subscription ID / Resource
  // Group from the tenant's existing host pools instead of requiring
  // manual entry before anything loads — this was the root cause of Adam
  // reporting an empty table on this page too.
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
      setWorkspaces(await listWorkspaces(tenantId, subscriptionId, resourceGroup));
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
      await createOrUpdateWorkspace(tenantId, form.name, {
        subscriptionId,
        resourceGroup,
        location: form.location,
        friendlyName: form.friendlyName || undefined,
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
      await deleteWorkspace(tenantId, name, subscriptionId, resourceGroup);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleAttach() {
    setError("");
    try {
      await attachApplicationGroupToWorkspace(tenantId, attachForm.workspaceName, {
        subscriptionId,
        resourceGroup,
        applicationGroupArmPath: attachForm.applicationGroupArmPath,
      });
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDetach(workspaceName: string, applicationGroupArmPath: string) {
    setError("");
    try {
      await detachApplicationGroupFromWorkspace(tenantId, workspaceName, {
        subscriptionId,
        resourceGroup,
        applicationGroupArmPath,
      });
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
        Real Azure AVD Workspaces (Microsoft.DesktopVirtualization/workspaces), managed here via
        thin ARM wrappers. A workspace publishes one or more Application Groups to end users (each
        workspace appears as a feed URL in the AVD client) — attach/detach below reads the current
        workspace, splices the app group's ARM resource id in/out of its list, and writes the whole
        workspace back (ARM has no separate attach/detach verb for this).
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
        {showForm ? "Cancel" : "+ New workspace"}
      </button>

      {showForm && (
        <div className="card" style={{ marginTop: 16 }}>
          <label>Name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <label>Friendly name</label>
          <input value={form.friendlyName} onChange={(e) => setForm({ ...form, friendlyName: e.target.value })} />
          <label>Location</label>
          <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          <button onClick={handleCreate} disabled={!form.name}>Create</button>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Publish an application group to a workspace</h3>
        <label>Workspace name</label>
        <input
          value={attachForm.workspaceName}
          onChange={(e) => setAttachForm({ ...attachForm, workspaceName: e.target.value })}
        />
        <label>Application group ARM resource id</label>
        <input
          placeholder="/subscriptions/.../resourceGroups/.../providers/Microsoft.DesktopVirtualization/applicationGroups/..."
          value={attachForm.applicationGroupArmPath}
          onChange={(e) => setAttachForm({ ...attachForm, applicationGroupArmPath: e.target.value })}
        />
        <button onClick={handleAttach} disabled={!attachForm.workspaceName || !attachForm.applicationGroupArmPath}>
          Attach
        </button>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : workspaces.length === 0 ? (
        <p>No workspaces found for this subscription/resource group.</p>
      ) : (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Published application groups</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map((w) => (
              <tr key={w.id}>
                <td>{w.friendlyName || w.name}</td>
                <td>
                  {w.applicationGroupReferences.length === 0
                    ? "—"
                    : w.applicationGroupReferences.map((ref) => (
                        <div key={ref}>
                          {ref.split("/").pop()}{" "}
                          <button className="secondary" onClick={() => handleDetach(w.name, ref)}>
                            Detach
                          </button>
                        </div>
                      ))}
                </td>
                <td>
                  <button className="secondary" onClick={() => handleDelete(w.name)}>
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
