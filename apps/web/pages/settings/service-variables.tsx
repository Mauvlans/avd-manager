import { useEffect, useState } from "react";
import SettingsLayout from "../../components/SettingsLayout";
import { listServiceVariables, updateServiceVariable, ServiceVariableRow } from "../../lib/api";
import { useTenantId } from "../../lib/useTenantId";

/**
 * Settings > Service Variables — per Adam's request: admin-configurable
 * lists (starting with Regions) that narrow down what shows up in
 * deployment forms elsewhere in the product (Deploy > Template's Location
 * field reads the tenant's selected regions instead of a free-text
 * input). Built generically (GET returns an array of {key, options,
 * selectedValues} — see apps/api/src/services/serviceVariableCatalogs.ts)
 * so more variables (VM sizes, timezones, etc.) show up here automatically
 * once added to that catalog, with no page changes needed.
 */
export default function ServiceVariables() {
  const [tenantId] = useTenantId();
  const [variables, setVariables] = useState<ServiceVariableRow[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    listServiceVariables(tenantId)
      .then(setVariables)
      .catch((err) => setError((err as Error).message));
  }, [tenantId]);

  function toggle(variableKey: string, optionValue: string) {
    setVariables((prev) =>
      prev.map((v) => {
        if (v.key !== variableKey) return v;
        const isSelected = v.selectedValues.includes(optionValue);
        return {
          ...v,
          selectedValues: isSelected
            ? v.selectedValues.filter((x) => x !== optionValue)
            : [...v.selectedValues, optionValue],
        };
      })
    );
  }

  async function save(variableKey: string) {
    if (!tenantId) return;
    const variable = variables.find((v) => v.key === variableKey);
    if (!variable) return;
    setSaving(variableKey);
    setError("");
    setSavedKey(null);
    try {
      await updateServiceVariable(tenantId, variableKey, variable.selectedValues);
      setSavedKey(variableKey);
      setTimeout(() => setSavedKey(null), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
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

  return (
    <SettingsLayout>
      <p>
        Choose which options are available in deployment forms elsewhere in the product (e.g. Deploy
        &gt; Template&apos;s Location field). Unchecked options won&apos;t show up as choices.
      </p>
      {error && <p className="err">{error}</p>}

      {variables.map((variable) => (
        <div key={variable.key} className="card">
          <h2 style={{ marginTop: 0, textTransform: "capitalize" }}>{variable.key}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 4, marginBottom: 12 }}>
            {variable.options.map((opt) => (
              <label key={opt.value} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 0 }}>
                <input
                  type="checkbox"
                  style={{ width: "auto", margin: 0 }}
                  checked={variable.selectedValues.includes(opt.value)}
                  onChange={() => toggle(variable.key, opt.value)}
                />
                {opt.label}
              </label>
            ))}
          </div>
          <button onClick={() => save(variable.key)} disabled={saving === variable.key}>
            {saving === variable.key ? "Saving…" : "Save"}
          </button>
          {savedKey === variable.key && <span className="warn" style={{ marginLeft: 12 }}>Saved</span>}
        </div>
      ))}
    </SettingsLayout>
  );
}
