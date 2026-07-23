-- Cost Optimization platform, Phase 4 (per Adam's plan, message.txt §
-- 6.9/§ 6.10/§ 11/§ 12): recommendations. Deliberately simpler than the
-- plan's full schema for this first slice (no separate
-- optimization_rules table yet — rule metadata lives in code per rule
-- module, no recommendation_observations trend table, no
-- recommendation_actions lifecycle table) — real detection against real
-- collected data, real fingerprint-based dedup, real RLS.
CREATE TABLE recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  azure_resource_id TEXT,
  fingerprint TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  risk TEXT NOT NULL,
  estimated_monthly_savings NUMERIC(20, 6),
  currency TEXT,
  confidence_score NUMERIC(5, 2),
  evidence JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (tenant_id, fingerprint)
);

CREATE INDEX idx_recommendations_open_savings ON recommendations (tenant_id, estimated_monthly_savings DESC) WHERE status = 'open';
CREATE INDEX idx_recommendations_resource ON recommendations (tenant_id, azure_resource_id);

ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_recommendations ON recommendations
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));
