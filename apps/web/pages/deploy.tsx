import { useState } from "react";
import { useRouter } from "next/router";
import DeployLayout from "../components/DeployLayout";
import { createHostPool } from "../lib/api";
import { useTenantId } from "../lib/useTenantId";

/**
 * Deploy > Template — prebuilt host pool templates the admin fills a few
 * details into, we publish the rest. Per Adam's mock
 * (image attached in chat) + explicit scope decision:
 *   - Simple Personal / Shared / Remote Apps host pools: we own these
 *     end-to-end — a small form collects the few fields that actually vary
 *     (name, subscription, resource group, location, session limit for
 *     Shared), everything else (load balancer type, preferredAppGroupType,
 *     etc.) is a template-specific preset baked in here, then POSTed to
 *     our existing POST /api/host-pools -> ArmHostPoolClient.
 *     createOrUpdateHostPool, the same path the Host Pools page's manual
 *     "create" flow already uses.
 *   - "Deploy Azure Virtual Desktop to an application landing zone": this
 *     is NOT something we reimplement. Microsoft's own enterprise-scale
 *     landing zone guidance
 *     (learn.microsoft.com/azure/cloud-adoption-framework/scenarios/azure-virtual-desktop/enterprise-scale-landing-zone)
 *     points to the actively-maintained github.com/Azure/avdaccelerator
 *     project, which is deployed via PowerShell/Azure CLI/pipelines, NOT a
 *     one-click portal "Deploy to Azure" button (checked directly against
 *     that repo's getting-started docs — no such button exists). So this
 *     card intentionally just links out to the real GitHub docs rather
 *     than faking a one-click deploy experience that doesn't exist.
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
  const [resourceGroup, setResourceGroup] = useState("");
  const [location, setLocation] = useState("eastus");
  const [maxSessionLimit, setMaxSessionLimit] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  function openTemplate(t: TemplateDefinition) {
    setActiveTemplate(t);
    setName("");
    setSubscriptionId("");
    setResourceGroup("");
    setLocation("eastus");
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
            window.open("https://github.com/Azure/avdaccelerator", "_blank", "noopener,noreferrer")
          }
        >
          Deploy Azure Virtual Desktop to an application landing zone
        </button>
        <div className="card">
          <p style={{ margin: 0 }}>
            An enterprise-scale Azure landing zone ensures consistent governance, security, and
            operational readiness across Azure environments. Complete this foundation before
            deploying Azure Virtual Desktop to ensure security and compliance requirements are met.
            This opens Microsoft&apos;s own{" "}
            <a href="https://github.com/Azure/avdaccelerator" target="_blank" rel="noreferrer">
              Azure Virtual Desktop accelerator
            </a>{" "}
            on GitHub — deployed via PowerShell/Azure CLI/pipeline, not a one-click portal template,
            so we link to it rather than reimplement it.
          </p>
        </div>
      </div>

      {activeTemplate && (
        <div className="card" style={{ marginTop: 24 }}>
          <h2 style={{ marginTop: 0 }}>{activeTemplate.label}</h2>
          <p>{activeTemplate.description}</p>
          {error && <p className="err">{error}</p>}
          {success && <p className="warn">{success}</p>}

          <label>Host Pool Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="contoso-desktops-01" />

          <label>Subscription ID</label>
          <input
            value={subscriptionId}
            onChange={(e) => setSubscriptionId(e.target.value)}
            placeholder="11111111-1111-1111-1111-111111111111"
          />

          <label>Resource Group</label>
          <input value={resourceGroup} onChange={(e) => setResourceGroup(e.target.value)} placeholder="rg-avd-prod" />

          <label>Location</label>
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="eastus" />

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
        </div>
      )}
    </DeployLayout>
  );
}
