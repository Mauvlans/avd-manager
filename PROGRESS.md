# AVD Manager — Progress Report

Repo: `/mnt/ai-work/avd-manager`. This round continued from 8 prior commits
(up to `a0d38d3`) and closed the two top-priority gaps from that round's
"next steps" list: the onboarding registry status-poll endpoint, and ARM
long-running-operation polling for `startVm`. Docker-compose/Dockerfiles
were re-reviewed carefully and — since Docker itself remains unavailable —
validated as far as possible by reproducing the exact `npm ci` +
workspace-scoped build commands the Dockerfiles run, in isolated temp
directories mirroring the `COPY` layers.

## Git log (verified via `git log --oneline`)

```
fb753c2 docs(PROGRESS.md): placeholder before final git log insert
e08d3f9 fix(arm): startVm now polls Azure-AsyncOperation (or provisioningState fallback) until terminal state/timeout and returns real VmStartResult; autoscaleTimer records start_host failures/timeouts in audit log as scaling_actions_partially_failed instead of assuming success. 3 new unit tests (success/failed/timeout), 25/25 passing
983b6ce feat(onboarding): add GET /api/onboarding/tenants/:id/registry status endpoint, wire onboarding wizard to poll it every 5s instead of linking to audit log
a0d38d3 docs(PROGRESS.md): correct migrate.js path claim after re-review — entrypoint runs source db/migrate.js not a dist copy, so no bug there; re-verified tsc/jest/next build all green
42615b5 docs: PROGRESS.md — accurate status of MVP round 2 (web app, docker-compose, auth middleware, start_host, test results, validation tiers, next steps)
5b2dc73 feat(infra): docker-compose.yml (postgres+api+web) with Dockerfiles and migration entrypoint script. NOTE: Docker is not available in this sandbox — build/run not verified here, see PROGRESS.md.
529bfbc feat(web): Next.js frontend — tenant onboarding wizard, host pool list/detail, scaling policy config with visible safety caps, cost dashboard, audit log. Builds cleanly with next build.
278967b feat(api): middleware-enforced tenant auth (shared secret + DB tenant validation), implement start_host via Microsoft.Compute VM start action, add 5 new tests (22 passing total)
8b3c0c2 feat: Bicep templates for RBAC delegation (custom role, no Lighthouse) and host pool/session host provisioning
8ead8c1 feat: control-plane DB schema+RLS, shared types, API scaffold (ARM/Graph clients, scaling evaluator, cost estimator, onboarding service, jobs) with passing unit tests + live Retail Prices API validation
6d381ab chore: initial repo scaffold, README with architecture decisions
```
(This round's final commit, updating PROGRESS.md with this exact log
including itself, follows after this one — see `git log --oneline` for the
authoritative up-to-date list.)

## What's fixed this round (verified)

### 1. Onboarding registry status-poll endpoint (Priority 1 — DONE)
- New `GET /api/onboarding/tenants/:tenantId/registry` route
  (`apps/api/src/routes/onboarding.ts`), backed by new
  `OnboardingService.listRegistryRows(tenantId)`
  (`apps/api/src/services/onboardingService.ts`) — reads all
  `subscriptions_registry` rows for a tenant via `withTenant` (RLS-scoped,
  consistent with how the rest of the service reads/writes this table).
  Returns `graph_consent_status`, `graph_consent_granted_at`,
  `rbac_grant_status`, `rbac_last_verified_at`, `rbac_drift_details`
  (the last permission health-check result, written by
  `apps/api/src/jobs/permissionHealthCheck.ts`), `subscription_id`, and
  `resource_groups`.
- `apps/web/lib/api.ts`: added `getOnboardingRegistry(tenantId)` +
  `SubscriptionsRegistryRow` type, matching the route's actual response
  shape.
