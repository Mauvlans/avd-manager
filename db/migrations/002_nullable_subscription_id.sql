-- Graph admin consent (grant a) happens tenant-wide, before any Azure
-- subscription is known — the customer picks/registers subscriptions
-- separately via the Deploy-to-Azure RBAC template (grant b). The original
-- schema required subscription_id NOT NULL on every subscriptions_registry
-- row, which forced onboarding to ask for a subscription id before Graph
-- consent even existed. Relax that so a "graph consent granted, no
-- subscription yet" placeholder row is representable, and the RBAC grant
-- step fills subscription_id in on the same row afterward.
ALTER TABLE subscriptions_registry ALTER COLUMN subscription_id DROP NOT NULL;

-- The original UNIQUE (tenant_id, subscription_id) constraint still holds
-- for rows that do have a subscription_id (Postgres treats multiple NULLs
-- as distinct, so this doesn't block multiple NULL-subscription rows on its
-- own) — but we also want at most one "graph-consent-only, no subscription
-- yet" placeholder row per tenant, so a second Graph-consent click doesn't
-- create duplicate placeholders while the customer is still mid-onboarding.
CREATE UNIQUE INDEX idx_subscriptions_registry_one_pending_per_tenant
  ON subscriptions_registry (tenant_id)
  WHERE subscription_id IS NULL;
