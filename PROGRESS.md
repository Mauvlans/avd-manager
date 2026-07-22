# AVD Manager — Progress Report (Phase 0 spike: VALIDATED)

Repo: `/mnt/ai-work/avd-manager`. Latest commit `ef7d73e`. Also mirrored to a real public repo: https://github.com/Mauvlans/avd-manager.

## HEADLINE: Phase 0 spike is done and passed, against real Azure/Entra infrastructure

The original plan's framing was: before investing further, validate that the Graph-consent + RBAC delegation model (no Azure Lighthouse) actually works end-to-end against a real tenant and subscription. As of this round, **it does** — verified live, not mocked, not simulated:

1. **Platform Setup** (device-code sign-in) created a real multi-tenant Entra app registration in Adam's tenant, including a working Web redirect URI (after fixing an initial omission) and surviving Entra's post-creation propagation delay (after adding a ~20s wait, which fixed a repeatable AADSTS650051 failure).
2. **Graph admin consent** (grant a) was completed for real by Adam as the tenant's Global Admin. The API auto-created the tenant row from Microsoft's own consent redirect (no manual tenant-GUID entry) and correctly resolved the app's real service principal object id (`ae2eff00-ecea-4a59-85ba-99def06918fc`) via a separate Graph lookup — Microsoft's redirect does NOT include this id, contrary to this codebase's first (wrong) assumption.
3. **Deploy-to-Azure RBAC role** (grant b) was deployed for real into Adam's subscription (`e6ab1306-dfc4-4975-9f15-1df30c4699e2`), creating a genuine custom least-privilege role (`AVD Manager - Least Privilege (3y6hkn6vnpzgg)`) and role assignment — confirmed via the real role definition JSON Adam pulled from the Azure portal. Correctly scoped to only `Microsoft.DesktopVirtualization/*`, `Microsoft.Compute/virtualMachines/*` + instanceView read, `Microsoft.Resources/subscriptions/resourceGroups/read`, and (added this round) `Microsoft.Authorization/roleAssignments/read` — never Owner/Contributor.
4. **Permission health-check job** (`permissionHealthCheck.ts` + the new `ArmRoleAssignmentVerifier`) ran for real against Adam's subscription using an app-only (client-credentials) ARM token, called the real `roleAssignments` list API, and correctly confirmed the grant is intact: `{"checked":1,"driftDetected":0}`, with `rbac_last_verified_at` updated in the DB to match.

This is the core product thesis validated: a multi-tenant SaaS control plane CAN delegate access into a customer's Azure tenant/subscription using only a standard Entra app registration + two independent, customer-auditable grants (Graph admin consent, Azure RBAC custom role) — no Azure Lighthouse, no opaque delegation blade — and CAN independently re-verify that access stays intact over time via a periodic health check, which is the direct architectural substitute for what Lighthouse would otherwise provide for free.

## Bugs found and fixed via this live testing (none of these were caught by mocked unit tests)

