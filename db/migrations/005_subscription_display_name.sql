-- Adds subscription_display_name to subscriptions_registry — the real
-- Azure Subscription resource's displayName (e.g. "MSFT - External Sub -
-- Mauvlan"), fetched via ARM's GET /subscriptions/{id} at the moment RBAC
-- is granted (see onboardingService.recordRbacGranted), so the Host Pools
-- table can show a human-readable subscription label instead of a raw
-- GUID, per Adam's Host Pools mock. Nullable — if the ARM lookup fails
-- (network hiccup, insufficient permission on that one call), the row
-- still records successfully; the UI falls back to the raw subscription
-- id.
ALTER TABLE subscriptions_registry ADD COLUMN subscription_display_name TEXT;