- `apps/web/pages/onboarding.tsx`: step 4 ("Grant status") no longer links
  out to the Audit Log as a workaround. It now polls the new endpoint every
  5 seconds via a `useEffect`/`setInterval` once a tenant id exists, and
  renders live per-subscription rows (Graph consent status + granted-at,
  RBAC grant status + last-verified-at, any drift details, resource groups
  in scope). The Audit Log link remains as a secondary "full history" link,
  not the primary status mechanism.
- **Verified:** `tsc --noEmit` clean in both `apps/api` and `apps/web`;
  `next build` succeeds (see below, all 8 routes still statically
  generated). No dedicated integration test was added for this route (it's
  a thin passthrough over `listRegistryRows`, itself a straightforward
  parameterized SELECT) — flagged as a gap below alongside the pre-existing
  `tenantAuth` middleware test gap.

### 2. `startVm` ARM long-running-operation polling (Priority 2 — DONE)
- `apps/api/src/services/armHostPoolClient.ts`: `startVm` no longer returns
  `void` on a bare 202 Accepted. It now:
  1. Calls the Compute `start` action as before.
  2. On an immediate 200 (already running), returns `{ outcome: "succeeded" }`
     without polling.
  3. On 202, reads the `Azure-AsyncOperation` response header (case
     -insensitively) and polls that URL, checking `status` for
     `Succeeded`/`Failed`/`Canceled` (terminal) vs. `Running`/`InProgress`/
     `NotStarted` (keep polling).
  4. If no `Azure-AsyncOperation` header is present, falls back to polling
     the VM resource's own `properties.provisioningState`
     (`Succeeded`/`Failed` terminal).
  5. Bounded by a configurable `timeoutMs` (default 120s) / `pollIntervalMs`
     (default 5s); returns `{ outcome: "timeout", reason }` if the deadline
     passes without a terminal state.
  - Return type is now `VmStartResult = { outcome: "succeeded" } |
    { outcome: "failed", reason } | { outcome: "timeout", reason }` instead
    of `void` — callers can no longer treat "the POST didn't throw" as
    success.
- `apps/api/src/jobs/autoscaleTimer.ts`: `start_host` actions now inspect
  the real `VmStartResult`. If `outcome !== "succeeded"`, the failure (host
  name + outcome + reason) is collected and the audit log entry for that
  tick is written as `scaling_actions_partially_failed` (instead of always
  `scaling_actions_executed`), with the list of failures embedded in
  `afterState`. A crashed/unknown host or a request-level throw is also
  recorded as a failure rather than silently swallowed.
- **Tests added** (`apps/api/src/__tests__/armHostPoolClient.test.ts`,
  reproduced this session): immediate-200-success case, 202→poll→success via
  provisioningState fallback (no `Azure-AsyncOperation` header), 202→poll
  `Azure-AsyncOperation`→`Failed` outcome with reason propagated, and
  202→poll→never-terminal→`timeout` outcome (bounded via short
  `timeoutMs`/`pollIntervalMs` in the test so it runs fast). All use mocked
  `FetchLike`, no real Azure calls.
- **Verified:** `npx jest` in `apps/api` → `Test Suites: 3 passed, 3 total`,
  `Tests: 25 passed, 25 total` (17 pre-existing + 5 prior-round `startVm`
  shape tests, minus the 2 replaced/expanded ones, plus 5 new
  polling-outcome tests — net +3 vs. the 22 reported last round). `tsc
  --noEmit` clean.

