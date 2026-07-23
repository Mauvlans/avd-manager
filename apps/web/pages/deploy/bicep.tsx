import { useRef, useState } from "react";
import DeployLayout from "../../components/DeployLayout";
import { uploadCustomTemplate } from "../../lib/api";
import { useTenantId } from "../../lib/useTenantId";

/**
 * Deploy > Bicep — customer uploads their own .bicep or ARM .json
 * template; we compile it (real Azure Bicep CLI, see
 * apps/api/src/services/bicepCompiler.ts), parse its top-level
 * `parameters` block into a form, and hand back a real Deploy-to-Azure
 * link once the admin fills in the (optional) parameter overrides.
 *
 * Deliberately does NOT execute the deployment ourselves — the generated
 * link opens portal.azure.com's Custom Deployment blade, and the actual
 * ARM deployment runs under the ADMIN's OWN Azure portal session /
 * credentials when they click through, not under AVD Manager's service
 * principal. We're only compiling + hosting the template, never executing
 * it — same trust model as the RBAC delegation template and the
 * avdaccelerator landing-zone link elsewhere on this Deploy page.
 */
export default function DeployBicep() {
  const [tenantId] = useTenantId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Awaited<ReturnType<typeof uploadCustomTemplate>> | null>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !tenantId) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await uploadCustomTemplate(tenantId, file);
      setResult(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  if (!tenantId) {
    return (
      <DeployLayout>
        <p className="warn">
          No tenant selected yet — complete <a href="/onboarding">Settings &gt; Onboarding</a> first.
        </p>
      </DeployLayout>
    );
  }

  return (
    <DeployLayout>
      <p>
        Upload your own .bicep or ARM .json template. We&apos;ll compile it (if needed), show you the
        parameters it expects, and generate a Deploy-to-Azure link — the actual deployment runs under
        your own Azure portal session when you click it, not ours.
      </p>

      <div className="card">
        <label>Template File (.bicep or .json)</label>
        <input ref={fileInputRef} type="file" accept=".bicep,.json" onChange={handleFileChange} disabled={busy} />
        {busy && <p className="warn">Compiling and parsing…</p>}
        {error && <p className="err">{error}</p>}
      </div>

      {result && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>{result.fileName}</h2>

          {result.parameters.length === 0 ? (
            <p>This template has no parameters.</p>
          ) : (
            <>
              <p>Parameters this template expects:</p>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #21262d" }}>
                    <th style={{ padding: "4px 8px" }}>Name</th>
                    <th style={{ padding: "4px 8px" }}>Type</th>
                    <th style={{ padding: "4px 8px" }}>Required</th>
                    <th style={{ padding: "4px 8px" }}>Default</th>
                    <th style={{ padding: "4px 8px" }}>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {result.parameters.map((p) => (
                    <tr key={p.name} style={{ borderBottom: "1px solid #21262d" }}>
                      <td style={{ padding: "4px 8px" }}>
                        <code>{p.name}</code>
                      </td>
                      <td style={{ padding: "4px 8px" }}>{p.type}</td>
                      <td style={{ padding: "4px 8px" }}>{p.required ? "Yes" : "No"}</td>
                      <td style={{ padding: "4px 8px" }}>
                        {p.defaultValue !== undefined ? JSON.stringify(p.defaultValue) : "—"}
                      </td>
                      <td style={{ padding: "4px 8px" }}>{p.description ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="warn" style={{ marginTop: 12 }}>
                Fill in any required parameters directly on the Azure portal&apos;s Custom Deployment
                page once it opens — Azure&apos;s own form is the source of truth for parameter input,
                we don&apos;t re-implement it here.
              </p>
            </>
          )}

          <a href={result.deployUrl} target="_blank" rel="noreferrer">
            <button style={{ marginTop: 12 }}>Deploy To Azure</button>
          </a>
        </div>
      )}
    </DeployLayout>
  );
}
