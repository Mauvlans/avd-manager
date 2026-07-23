import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import DeployLayout from "../components/DeployLayout";
import SidePanel from "../components/SidePanel";
import { createHostPool, getOnboardingRegistry, listHostPools, listServiceVariables } from "../lib/api";
import { useTenantId } from "../lib/useTenantId";

/**
 * Deploy > Template — prebuilt host pool templates the admin fills a few
 * details into, we publish the rest. Per Adam's mock
 * (image attached in chat) + explicit scope decision:
 *   - Simple Personal / Shared / Remote Apps host pools: we own these
 *     end-to-end — clicking a template opens a right-side slide-out panel
 *     (components/SidePanel.tsx, Azure-portal-blade style, per Adam's ask
 *     for "a pop up form or a form that opens from the right") with the
 *     few fields that actually vary (name, subscription, resource group,
 *     location, session limit for Shared), everything else (load balancer
 *     type, preferredAppGroupType, etc.) is a template-specific preset
 *     baked in here, then POSTed to our existing POST /api/host-pools ->
 *     ArmHostPoolClient.createOrUpdateHostPool, the same path the Host
 *     Pools page's manual "create" flow already uses.
 *   - "Deploy Azure Virtual Desktop To An Application Landing Zone": this
 *     opens Microsoft's REAL Deploy-to-Azure portal experience for the
 *     github.com/Azure/avdaccelerator baseline — a CustomDeploymentBlade
 *     URL combining the accelerator's baseline ARM template
 *     (workload/arm/deploy-baseline.json) with its own custom portal UI
 *     definition (workload/portal-ui/portal-ui-baseline.json), both served
 *     directly from that repo. Adam supplied this exact URL after I
 *     incorrectly assumed (based on the docs' PowerShell/CLI-first framing)
 *     that no one-click portal experience existed — it does, both JSON
 *     files were confirmed reachable (200) before wiring this in. This is
 *     the real, unmodified accelerator experience, not a reimplementation.
 */

type TemplateId = "simple-personal" | "shared" | "remote-apps";

interface TemplateDefinition {
  id: TemplateId;
  label: string;
  description: string;
  preset: {
    hostPoolType: "Personal" | "Pooled";
    loadBalancerType: "BreadthFirst" | "DepthFirst" | "Persistent";
    preferredAppGroupType: "Desktop" | "RailApplication";
    defaultMaxSessionLimit: number;
    showMaxSessionLimit: boolean;
  };
}

const TEMPLATES: TemplateDefinition[] = [
  {
    id: "simple-personal",
    label: "Deploy a Simple Personal Host Pool",
    description:
      "One session host per user, assigned 1:1 (Personal desktop). Good for a small pilot or dedicated-desktop use case.",
    preset: {
      hostPoolType: "Personal",
      loadBalancerType: "Persistent",
      preferredAppGroupType: "Desktop",
      defaultMaxSessionLimit: 1,
      showMaxSessionLimit: false,
    },
  },
  {
    id: "shared",
    label: "Deploy a Shared Host Pool",
    description:
      "Pooled desktops shared across multiple users with breadth-first load balancing. Good for general-purpose multi-session desktops.",
    preset: {
      hostPoolType: "Pooled",
      loadBalancerType: "BreadthFirst",
      preferredAppGroupType: "Desktop",
      defaultMaxSessionLimit: 10,
      showMaxSessionLimit: true,
    },
  },
  {
    id: "remote-apps",
    label: "Deploy a Remote Apps Host Pool",
    description:
      "Pooled hosts publishing individual applications (RemoteApp) instead of a full desktop, load-balanced breadth-first.",
    preset: {
      hostPoolType: "Pooled",
      loadBalancerType: "BreadthFirst",
      preferredAppGroupType: "RailApplication",
      defaultMaxSessionLimit: 10,
      showMaxSessionLimit: true,
    },
  },
];

