-- Cost Optimization platform, Phase 2 (per Adam's plan, message.txt §
-- 4.3/§ 6.6): normalized cost facts. Deliberately simpler than the
-- plan's full cost_facts schema for this first slice (no monthly
-- partitioning yet, fewer columns) — real Cost Management data, real
-- idempotent upserts, real RLS, extended in later passes as actual usage
-- reveals what's needed rather than speculatively building every column
-- the plan lists.
CREATE TABLE cost_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL,
  usage_date DATE NOT NULL,
  azure_resource_id TEXT,
  meter_category TEXT,
  meter_subcategory TEXT,
  service_family TEXT,
  charge_type TEXT,
  cost_type TEXT NOT NULL, -- 'ActualCost' | 'AmortizedCost'
  cost NUMERIC(20, 6) NOT NULL,
  currency TEXT NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent-upsert key per the plan's § 9.3 guidance: a cost record is
-- uniquely identified by (subscription, date, resource, meter breakdown,
-- cost type) — re-ingesting the same query result updates in place
-- rather than duplicating, since Cost Management data can be corrected
-- after its initial appearance (plan § 4.3). Built as a functional
-- unique index with COALESCE rather than a plain UNIQUE constraint,
-- because several of these columns (azure_resource_id, meter_category,
-- meter_subcategory, charge_type) are legitimately NULL for some cost
-- records — Postgres treats NULL <> NULL in a normal UNIQUE constraint,
-- which would let duplicate NULL-having rows accumulate instead of
-- upserting. COALESCE to a real sentinel string closes that gap.
CREATE UNIQUE INDEX ux_cost_facts_identity ON cost_facts (
  tenant_id, subscription_id, usage_date, cost_type,
  COALESCE(azure_resource_id, ''), COALESCE(meter_category, ''),
  COALESCE(meter_subcategory, ''), COALESCE(charge_type, '')
);

CREATE INDEX idx_cost_facts_tenant_date ON cost_facts(tenant_id, usage_date);
CREATE INDEX idx_cost_facts_tenant_resource ON cost_facts(tenant_id, azure_resource_id);
CREATE INDEX idx_cost_facts_tenant_service ON cost_facts(tenant_id, service_family, usage_date);

ALTER TABLE cost_facts ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_cost_facts ON cost_facts
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));
