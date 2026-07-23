import { useEffect, useState } from "react";
import SettingsLayout from "../../components/SettingsLayout";
import {
  getOnboardingRegistry,
  listAzureResourceGroups,
  getMonitoredResourceGroups,
  updateMonitoredResourceGroups,
  syncMonitoredResourceGroups,
  ResourceGroupSummary,
} from "../../lib/api";
import { useTenantId } from "../../lib/useTenantId";

/**
 * Settings > Monitored Resource Groups, per Adam's request: "wanna add a
 * section for monitor resource groups? With a picker to select which
 * ones to monitor?" — this is what surfaces a real pre-existing host
 * pool (created outside AVD Manager, directly in the Azure portal) that
 * had no matching DB row, per Adam's report of an empty Host Pools table
 * despite having a real host pool in his subscription.
 *
 * Per Adam's choice ("Settings picker lists real resource groups fetched
 * live from Azure"), the picker is populated from a real ARM call
 * (Microsoft.Resources resourceGroups list), not free-text entry.
 */
export default function MonitoredResourceGroups() {
  const [tenantId] = useTenantId();
  const [subscriptionIds, setSubscriptionIds] = useState<string[]>([]);
  const [subscriptionNames, setSubscriptionNames] = useState<Record<string, string>>({});
  const [activeSubscriptionId, setActiveSubscriptionId] = useState("");
  const [azureGroups, setAzureGroups] = useState<ResourceGroupSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ discovered: number; imported: number; errors: string[] } | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    getOnboardingRegistry(tenantId)
      .then((rows) => {
        const ids = Array.from(new Set(rows.filter((r) => r.subscription_id).map((r) => r.subscription_id as string)));
        setSubscriptionIds(ids);
        const names: Record<string, string> = {};
        for (const r of rows) {
          if (r.subscription_id) names[r.subscription_id] = r.subscription_display_name || r.subscription_id;
        }
        setSubscriptionNames(names);
        if (ids.length > 0) setActiveSubscriptionId(ids[0]);
      })
      .catch((err) => setError((err as Error).message));
  }, [tenantId]);

  useEffect(() => {
    if (!tenantId || !activeSubscriptionId) return;
    setLoading(true);
    setError("");
    Promise.all([listAzureResourceGroups(tenantId, activeSubscriptionId), getMonitoredResourceGroups(tenantId)])
      .then(([groups, monitored]) => {
        setAzureGroups(groups);
        const existing = monitored.find((m) => m.subscription_id === activeSubscriptionId);
        setSelected(new Set(existing?.selected_resource_groups ?? []));
        setLastSyncedAt(existing?.last_synced_at ?? null);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [tenantId, activeSubscriptionId]);

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function handleSave() {
    if (!tenantId || !activeSubscriptionId) return;
    setSaving(true);
    setError("");
    try {
      await updateMonitoredResourceGroups(tenantId, activeSubscriptionId, Array.from(selected));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    if (!tenantId) return;
    setSyncing(true);
    setError("");
    setSyncResult(null);
    try {
      const result = await syncMonitoredResourceGroups(tenantId);
      setSyncResult(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  if (!tenantId) {
    return (
      <SettingsLayout>
        <p className="warn">
          No tenant selected yet — complete <a href="/onboarding">Onboarding</a> first.
        </p>
      </SettingsLayout>
    );
  }

  if (subscriptionIds.length === 0) {
    return (
      <SettingsLayout>
        <p className="warn">
          No granted subscriptions yet — complete the RBAC deployment step in{" "}
          <a href="/onboarding">Onboarding</a> first.
        </p>
      </SettingsLayout>
    );
  }

  return (
    <SettingsLayout>
      <p>
        Choose which resource groups AVD Manager should actively discover resources in — host pools
        (and other AVD resources) that exist in Azure but weren&apos;t created through this product
        won&apos;t show up anywhere until their resource group is monitored here, then synced.
      </p>
      {error && <p className="err">{error}</p>}

      <div className="card">
        <label>Subscription</label>
        <select value={activeSubscriptionId} onChange={(e) => setActiveSubscriptionId(e.target.value)}>
          {subscriptionIds.map((id) => (
            <option key={id} value={id}>
              {subscriptionNames[id] ?? id}
            </option>
          ))}
        </select>

        {loading ? (
          <p>Loading resource groups from Azure…</p>
        ) : azureGroups.length === 0 ? (
          <p>No resource groups found in this subscription.</p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 4, marginTop: 12 }}>
            {azureGroups.map((g) => (
              <label key={g.name} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 0 }}>
                <input
                  type="checkbox"
                  style={{ width: "auto", margin: 0 }}
                  checked={selected.has(g.name)}
                  onChange={() => toggle(g.name)}
                />
                {g.name} <span className="mono" style={{ fontSize: 12 }}>({g.location})</span>
              </label>
            ))}
          </div>
        )}

        <button onClick={handleSave} disabled={saving} style={{ marginTop: 12 }}>
          {saving ? "Saving…" : "Save"}
        </button>
        {lastSyncedAt && <p style={{ marginTop: 8 }}>Last synced: {new Date(lastSyncedAt).toLocaleString()}</p>}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Sync Now</h2>
        <p>
          Discovers host pools in every monitored resource group across all your subscriptions and
          imports any that AVD Manager doesn&apos;t already know about. Safe to run anytime — this only
          adds new records, it never deletes existing ones.
        </p>
        <button onClick={handleSync} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync Now"}
        </button>
        {syncResult && (
          <p className="warn" style={{ marginTop: 8 }}>
            Discovered {syncResult.discovered} host pool(s) in monitored resource groups, imported{" "}
            {syncResult.imported} new one(s).
            {syncResult.errors.length > 0 && ` Errors: ${syncResult.errors.join("; ")}`}
          </p>
        )}
      </div>
    </SettingsLayout>
  );
}