export default function Deploy() {
  const [tenantId] = useTenantId();
  const router = useRouter();
  const [activeTemplate, setActiveTemplate] = useState<TemplateDefinition | null>(null);
  const [name, setName] = useState("");
  const [subscriptionId, setSubscriptionId] = useState("");
  const [knownSubscriptionIds, setKnownSubscriptionIds] = useState<string[]>([]);
  const [subscriptionNames, setSubscriptionNames] = useState<Record<string, string>>({});
  const [availableRegions, setAvailableRegions] = useState<{ value: string; label: string }[]>([]);
  const [resourceGroup, setResourceGroup] = useState("");
  const [location, setLocation] = useState("eastus");
  const [maxSessionLimit, setMaxSessionLimit] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Subscription dropdown is sourced from what AVD Manager already knows
  // about for this tenant — RBAC-granted subscriptions from the onboarding
  // registry (the ones we're actually authorized to deploy into) plus any
  // subscription IDs already used on existing host pools (covers the case
  // where a subscription was used for a host pool before RBAC-grant
  // tracking caught up, or a registry row's subscription_id is still
  // null/pending). De-duplicated, RBAC-granted ones listed first since
  // they're the ones most likely to actually work.
  useEffect(() => {
    if (!tenantId) return;
    Promise.all([
      getOnboardingRegistry(tenantId).catch(() => []),
      listHostPools(tenantId).catch(() => []),
    ]).then(([registryRows, hostPools]) => {
      const granted = registryRows
        .filter((r) => r.subscription_id && r.rbac_grant_status === "granted")
        .map((r) => r.subscription_id as string);
      const others = registryRows
        .filter((r) => r.subscription_id && r.rbac_grant_status !== "granted")
        .map((r) => r.subscription_id as string);
      const fromHostPools = hostPools.map((h) => h.subscription_id);
      const seen = new Set<string>();
      const ordered = [...granted, ...others, ...fromHostPools].filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      setKnownSubscriptionIds(ordered);

      const names: Record<string, string> = {};
      for (const r of registryRows) {
        if (r.subscription_id) names[r.subscription_id] = r.subscription_display_name || r.subscription_id;
      }
      setSubscriptionNames(names);
    });
  }, [tenantId]);

  // Location dropdown is sourced from Settings > Service Variables'
  // "regions" selection, per Adam's request — an admin narrows down the
  // full Azure region catalog once, and every deployment form (starting
  // with this one) only offers the regions they've allowed.
  useEffect(() => {
    if (!tenantId) return;
    listServiceVariables(tenantId)
      .then((vars) => {
        const regions = vars.find((v) => v.key === "regions");
        if (!regions) return;
        const allowed = regions.options.filter((o) => regions.selectedValues.includes(o.value));
        setAvailableRegions(allowed);
      })
      .catch(() => {
        /* non-fatal — falls back to the free-text location input below */
      });
  }, [tenantId]);

  function openTemplate(t: TemplateDefinition) {
    setActiveTemplate(t);
    setName("");
    setSubscriptionId(knownSubscriptionIds[0] ?? "");
    setResourceGroup("");
    setLocation(availableRegions[0]?.value ?? "eastus");
    setMaxSessionLimit(t.preset.defaultMaxSessionLimit);
    setError("");
    setSuccess("");
  }

  async function handleDeploy() {
    if (!activeTemplate) return;
    if (!tenantId) {
      setError("No tenant selected — complete Settings > Onboarding first.");
      return;
    }
    if (!name || !subscriptionId || !resourceGroup || !location) {
      setError("Name, Subscription ID, Resource Group, and Location are all required.");
      return;
    }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await createHostPool(tenantId, {
        subscriptionId,
        resourceGroup,
        name,
        location,
        hostPoolType: activeTemplate.preset.hostPoolType,
        loadBalancerType: activeTemplate.preset.loadBalancerType,
        preferredAppGroupType: activeTemplate.preset.preferredAppGroupType,
        maxSessionLimit: activeTemplate.preset.showMaxSessionLimit ? maxSessionLimit : activeTemplate.preset.defaultMaxSessionLimit,
      });
      if (result.warning) {
        setError(result.warning);
      } else {
        setSuccess(`Host pool "${result.name}" deployed. Redirecting to Host Pools…`);
        setTimeout(() => router.push(`/host-pools/${result.id}`), 1200);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DeployLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {TEMPLATES.map((t) => (
          <button key={t.id} onClick={() => openTemplate(t)} style={{ alignSelf: "flex-start" }}>
            {t.label}
          </button>
        ))}

        <button
          className="secondary"
          style={{ alignSelf: "flex-start" }}
          onClick={() =>
            window.open(
              "https://portal.azure.com/#blade/Microsoft_Azure_CreateUIDef/CustomDeploymentBlade/uri/https%3A%2F%2Fraw.githubusercontent.com%2FAzure%2Favdaccelerator%2Fmain%2Fworkload%2Farm%2Fdeploy-baseline.json/uiFormDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2FAzure%2Favdaccelerator%2Fmain%2Fworkload%2Fportal-ui%2Fportal-ui-baseline.json",
              "_blank",
              "noopener,noreferrer"
            )
          }
        >
          Deploy Azure Virtual Desktop To An Application Landing Zone
        </button>
        <div className="card">
          <p style={{ margin: 0 }}>
            An enterprise-scale Azure landing zone ensures consistent governance, security, and
            operational readiness across Azure environments. Complete this foundation before
            deploying Azure Virtual Desktop to ensure security and compliance requirements are met.
            This opens Microsoft&apos;s real Deploy-to-Azure portal experience for the{" "}
            <a href="https://github.com/Azure/avdaccelerator" target="_blank" rel="noreferrer">
              Azure Virtual Desktop accelerator
            </a>{" "}
            (baseline ARM template + custom portal UI definition, both served directly from that
            repo) — not a reimplementation, the real thing.
          </p>
        </div>
      </div>

      {activeTemplate && (
        <SidePanel open={!!activeTemplate} onClose={() => setActiveTemplate(null)} title={activeTemplate.label}>
          <p>{activeTemplate.description}</p>
          {error && <p className="err">{error}</p>}
          {success && <p className="warn">{success}</p>}

          <label>Host Pool Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="contoso-desktops-01" />

          <label>Subscription ID</label>
          {knownSubscriptionIds.length > 0 ? (
            <select value={subscriptionId} onChange={(e) => setSubscriptionId(e.target.value)}>
              {knownSubscriptionIds.map((id) => (
                <option key={id} value={id}>
                  {subscriptionNames[id] ?? id}
                </option>
              ))}
              <option value="">Other (enter manually)…</option>
            </select>
          ) : (
            <p className="warn" style={{ marginTop: 0 }}>
              No subscriptions on file yet for this tenant — complete Settings &gt; Onboarding&apos;s RBAC
              deployment step, or enter one manually below.
            </p>
          )}
          {(knownSubscriptionIds.length === 0 || subscriptionId === "") && (
            <input
              value={subscriptionId}
              onChange={(e) => setSubscriptionId(e.target.value)}
              placeholder="11111111-1111-1111-1111-111111111111"
            />
          )}

          <label>Resource Group</label>
          <input value={resourceGroup} onChange={(e) => setResourceGroup(e.target.value)} placeholder="rg-avd-prod" />

          <label>Location</label>
          {availableRegions.length > 0 ? (
            <select value={location} onChange={(e) => setLocation(e.target.value)}>
              {availableRegions.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          ) : (
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="eastus" />
          )}

          {activeTemplate.preset.showMaxSessionLimit && (
            <>
              <label>Max Sessions Per Host</label>
              <input
                type="number"
                value={maxSessionLimit}
                onChange={(e) => setMaxSessionLimit(Number(e.target.value))}
                min={1}
              />
            </>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleDeploy} disabled={busy}>
              {busy ? "Deploying…" : "Deploy"}
            </button>
            <button className="secondary" onClick={() => setActiveTemplate(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </SidePanel>
      )}
    </DeployLayout>
  );
}