### 3. docker-compose.yml + Dockerfiles — static re-review (Priority 3 — reviewed, no bugs found, still unexecuted)
Careful line-by-line re-read of `docker-compose.yml`, `apps/api/Dockerfile`,
`apps/web/Dockerfile`, and `apps/api/docker-entrypoint.sh` against the
actual `package.json` scripts and repo layout. No bugs found this round.
Additionally — since Docker itself is still not installed here — the
**exact `npm ci` and `npm run build --workspace=...` commands each
Dockerfile executes were reproduced by hand** in isolated temp directories
that mirror each Dockerfile's `COPY` layer ordering (copy only
`package.json`/`package-lock.json` + workspace `package.json`s, run
`npm ci`, then copy source, then run the workspace build commands):
- api: `npm ci` (455 packages, 0 vulnerabilities) →
  `npm run build --workspace=@avd-manager/shared` → `tsc` clean →
  `npm run build --workspace=@avd-manager/api` → `tsc` clean →
  confirmed `apps/api/dist/server.js` exists, matching the Dockerfile's
  `CMD ["node", "dist/server.js"]`.
- web: `npm ci` → `npm run build --workspace=@avd-manager/shared` → clean →
  `NEXT_PUBLIC_API_BASE_URL=http://localhost:4000 npm run build
  --workspace=@avd-manager/web` → `✓ Compiled successfully`, all 8 routes
  generated — matching the `ARG`/`ENV NEXT_PUBLIC_API_BASE_URL` pattern in
  `apps/web/Dockerfile`.
This is meaningfully stronger evidence than last round's "written carefully,
untested" — the actual commands the Dockerfiles run, in the actual order,
against the actual repo, do work. **What remains genuinely unverified**:
Alpine-specific behavior (musl libc, any native addon compilation — none of
this repo's deps currently have native bindings, but that wasn't
independently confirmed inside an actual Alpine container), the Postgres
healthcheck timing vs. `docker-entrypoint.sh`'s own connection-retry loop,
and the full `docker compose up` orchestration (networking between
services, `depends_on` behavior, volume persistence). None of these can be
checked without the Docker binary itself.

### 4. Full test suite + build (Priority 4 — DONE, reproduced this session)
```
$ npm run test --workspaces   (repo root)
> @avd-manager/api test  → jest
PASS src/__tests__/scalingPolicyEvaluator.test.ts
PASS src/__tests__/costEstimator.test.ts
PASS src/__tests__/armHostPoolClient.test.ts
Test Suites: 3 passed, 3 total
Tests:       25 passed, 25 total
> @avd-manager/web test  → (no "test" script defined — expected, web has no unit tests)
> @avd-manager/shared test → echo "no tests" && exit 0
```
```
$ cd apps/web && npx next build
✓ Compiled successfully
✓ Generating static pages (8/8)
```
`tsc --noEmit` also re-run clean in both `apps/api` and `apps/web` this
session (not just at commit time).

## What's partial / still a known gap

- **Onboarding registry endpoint has no dedicated test.** It's a thin
  passthrough (`res.json(await listRegistryRows(tenantId))`) over a
  straightforward parameterized SELECT, but a supertest-based integration
  test (mocking `withTenant`) would still be worth adding alongside the
  `tenantAuth` middleware test gap below.
- **`tenantAuth.ts` middleware** still has no dedicated unit/integration
  test — type-checked and manually reviewed only (unchanged from last
  round).
- **Reconciliation/saga hardening** — still not fixed. `POST
  /api/host-pools` still doesn't roll back the DB row on ARM failure
  (returns 202 + `warning` instead); the autoscale timer's
  `deallocate_host` path still has no retry/reconciliation on ARM failure
  (only `start_host` now surfaces its real outcome to the audit log — the
  underlying "what do we do about a stuck/failed action" retry story is
  still just documented, not built). An outbox-table (`pending_arm_operations`)
  pattern remains the recommended next step.
