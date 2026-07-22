import { Router } from "express";
import { withTenant } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import { SERVICE_VARIABLE_CATALOGS, isKnownVariableKey } from "../services/serviceVariableCatalogs";
import { tenantAuth } from "../middleware/tenantAuth";

/**
 * Settings > Service Variables — admin-configurable lists that narrow down
 * what shows up in deployment forms elsewhere in the product (Deploy >
 * Template's Location field, etc.), per Adam's request. GET returns both
 * the full catalog (every option that COULD be selected) and the tenant's
 * current selection; PUT replaces the selection for one variable key.
 *
 * Tenant-scoped (tenantAuth + withTenant/RLS) since different customer
 * tenants may need different regions available (data residency,
 * compliance) — matches this product's existing multi-tenant design
 * rather than one global admin-only config.
 */
export const serviceVariablesRouter = Router();

serviceVariablesRouter.use(tenantAuth);

serviceVariablesRouter.get("/", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const rows = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(`SELECT variable_key, selected_values FROM service_variables WHERE tenant_id = $1`, [
      tenantId,
    ]);
    return rows;
  });
  const selectedByKey = new Map(rows.map((r) => [r.variable_key, r.selected_values]));

  const result = Object.entries(SERVICE_VARIABLE_CATALOGS).map(([key, options]) => ({
    key,
    options,
    // Default to ALL options selected if the admin has never configured
    // this variable yet — an unconfigured variable should not silently
    // hide every option from every form that reads it.
    selectedValues: selectedByKey.get(key) ?? options.map((o) => o.value),
  }));
  res.json(result);
});

serviceVariablesRouter.put("/:key", async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const key = req.params.key;
  const { selectedValues } = req.body ?? {};

  if (!isKnownVariableKey(key)) {
    return res.status(404).json({ error: `unknown service variable key: ${key}` });
  }
  if (!Array.isArray(selectedValues) || !selectedValues.every((v) => typeof v === "string")) {
    return res.status(400).json({ error: "selectedValues must be an array of strings" });
  }
  const validValues = new Set(SERVICE_VARIABLE_CATALOGS[key].map((o) => o.value));
  const invalid = selectedValues.filter((v) => !validValues.has(v));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `not valid options for ${key}: ${invalid.join(", ")}` });
  }

  await withTenant(tenantId, async (client) => {
    const { rows: existing } = await client.query(
      `SELECT selected_values FROM service_variables WHERE tenant_id = $1 AND variable_key = $2`,
      [tenantId, key]
    );
    const before = existing[0]?.selected_values ?? null;

    await client.query(
      `INSERT INTO service_variables (tenant_id, variable_key, selected_values)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (tenant_id, variable_key)
       DO UPDATE SET selected_values = $3::jsonb, updated_at = now()`,
      [tenantId, key, JSON.stringify(selectedValues)]
    );

    await writeAuditLog(client, {
      tenantId,
      actor: req.header("x-actor") || "unknown",
      action: "service_variable_updated",
      resourceType: "service_variables",
      resourceId: key,
      beforeState: before,
      afterState: selectedValues,
    });
  });

  res.json({ key, selectedValues });
});
