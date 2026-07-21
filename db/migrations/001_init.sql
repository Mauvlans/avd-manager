-- Initial control-plane schema: tenants, subscriptions_registry, host_pools,
-- scaling_policies, audit_log. Row-Level Security enforces tenant isolation.
--
-- App code sets `SET app.current_tenant = '<tenant-uuid>'` at the start of every
-- request/transaction (see apps/api/src/db/pool.ts). All tenant-scoped tables have
-- an RLS policy requiring tenant_id to match that setting. A separate
-- `app_admin` role (used only by internal ops tooling / migrations) bypasses RLS.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  entra_tenant_id UUID NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding', 'active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL,
  resource_groups TEXT[] NOT NULL DEFAULT '{}',
  rbac_role_definition_id TEXT,
  rbac_grant_status TEXT NOT NULL DEFAULT 'not_requested'
    CHECK (rbac_grant_status IN ('not_requested', 'pending', 'granted', 'drifted', 'revoked')),
  rbac_last_verified_at TIMESTAMPTZ,
  rbac_drift_details TEXT,
  graph_consent_status TEXT NOT NULL DEFAULT 'not_requested'
    CHECK (graph_consent_status IN ('not_requested', 'pending', 'granted', 'revoked')),
  graph_consent_service_principal_id TEXT,
  graph_consent_granted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subscription_id)
);

CREATE TABLE host_pools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL,
  resource_group TEXT NOT NULL,
  name TEXT NOT NULL,
  location TEXT NOT NULL,
  host_pool_type TEXT NOT NULL CHECK (host_pool_type IN ('Personal', 'Pooled')),
  load_balancer_type TEXT NOT NULL CHECK (load_balancer_type IN ('BreadthFirst', 'DepthFirst', 'Persistent')),
  max_session_limit INTEGER NOT NULL DEFAULT 10,
  session_host_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subscription_id, resource_group, name)
);

CREATE TABLE scaling_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  host_pool_id UUID NOT NULL REFERENCES host_pools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('schedule', 'dynamic_threshold')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  schedule_config JSONB,
  dynamic_config JSONB,
  -- Safety caps are non-negotiable and always present; sensible conservative
  -- defaults so a policy can never be created without a cap.
  max_hosts_per_action INTEGER NOT NULL DEFAULT 2 CHECK (max_hosts_per_action > 0),
  max_cost_delta_per_action_usd_per_hour NUMERIC(10, 2) NOT NULL DEFAULT 5.00
    CHECK (max_cost_delta_per_action_usd_per_hour > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_subscriptions_registry_tenant ON subscriptions_registry(tenant_id);
CREATE INDEX idx_host_pools_tenant ON host_pools(tenant_id);
CREATE INDEX idx_scaling_policies_tenant ON scaling_policies(tenant_id);
CREATE INDEX idx_scaling_policies_host_pool ON scaling_policies(host_pool_id);
CREATE INDEX idx_audit_log_tenant ON audit_log(tenant_id);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);

-- Row Level Security -----------------------------------------------------

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE host_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE scaling_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- tenants: a session may only see its own tenant row. Tenant creation
-- (onboarding) happens through a privileged path (app_admin role) that
-- bypasses RLS, since at creation time there's no tenant context yet.
CREATE POLICY tenant_isolation_tenants ON tenants
  USING (id::text = current_setting('app.current_tenant', true));

CREATE POLICY tenant_isolation_subscriptions_registry ON subscriptions_registry
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));

CREATE POLICY tenant_isolation_host_pools ON host_pools
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));

CREATE POLICY tenant_isolation_scaling_policies ON scaling_policies
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));

CREATE POLICY tenant_isolation_audit_log ON audit_log
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));

-- Application role used by the API at runtime. It is NOT a superuser and
-- does NOT have BYPASSRLS, so RLS policies above are actually enforced for it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'avd_app') THEN
    CREATE ROLE avd_app LOGIN PASSWORD 'avd_app_password_change_me';
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO avd_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO avd_app;
