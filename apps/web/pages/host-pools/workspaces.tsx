import { useEffect, useState } from "react";
import {
  attachApplicationGroupToWorkspace,
  createOrUpdateWorkspace,
  deleteWorkspace,
  detachApplicationGroupFromWorkspace,
  listHostPools,
  listWorkspaces,
  getOnboardingRegistry,
  WorkspaceRow,
} from "../../lib/api";
import { useTenantId } from "../../lib/useTenantId";
import HostPoolsLayout from "../../components/HostPoolsLayout";
import SidePanel from "../../components/SidePanel";

interface WorkspaceTableRow extends WorkspaceRow {
  subscriptionId: string;
  resourceGroup: string;
}

/**
 * Workspaces — real Azure AVD Workspaces
 * (Microsoft.DesktopVirtualization/workspaces), managed via thin ARM
 * wrappers. Part of the Host Pools L2 tab experience per Adam's mock. No
 * local DB table — ARM is the sole source of truth.
 *
 * Rebuilt per Adam's request ("add tables for workspaces") to mirror
 * Host Pools/Application Groups exactly: auto-discovers every distinct
 * (subscription, resourceGroup) scope from the tenant's existing host
 * pools, fetches workspaces across ALL of them (no scope-selector
 * dropdown gating the view), shows Subscription and Resource Group as
 * real table columns, and uses a "+ Create" button opening a SidePanel
 * instead of an inline toggle form.
 */
export default function Workspaces() {
  const [tenantId] = useTenantId();
  const [workspaces, setWorkspaces] = useState<WorkspaceTableRow[]>([]);
  const [subscriptionNames, setSubscriptionNames] = useState<Record<string, string>>({});
  const [knownScopes, setKnownScopes] = useState<{ subscriptionId: string; resourceGroup: string }[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  const [form, setForm] = useState({ name: "", location: "eastus", friendlyName: "", subscriptionId: "", resourceGroup: "" });
  const [attachForm, setAttachForm] = useState({ workspaceName: "", applicationGroupArmPath: "", subscriptionId: "", resourceGroup: "" });

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

      const allWorkspaces: WorkspaceTableRow[] = [];
      await Promise.all(
        scopes.map(async (scope) => {
          try {
            const scoped = await listWorkspaces(tenantId, scope.subscriptionId, scope.resourceGroup);
            for (const w of scoped) {
              allWorkspaces.push({ ...w, subscriptionId: scope.subscriptionId, resourceGroup: scope.resourceGroup });
            }
          } catch {
            // Non-fatal — a scope with no RBAC yet shouldn't blank the
            // whole table; other scopes' workspaces still render.
          }
        })
      );
      setWorkspaces(allWorkspaces);
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
      subscriptionId: knownScopes[0]?.subscriptionId ?? "",
      resourceGroup: knownScopes[0]?.resourceGroup ?? "",
    });
    setError("");
    setPanelOpen(true);
  }

  async function handleCreate() {
    setError("");
    try {
      await createOrUpdateWorkspace(tenantId, form.name, {
        subscriptionId: form.subscriptionId,
        resourceGroup: form.resourceGroup,
        location: form.location,
        friendlyName: form.friendlyName || undefined,
      });
      setPanelOpen(false);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(row: WorkspaceTableRow) {
    setError("");
    try {
      await deleteWorkspace(tenantId, row.name, row.subscriptionId, row.resourceGroup);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleAttach(row: WorkspaceTableRow) {
    setError("");
    try {
      await attachApplicationGroupToWorkspace(tenantId, row.name, {
        subscriptionId: row.subscriptionId,
        resourceGroup: row.resourceGroup,
        applicationGroupArmPath: attachForm.applicationGroupArmPath,
      });
      setAttachForm({ ...attachForm, applicationGroupArmPath: "" });
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDetach(row: WorkspaceTableRow, applicationGroupArmPath: string) {
    setError("");
    try {
      await detachApplicationGroupFromWorkspace(tenantId, row.name, {
        subscriptionId: row.subscriptionId,
        resourceGroup: row.resourceGroup,
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
      {error && <p className="err">{error}</p>}

      <button onClick={openCreatePanel} disabled={knownScopes.length === 0}>
        + Create
      </button>

      {loading ? (
        <p>Loading…</p>
      ) : workspaces.length === 0 ? (
        <p>No workspaces found. {knownScopes.length === 0 && "Create a host pool first."}</p>
      ) : (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Resource Group</th>
              <th>Subscription</th>
              <th>Published application groups</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map((w) => (
              <tr key={w.id}>
                <td>{w.friendlyName || w.name}</td>
                <td>{w.resourceGroup}</td>
                <td>{subscriptionNames[w.subscriptionId] ?? w.subscriptionId}</td>
                <td>
                  {w.applicationGroupReferences.length === 0
                    ? "—"
                    : w.applicationGroupReferences.map((ref) => (
                        <div key={ref}>
                          {ref.split("/").pop()}{" "}
                          <button className="secondary" onClick={() => handleDetach(w, ref)}>
                            Detach
                          </button>
                        </div>
                      ))}
                  <div style={{ marginTop: 6, display: "flex", gap: 4 }}>
                    <input
                      style={{ fontSize: 12 }}
                      placeholder="app group ARM resource id to publish…"
                      value={attachForm.applicationGroupArmPath}
                      onChange={(e) => setAttachForm({ ...attachForm, applicationGroupArmPath: e.target.value })}
                    />
                    <button className="secondary" onClick={() => handleAttach(w)} disabled={!attachForm.applicationGroupArmPath}>
                      Attach
                    </button>
                  </div>
                </td>
                <td>
                  <button className="secondary" onClick={() => handleDelete(w)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <SidePanel open={panelOpen} onClose={() => setPanelOpen(false)} title="Create Workspace">
        <p className="warn">
          A workspace publishes one or more Application Groups to end users as a feed URL in the AVD
          client. Attach application groups after creating the workspace, from the table above.
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

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button onClick={handleCreate} disabled={!form.name || !form.subscriptionId}>
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