1. `withTenant`'s `SET LOCAL app.current_tenant = $1` — Postgres rejects bound parameters in `SET LOCAL`; fixed via `set_config()`.
2. Setup's created app registration had no Web redirect URI — every real consent attempt failed with AADSTS500113.
3. Redirect URI defaulted to `localhost`, unreachable from a different machine on the LAN — fixed to the sandbox's real LAN IP, then to a Cloudflare quick-tunnel HTTPS URL once Azure's HTTPS-only requirement for Web redirect URIs was hit.
4. Assumed Microsoft's consent redirect includes a `servicePrincipalId` param — it doesn't. Fixed by resolving it via a separate Graph lookup using an app-only token.
5. Fresh app registrations hit AADSTS650051 ("removed or misconfigured") on every real sign-in attempt — an Entra propagation-delay issue on the STS side (not the Graph object, which is readable immediately); fixed with a ~20s wait after creation.
6. Assumed Azure's Deploy-to-Azure button URL supports parameter auto-fill via query string (tried plain query params, then fragment-appended params) — neither works; confirmed via Microsoft's own docs that only template `defaultValue`s pre-fill. Abandoned auto-fill; now shows the SP id in a copy-to-clipboard box instead.
7. `navigator.clipboard` is undefined (not just permission-denied) in non-secure contexts (plain `http://` on a LAN IP) — added a `document.execCommand('copy')` fallback.
8. `getDeployToAzureUrl`'s SP-id lookup only checked the "pending" (subscription_id IS NULL) registry row — that row stops existing the moment RBAC grant succeeds, so regenerating the link afterward (e.g. to re-deploy with an updated role) found nothing. Fixed to fall back to any registry row for the tenant with a non-null SP id.
9. The custom least-privilege role didn't include `Microsoft.Authorization/roleAssignments/read` — so the app couldn't list its own role assignments to verify itself; ARM silently returned an empty list rather than an explicit permission error, making this look like a code bug before the real cause (a missing role action) was found.
10. No request logging in the API at all — added minimal method/path/status/duration logging, which was essential for diagnosing bug #4/#5 above (a browser-observed 302 redirect left zero server-side trace without it).

## What's done (cumulative, from prior rounds)

### Backend (apps/api)
- Control-plane Postgres schema + RLS (tenants, subscriptions_registry — now with nullable `subscription_id` for the pending-grant window, host_pools, scaling_policies, audit_log).
- Platform Setup flow (`/api/setup/*`): device-code sign-in, app registration creation with Web redirect URI + admin-consent app-role grants, in-memory `platformConfigStore` (activates immediately, no restart) + append-only local log of created app registrations (`platform-app-registrations.log`, gitignored) as a durability stopgap.
- Onboarding flow (`/api/onboarding/*`): Graph consent URL generation, auto tenant creation from the consent redirect, Deploy-to-Azure URL + SP-id lookup, registry status-poll endpoint, RBAC-grant callback.
- ARM `Microsoft.DesktopVirtualization` + `Microsoft.Compute` client (`armHostPoolClient.ts`) with real LRO polling (no fire-and-forget) for host pool create/delete, session host create/delete/start/deallocate.
- **New: `ArmRoleAssignmentVerifier`** — real ARM-backed permission-health-check verifier (replaces the always-true stub when a real platform app+secret are configured), live-validated against Adam's subscription.
- `autoscaleTimer.ts`, `scalingActionRetryWorker.ts` (bounded one-retry outbox pattern), tenant auth middleware, cost estimator (live against the public Azure Retail Prices API).
- 62/62 jest tests passing across 9 suites.

### Frontend (apps/web, Next.js pages-router)
- Onboarding wizard: Platform Setup (step 0, conditional), Graph consent (step 1, auto-derives tenant), Deploy-to-Azure with copy-to-clipboard SP id box + deploy link (step 2), live registry status polling (step 3).
- Host pool list/detail with session-host table, scaling policy config, cost dashboard, audit log viewer.

### Infra
- Bicep (`rbac-delegation.bicep`) + hand-transpiled ARM JSON equivalent (`rbac-delegation.json`, since no `bicep` CLI is available in this sandbox) — both kept in sync, both now include `Microsoft.Authorization/roleAssignments/read`. Published to a real public GitHub repo (`Mauvlans/avd-manager`) so Azure's portal can actually fetch it (the original placeholder `avd-manager/avd-manager` path never existed).
- `docker-compose.yml` + Dockerfiles — still not run (no Docker binary in this sandbox); each Dockerfile's build command sequence was hand-reproduced outside Docker in an earlier round and found no bugs.

## Known gaps / not started

