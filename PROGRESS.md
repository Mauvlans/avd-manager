# AVD Manager — Progress Report (round 4)

Repo: `/mnt/ai-work/avd-manager`. 16 commits total, latest `4077178`.

## Verified this round (re-run directly, not just self-reported)

```
$ npm run test        → 6 suites, 49/49 passing (jest, apps/api); shared workspace: "no tests" (by design, pure types)
$ tsc --noEmit (api)  → clean
$ tsc --noEmit (web)  → clean
$ next build (web)    → clean, 8 static routes (host-pools/[id] now 3.83kB)
```

## What's done (cumulative)

### Backend (apps/api)
- Control-plane Postgres schema + RLS (tenants, subscriptions_registry, host_pools, scaling_policies, audit_log).
- Multi-tenant Entra app registration onboarding: Graph admin-consent link generation, Deploy-to-Azure RBAC Bicep template link, **`GET /api/onboarding/tenants/:id/registry`** status-poll endpoint (new round 3), now integration-tested (round 4).
- ARM `Microsoft.DesktopVirtualization` + `Microsoft.Compute` client (`armHostPoolClient.ts`):
  - `startVm` / `deallocateVm` share a `computeAction` helper with **real LRO polling** (Azure-AsyncOperation header, or a resource-existence fallback) to a terminal state or bounded timeout — no more fire-and-forget.
  - `createOrUpdateHostPool` and `deleteSessionHost` now use the same LRO-polling pattern (round 4) — return `ArmLroResult` (succeeded/failed/timeout), not a blind assumption of success on 202/201.
- `autoscaleTimer.ts`: both `start_host` and `deallocate_host` paths record real outcomes; failures/timeouts become `scaling_actions_partially_failed` audit entries instead of silently succeeding.
- `POST /api/host-pools` surfaces the real ARM LRO outcome as a warning instead of always claiming success.
- **New: `scalingActionRetryWorker.ts`** — minimal outbox/retry job. Reads unretried `scaling_actions_partially_failed` audit entries from the last 24h (idempotency via `NOT EXISTS` guard against prior retry entries), retries the failed host action **exactly once** (bounded, no infinite loop), writes `retried_success` or `retried_still_failed` either way.
- **New: session-host API routes** — `GET/POST /api/host-pools/:id/session-hosts[/:name/start|/deallocate]`, reusing the same LRO-polling `computeAction`.
- Tenant auth middleware (`tenantAuth.ts`) — shared-secret `x-api-key` gate (when `API_AUTH_TOKEN` set) + real DB tenant-status lookup, now with **supertest integration tests** (valid/unknown/suspended tenant, missing/wrong/correct api key) added round 4.
- Cost estimator — live-validated against the real public Azure Retail Prices API (unchanged, still the only live external call in the system).
- 49/49 jest tests passing across 6 suites (scalingPolicyEvaluator, armHostPoolClient, costEstimator, onboardingRegistryRoute, tenantAuth, scalingActionRetryWorker).

### Frontend (apps/web, Next.js pages-router)
- Onboarding wizard — polls the real registry endpoint every 5s (round 3).
- Host pool list/detail, scaling policy config (safety caps visibly enforced), cost dashboard, audit log viewer.
- **New (round 4): session-host table** on the host pool detail page — status/session count/VM size/last heartbeat, with Start/Deallocate buttons wired to the new session-host API routes.
- `next build` clean, 8 static routes, no type errors.

### Infra
- Bicep: custom least-privilege RBAC role + assignment (no Lighthouse), host pool template, session host template (FSLogix/AVD-agent DSC hook).
- `docker-compose.yml` + Dockerfiles (postgres/api/web) — **still not run in this sandbox (Docker not installed)**. Round 3 hand-reproduced each Dockerfile's exact build command sequence outside Docker and found no bugs, which meaningfully de-risks but does not replace an actual `docker compose up`.

## Known gaps / not started

1. **`docker compose up` never actually executed** — no Docker binary in this sandbox. Top priority once Docker is available anywhere.
2. **No real per-user auth** — tenant auth is shared-secret + DB tenant-status check, not JWT/Entra-claim-based. This is a genuine Phase 0 spike item; needs a live Entra app registration + test tenant to build/validate for real.
3. **Retry worker retries only once** — by design (bounded), but there's no dead-letter visibility UI yet for entries that are still `retried_still_failed` after the one retry; an ops person would currently have to query `audit_log` directly.
4. **No CI/CD pipeline** — tests/builds are run manually each round, not gated on push.
5. **No rate limiting / request schema validation middleware** on the API (e.g. no `zod`/`joi` validation on route bodies) — flagged as a production-readiness gap, not attempted yet.
6. Everything Azure/Graph/ARM-facing remains **mock/unit-tested only** — no code in this system has ever made a real authenticated call to Microsoft Graph or Azure Resource Manager. The only live external call anywhere is the public, unauthenticated Azure Retail Prices API.

## Exact next steps for a future continuation round

1. **Phase 0 spike, if/when a real test Entra tenant + Azure subscription becomes available**: exercise the actual Graph admin-consent flow, the actual Deploy-to-Azure RBAC Bicep assignment, and one real ARM call (e.g. list host pools) end-to-end. This is the single highest-leverage next step — it validates or kills the product's core assumption per the original plan's Phase 0 framing. Nothing else in this codebase can substitute for it.
2. Get Docker available and run `docker compose build && docker compose up` for the first time; fix whatever real integration issues surface (workspace hoisting in Alpine, container networking/timing).
3. Add a small dead-letter/ops view (UI or just a documented SQL query) for `retried_still_failed` audit entries.
4. Add request-schema validation middleware (zod) to the API routes.
5. Basic CI (GitHub Actions or similar) running `npm run test` + `next build` on push, once this repo has a remote.

## Architecture reminders (unchanged, confirmed still respected)

- Multi-tenant Entra app registration + separate Graph admin-consent grant + separate Azure RBAC custom-role Deploy-to-Azure grant. **No Azure Lighthouse anywhere.**
- Multi-tenancy: single control-plane Postgres DB with Row-Level Security, not DB-per-tenant.
- Hard safety caps (max hosts per action, max cost delta) enforced server-side in `ScalingPolicyEvaluator`, not just documented — verified via unit tests, visible (non-editable-away) in the UI.
- No live Azure/Graph/ARM call has ever been fabricated as succeeding in this codebase's history. Only the public Azure Retail Prices API has been called live.