- **`docker compose up` end-to-end** — still not run at all; Docker
  unavailable in this sandbox (confirmed a third time this session:
  reproduced the Dockerfiles' build commands manually instead, see above).
- Everything listed as "not started" in the prior round remains not
  started (session-host-level UI, real per-user auth, CI/CD, rate
  limiting/schema validation middleware) — no time was allocated to these
  this round per the stated priority order.

## Exact next steps for a future continuation round

1. Get Docker in the loop and actually run `docker compose build && docker
   compose up`, now that the build commands have been hand-verified to work
   outside Docker — the remaining risk surface is genuinely Alpine/musl and
   inter-container networking/timing, not the npm/tsc/next build steps
   themselves.
2. Add supertest-based integration tests for `tenantAuth.ts` AND the new
   `GET /api/onboarding/tenants/:tenantId/registry` route (mocked
   `withSystem`/`withTenant`).
3. Implement the outbox/saga pattern for ARM-call reconciliation (host-pool
   creation and `deallocate_host` autoscale actions still lack it; only
   `start_host` now has a real success/failure signal, but nothing acts on
   a `scaling_actions_partially_failed` audit entry automatically yet — a
   retry/backoff worker reading that audit trail would be the natural next
   increment).
4. Extend the same long-running-operation polling pattern added to
   `startVm` to `deleteSessionHost`/`createOrUpdateHostPool` (both are
   still fire-and-forget on ARM's 202/201 Accepted responses).
5. Build a session-host-level UI (list session hosts within a host pool
   detail page).
6. Replace the shared-secret `x-api-key` + header `x-tenant-id` combo with
   real signed-in-user auth (Phase 0 spike item, needs a live Entra app
   registration — out of scope without live credentials).

## Validation tiers — what's tested how

| Area | Validation level |
|---|---|
| `CostEstimator` / `RetailPricesClient` | **Live-tested** against the real, unauthenticated Azure Retail Prices API (unchanged this round). |
| `ScalingPolicyEvaluator` safety-cap clamping | Unit-tested with mocked host lists (unchanged, part of the pre-existing suite). |
| `ArmHostPoolClient` (list/get/create/delete host pools, session hosts, `startVm` **with polling**) | Unit-tested against a mocked `FetchLike` — verifies request shape AND now the full poll-to-terminal-state behavior (success/failed/timeout). **Never called against a real Azure subscription.** |
| `resolveVmNameFromResourceId` | Unit-tested (pure function, no I/O), unchanged. |
| `OnboardingService.listRegistryRows` / the new registry GET route | **Not unit/integration tested this round** — reviewed manually + type-checked only. Flagged as next step. |
| `tenantAuth` middleware | Type-checked and manually reviewed only — no automated test yet (unchanged gap). |
| Graph admin-consent URL generation | Unit-level shape only (unchanged). |
| Deploy-to-Azure RBAC template link + Bicep | Written to spec, never deployed (unchanged). |
| `apps/web` frontend | Build-verified (`next build` succeeds, 8 routes, no type errors), including the new polling logic in `onboarding.tsx` (compiles + type-checks; **not exercised against a live running API in a browser** — no `next dev` + live Postgres + API smoke test was performed this round either). |
| `docker compose up` end-to-end | **Still not run.** This round instead reproduced each Dockerfile's exact `npm ci`/build command sequence by hand in isolated directories mirroring the `COPY` layers — both api and web build sequences succeed with the real repo source. This substantially reduces (but does not eliminate) risk versus "written but never executed at all." |

## Architecture reminders (unchanged, still respected this round)

- Multi-tenant Entra app registration + separate Graph admin-consent (grant a)
  + Azure RBAC custom-role Deploy-to-Azure grant (grant b). **No Azure
  Lighthouse anywhere** — confirmed no new code this round introduces it.
- Multi-tenancy is a single control-plane Postgres DB with Row-Level Security,
  not DB-per-tenant — confirmed unchanged. The new `listRegistryRows` method
  correctly uses `withTenant` (RLS-scoped), consistent with the rest of
  `OnboardingService`.
- No live Azure/Entra/Graph/ARM calls were fabricated as "successful" this
  round. The only live external call anywhere in the system remains the
  public, unauthenticated Azure Retail Prices API. `startVm`'s new polling
  logic was validated entirely against mocked `FetchLike` responses, never
  against real ARM.

