-- Generic, extensible per-tenant "service variables" store — admin-
-- configurable lists that constrain what options show up in deployment
-- forms across the product. Adam's ask: Regions first ("here we can list
-- the available regions and an admin can select which ones they want
-- available") but built so more variables (VM sizes, timezones, etc.) can
-- be added later without another migration — each row is one (tenant,
-- variable key) pair, value is a JSON array of the admin-selected values.
--
-- Deliberately per-tenant, not global: different customer tenants may be
-- restricted to different Azure regions (data residency, compliance),
-- matching this product's existing multi-tenant-with-RLS design rather
-- than a single global config.
CREATE TABLE service_variables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  variable_key TEXT NOT NULL, -- e.g. 'regions', later: 'vm_sizes', 'timezones'
  selected_values JSONB NOT NULL DEFAULT '[]', -- JSON array of selected option values
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, variable_key)
);

CREATE INDEX idx_service_variables_tenant ON service_variables(tenant_id);

ALTER TABLE service_variables ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_service_variables ON service_variables
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));