1. **`docker compose up` never actually executed** — no Docker binary in this sandbox.
2. **No real per-user auth** — tenant auth is shared-secret + DB tenant-status check, not JWT/Entra-claim-based.
3. **Platform config is in-memory only** — a process restart loses the active app registration (client id/secret are logged to a local file as a stopgap, but nothing auto-reloads from it). Needs to move to persisted config (Key Vault + DB row) for a real deployment.
4. **The Deploy-to-Azure template has no automatic way to notify the API when it completes** — recording the RBAC grant currently either requires the periodic health-check job to pick it up (which now works, per this round's validation) or a manual `/rbac-grant/callback` call. This is an acceptable trade per the "no Lighthouse, no delegation blade, just periodic re-verification" architecture — not a gap to fix, but worth being explicit that there's no synchronous confirmation the instant a deployment finishes.
5. **Retry worker retries only once**, no dead-letter visibility UI.
6. **No CI/CD pipeline.**
7. **No rate limiting / request schema validation middleware.**
8. Cost estimator remains the only live external call besides the now-validated Graph/ARM calls from this round.

## Exact next steps for a future continuation round

1. Persist platform config (client id/secret) durably instead of in-memory-only — Key Vault + a DB row, so a restart doesn't require redoing Platform Setup.
2. Schedule the permission health-check job to actually run periodically (cron, or a proper background worker) instead of being invoked manually/on-demand as it was for this validation.
3. Get Docker available and run `docker compose build && docker compose up` for the first time.
4. Add real per-user auth (JWT validated against Entra claims).
5. Add request-schema validation middleware (zod) and basic CI.

## Architecture reminders (confirmed, now validated live — not just documented)

- Multi-tenant Entra app registration + separate Graph admin-consent grant + separate Azure RBAC custom-role Deploy-to-Azure grant. **No Azure Lighthouse anywhere.** This model has now been proven against a real Entra tenant and Azure subscription, not just designed on paper.
- Multi-tenancy: single control-plane Postgres DB with Row-Level Security, not DB-per-tenant.
- Hard safety caps (max hosts per action, max cost delta) enforced server-side in `ScalingPolicyEvaluator`.
- The custom RBAC role is genuinely least-privilege — confirmed by pulling the real deployed role definition JSON from Azure and checking its `actions` list directly, not just trusting the Bicep source.

## Retired the custom scaling engine — native AVD Scaling Plans only

Adam's explicit decision: don't build a competing autoscaling/cost-optimization
engine when Azure already ships native AVD Scaling Plans
(`Microsoft.DesktopVirtualization/scalingPlans`) for free. Retired the custom
engine entirely rather than keeping both:

- Deleted: `scalingPolicyEvaluator.ts` (+ test), `autoscaleTimer.ts`,
  `scalingActionRetryWorker.ts` (+ test), `routes/scalingPolicies.ts`.
- Cost estimation (which shared a file with the retired scaling-policy
  routes) survived, split out into its own `routes/cost.ts`.
- Added `services/armScalingPlanClient.ts` — thin ARM REST wrapper over
  native scalingPlans (list/get/createOrUpdate/delete, plus attach/detach
  which is a read-modify-write over the plan's `hostPoolReferences` array,
  since ARM has no separate attach/detach verb), matching
  `armHostPoolClient.ts`'s FetchLike/TokenProvider/ArmLroResult/LRO-polling
  conventions exactly. Mock-based tests added (`armScalingPlanClient.test.ts`).
- Added `routes/scalingPlans.ts` (CRUD + attach/detach), registered in
  `server.ts` in place of the old scaling-policies router.
- `db/migrations/003_drop_scaling_policies.sql` drops the now-unused table
  (smoke-tested against local Postgres). `001_init.sql` left untouched as
  historical record.
- Frontend: `pages/scaling-plans.tsx` (new, subscription+resourceGroup
  scoped, since a native plan attaches to multiple host pools) replaces the
  scaling-policy form that used to live on the host-pool detail page;
  `lib/api.ts` scaling-policy functions replaced with scaling-plan
  equivalents.
- `npx tsc --noEmit` clean on both `apps/api` and `apps/web`; full test
  suite passes (8 suites / 57 tests, old scaling-engine suites gone, new
  ARM client suite added).
