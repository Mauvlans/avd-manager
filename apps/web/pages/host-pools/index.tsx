import { useEffect, useState } from "react";
import { deleteHostPool, listHostPools, getOnboardingRegistry, listApplicationGroups, syncMonitoredResourceGroups, HostPoolRow } from "../../lib/api";
import { useTenantId } from "../../lib/useTenantId";
import HostPoolsLayout from "../../components/HostPoolsLayout";

/**
 * Host Pools — list/manage existing host pools. Creation happens via
 * Deploy > Template (or Deploy > Bicep) — see the earlier commit removing
 * the old inline free-text creation form.
 *
 * Columns/layout match Adam's actual Host Pools mock image (img_d067cbb981fe.png,
 * received directly in chat — an earlier delegated build of this page had
 * no access to it and used generic columns instead): Name, Resource
 * Group, Location, Subscription (friendly name), Host pool type, Load
 * balancer type, Application groups (count). "Deployment scope" from the
 * mock was explicitly dropped per Adam ("Lets drop Deployment Scope") —
 * it isn't a real ARM property and there was no agreed source for it.
 *
 * Subscription friendly name (e.g. "MSFT - External Sub - Mauvlan") is
 * the REAL Azure Subscription resource's displayName, resolved via ARM at
 * RBAC-grant time (see onboardingService.recordRbacGranted ->
 * ArmSubscriptionInfoClient) and stored on subscriptions_registry — not
 * something an admin types in. Looked up here from the tenant's registry
 * rows, keyed by subscription id, with the raw id as a fallback if no
 * display name was resolved (e.g. RBAC was granted before this field
 * existed).
 *
 * Application group count is a real live ARM count — the app group ARM
 * API doesn't expose a "count per host pool" list filter, so this fetches
 * every app group in each host pool's (subscription, resourceGroup) scope
 * once per distinct scope (not once per host pool — pools sharing a
 * scope share one fetch) and counts matches by hostPoolArmPath.
 */
export default function HostPools() {
  const [tenantId] = useTenantId();
  const [pools, setPools] = useState<HostPoolRow[]>([]);
  const [subscriptionNames, setSubscriptionNames] = useState<Record<string, string>>({});
  const [appGroupCounts, setAppGroupCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  async function refresh() {
    if (!tenantId) return;
    setLoading(true);
    setError("");
    try {
      const [poolRows, registryRows] = await Promise.all([listHostPools(tenantId), getOnboardingRegistry(tenantId)]);
      setPools(poolRows);

      const names: Record<string, string> = {};
      for (const r of registryRows) {
        if (r.subscription_id) names[r.subscription_id] = r.subscription_display_name || r.subscription_id;
      }
      setSubscriptionNames(names);

      // Fetch application groups once per distinct (subscription, resourceGroup)
      // scope across all pools, then count by hostPoolArmPath.
      const scopes = new Map<string, { subscriptionId: string; resourceGroup: string }>();
      for (const p of poolRows) {
        scopes.set(`${p.subscription_id}/${p.resource_group}`, {
          subscriptionId: p.subscription_id,
          resourceGroup: p.resource_group,
        });
      }
      const counts: Record<string, number> = {};
      await Promise.all(
        Array.from(scopes.values()).map(async (scope) => {
          try {
            const groups = await listApplicationGroups(tenantId, scope.subscriptionId, scope.resourceGroup);
            for (const p of poolRows) {
              if (p.subscription_id !== scope.subscriptionId || p.resource_group !== scope.resourceGroup) continue;
              counts[p.id] = groups.filter((g) => g.hostPoolArmPath.toLowerCase().includes(`/hostpools/${p.name.toLowerCase()}`)).length;
            }
          } catch {
            // Non-fatal — app group listing can fail independently of
            // host pool listing (e.g. no RBAC yet for that scope); the
            // table still renders with a blank count rather than failing
            // the whole page.
          }
        })
      );
      setAppGroupCounts(counts);
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

  async function handleDelete(id: string) {
    setError("");
    try {
      await deleteHostPool(tenantId, id);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleSync() {
    if (!tenantId) return;
    setSyncing(true);
    setError("");
    setSyncResult(null);
    try {
      const result = await syncMonitoredResourceGroups(tenantId);
      setSyncResult(
        `Synced: ${result.discovered} discovered, ${result.imported} newly imported${
          result.errors.length > 0 ? `, ${result.errors.length} error(s)` : ""
        }.`
      );
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  // "Last synced" = the most recent updated_at across all cached pools —
  // real signal now that the sync route bumps updated_at on already-known
  // pools too (fixed live: it used to only insert brand-new pools and
  // silently skip refreshing known ones, so this timestamp would have
  // been stuck at each pool's original import time otherwise).
  const lastSyncedAt = pools.length > 0
    ? pools.reduce((latest, p) => (p.updated_at > latest ? p.updated_at : latest), pools[0].updated_at)
    : null;

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

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <a href="/deploy">
          <button>+ Create</button>
        </a>
        <button className="secondary" onClick={handleSync} disabled={syncing}>
          {syncing ? "Syncing…" : "Refresh from Azure"}
        </button>
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {lastSyncedAt
            ? `This table is cached from our database, not a live call on every page load — last synced ${new Date(lastSyncedAt).toLocaleString()}.`
            : "This table is cached from our database, not a live call on every page load."}
        </span>
      </div>
      {syncResult && <p style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>{syncResult}</p>}

      {loading ? (
        <p>Loading…</p>
      ) : pools.length === 0 ? (
        <p>
          No host pools yet. Head to <a href="/deploy">Deploy</a> to create one from a template.
        </p>
      ) : (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Resource Group</th>
              <th>Location</th>
              <th>Subscription</th>
              <th>Host pool type</th>
              <th>Load balancer type</th>
              <th>Application groups</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pools.map((p) => (
              <tr key={p.id}>
                <td>
                  <a href={`/host-pools/${p.id}`}>{p.name}</a>
                </td>
                <td>{p.resource_group}</td>
                <td>{p.location}</td>
                <td>{subscriptionNames[p.subscription_id] ?? p.subscription_id}</td>
                <td>{p.host_pool_type}</td>
                <td>{p.load_balancer_type}</td>
                <td>{appGroupCounts[p.id] ?? "—"}</td>
                <td>
                  <button className="secondary" onClick={() => handleDelete(p.id)}>
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
