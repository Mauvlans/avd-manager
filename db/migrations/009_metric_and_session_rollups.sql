-- Cost Optimization platform, Phase 3 (per Adam's plan, message.txt §
-- 4.7/§ 6.7): metric rollups for session-host VMs. Deliberately just
-- hourly for this first slice (no separate daily-rollup table, no
-- partitioning yet) — real Azure Monitor data, real upserts, real RLS.
CREATE TABLE metric_hourly (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  azure_resource_id TEXT NOT NULL,
  metric_time TIMESTAMPTZ NOT NULL,
  metric_name TEXT NOT NULL,
  average_value DOUBLE PRECISION,
  maximum_value DOUBLE PRECISION,
  minimum_value DOUBLE PRECISION,
  unit TEXT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_metric_hourly_identity ON metric_hourly (tenant_id, azure_resource_id, metric_time, metric_name);
CREATE INDEX idx_metric_hourly_tenant_resource ON metric_hourly(tenant_id, azure_resource_id, metric_time);

ALTER TABLE metric_hourly ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_metric_hourly ON metric_hourly
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));

-- AVD session/scaling facts, per plan § 6.8 (simplified: no
-- session_host_uuid granularity yet, host-pool level only for this
-- first slice — session-host-level detail is a follow-up once the
-- WVDConnections/Log Analytics collector, plan § 4.8, is built).
CREATE TABLE avd_session_hourly (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  host_pool_azure_resource_id TEXT NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,
  running_session_host_count INTEGER,
  active_session_host_count INTEGER,
  total_sessions INTEGER,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_avd_session_hourly_identity ON avd_session_hourly (tenant_id, host_pool_azure_resource_id, bucket_start);

ALTER TABLE avd_session_hourly ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_avd_session_hourly ON avd_session_hourly
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));
