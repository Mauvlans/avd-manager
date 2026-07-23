-- Cost Optimization platform, Phase 1 foundation (per Adam's plan,
-- message.txt): resource inventory table. Deliberately simpler than the
-- plan's full proposed schema (§ 6.2) for this first slice — no
-- resource_uuid/resources split into a separate physical-key table yet,
-- no partitioning, no resource_snapshots history table. Real ARM data,
-- real upserts, real RLS — just scoped to "prove inventory collection
-- works end-to-end" before building out the rest of the schema in later
-- phases.
CREATE TABLE resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL,
  azure_resource_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  resource_group TEXT,
  location TEXT,
  sku JSONB,
  tags JSONB NOT NULL DEFAULT '{}',
  properties JSONB NOT NULL DEFAULT '{}',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, azure_resource_id)
);

CREATE INDEX idx_resources_tenant_type ON resources(tenant_id, resource_type);
CREATE INDEX idx_resources_tenant_subscription ON resources(tenant_id, subscription_id);
CREATE INDEX idx_resources_tags_gin ON resources USING gin (tags);

ALTER TABLE resources ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_resources ON resources
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));

-- Tracks each inventory collection run, per the plan's § 9.1
-- collection_runs concept — every imported row should be traceable to a
-- run.
CREATE TABLE collection_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collector_type TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  record_count INTEGER,
  error_details JSONB
);

CREATE INDEX idx_collection_runs_tenant ON collection_runs(tenant_id, started_at DESC);

ALTER TABLE collection_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_collection_runs ON collection_runs
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));
