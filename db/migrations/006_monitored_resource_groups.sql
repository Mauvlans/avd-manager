-- Admin-selectable list of resource groups AVD Manager actively discovers
-- resources in (host pools, application groups, workspaces created
-- OUTSIDE this product), per Adam's request: "wanna add a section for
-- monitor resource groups? With a picker to select which ones to
-- monitor?"
--
-- Scoped per (tenant, subscription) since a tenant can have multiple
-- granted subscriptions (subscriptions_registry), each with its own set
-- of resource groups worth monitoring — not a single global list.
--
-- selected_resource_groups is a JSON array of resource group NAMES (not
-- full ARM resource ids — resource groups are subscription-scoped, so
-- (subscriptionId, name) is already a unique real-world identifier,
-- matching how service_variables stores its selections as a JSON array
-- rather than one row per selected value).
CREATE TABLE monitored_resource_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL,
  selected_resource_groups JSONB NOT NULL DEFAULT '[]',
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subscription_id)
);

CREATE INDEX idx_monitored_resource_groups_tenant ON monitored_resource_groups(tenant_id);

ALTER TABLE monitored_resource_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_monitored_resource_groups ON monitored_resource_groups
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));
