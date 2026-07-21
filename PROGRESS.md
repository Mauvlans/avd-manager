# AVD Manager — Progress Report

Repo: `/mnt/ai-work/avd-manager`. This round continued from 3 prior commits and added 3 more.

## Git log (verified via `git log --oneline`)

```
5b2dc73 feat(infra): docker-compose.yml (postgres+api+web) with Dockerfiles and migration entrypoint script. NOTE: Docker is not available in this sandbox — build/run not verified here, see PROGRESS.md.
529bfbc feat(web): Next.js frontend — tenant onboarding wizard, host pool list/detail, scaling policy config with visible safety caps, cost dashboard, audit log. Builds cleanly with next build.
278967b feat(api): middleware-enforced tenant auth (shared secret + DB tenant validation), implement start_host via Microsoft.Compute VM start action, add 5 new tests (22 passing total)
8b3c0c2 feat: Bicep templates for RBAC delegation (custom role, no Lighthouse) and host pool/session host provisioning
8ead8c1 feat: control-plane DB schema+RLS, shared types, API scaffold (ARM/Graph clients, scaling evaluator, cost estimator, onboarding service, jobs) with passing unit tests + live Retail Prices API validation
6d381ab chore: initial repo scaffold, README with architecture decisions
```

## What's done (verified this round)

### 1. `apps/web` — Next.js frontend (new)
Built from scratch (package.json existed, no code). Pages-router app, no external
UI framework, calls the real Express API via `apps/web/lib/api.ts` — endpoint shapes
were read directly from `apps/api/src/routes/*.ts` before wiring, not guessed.

- `pages/onboarding.tsx` — 5-step wizard: create tenant → generate Graph
  admin-consent link → generate Deploy-to-Azure Bicep RBAC link → grant-status
  explainer → done. **Gap surfaced honestly in the UI itself**: there is no
  `GET /api/onboarding/tenants/:id/registry`-style status route yet, so the
  wizard cannot poll `subscriptions_registry` directly; it links to the Audit
  Log page instead (which does show `graph_consent_granted`/`rbac_granted`
  audit entries once the callback endpoints fire). Documented as a next step
  below.
- `pages/host-pools/index.tsx` + `pages/host-pools/[id].tsx` — list + detail
  view, create/delete host pools, list/create/enable/disable scaling
  policies. The safety-cap fields (`maxHostsPerAction`,
  `maxCostDeltaPerActionUsdPerHour`) are visually called out (`.cap-field`
  styling + explanatory copy that caps are enforced server-side and can't be
  disabled).
- `pages/cost.tsx` — cost dashboard calling `/api/cost/estimate` (the
  Retail-Prices-backed estimator).
- `pages/audit-log.tsx` — tenant audit trail viewer.
- Tenant "session" is a trivial `localStorage`-backed id (`lib/useTenantId.ts`)
  since there's no real signed-in user yet — documented as a stand-in.

**Verified:** `cd apps/web && npx next build` → `✓ Compiled successfully`,
all 8 routes statically generated with no type errors. Actual build output
reproduced above in this session; not fabricated.

### 2. `docker-compose.yml` + Dockerfiles (new)
- Root `docker-compose.yml`: `postgres:16-alpine`, `api` (built from
  `apps/api/Dockerfile`), `web` (built from `apps/web/Dockerfile`).
- `apps/api/docker-entrypoint.sh` waits for Postgres to accept connections,
  then runs `node db/migrate.js` (the existing idempotent migration runner)
  before exec'ing the API process — so `docker compose up` alone should bring
  up a fully migrated DB + API + web stack for local dev/demo.
- **Not verified by actually running `docker compose build`/`up` in this
  sandbox — Docker is not installed here** (`docker: command not found`,
  confirmed via `docker --version`/`which docker`, re-confirmed again this
  session). The Dockerfiles and compose file are written carefully against
  the actual repo structure (npm workspaces, `dist/` build outputs, ports)
  but are UNTESTED beyond static review and local `tsc`/`jest`/`next build`
  checks (which don't exercise the Dockerfiles themselves, only the code
  they package). One path concern raised in an earlier draft of this doc —
  whether `db/migrate.js`'s `path.join(__dirname, "..", "db", "migrations")`
  would break once bundled into `dist/` — turned out to be a non-issue on
  review: `docker-entrypoint.sh` invokes `node /repo/db/migrate.js` directly
  (the original source file at its real repo path, copied in via `COPY db
  db`), not a compiled copy under `dist/`, so `__dirname` correctly resolves
  to `/repo/db` and thus `/repo/db/migrations`. The remaining real unknowns
  for next round: whether `npm ci` + workspace-scoped `npm run build
  --workspace=...` behaves as expected inside the Alpine image (workspace
  hoisting/symlink resolution can differ from bare-metal npm), and whether
  the healthcheck-gated `depends_on` on `api` actually delays start_period
  long enough for Postgres to be ready before the entrypoint's own polling
  loop kicks in (should be redundant-safe either way, but unverified).

### 3. API gap-filling
- **Tenant auth middleware** (`apps/api/src/middleware/tenantAuth.ts`, new):
  replaces the old "trust whatever `x-tenant-id` header is sent" stub that
  was duplicated in three router files. Now centralized, and does two real
  things beyond the old stub: (a) if `API_AUTH_TOKEN` env var is set,
  requires a matching `x-api-key` header — a shared-secret gate; (b) always
  does a real DB lookup (`SELECT id, status FROM tenants WHERE id = $1`) and
  rejects unknown or suspended tenants with 401/403/503, rather than blindly
  trusting the header value. This is explicitly **not** real per-user auth
  (no JWT validation, no mapping of an Entra `oid` claim to a tenant) — that
  remains a documented next step, not fixed this round.
- **`start_host` ARM action** implemented: `ArmHostPoolClient.startVm()` in
  `apps/api/src/services/armHostPoolClient.ts` calls the
  `Microsoft.Compute/virtualMachines/{name}/start` action (a *different*
  resource provider than `Microsoft.DesktopVirtualization`, which is the
  correct real-world shape — AVD session hosts are VMs, and "starting a
  host" is a Compute action, not a DesktopVirtualization action). Wired into
  `apps/api/src/jobs/autoscaleTimer.ts`: `start_host` decisions now resolve
  the target VM name from the session host's `resourceId` (via new exported
  helper `resolveVmNameFromResourceId`) and call `startVm`, instead of being
  a silent no-op as before.
  - **Known limitation, not fixed this round**: `startVm` is fire-and-forget
    — it accepts ARM's 202 Accepted and does not poll the
    `Azure-AsyncOperation` header to confirm the VM actually reached a
    running state. A future round should add that polling (or at minimum a
    follow-up reconciliation check) before marking the scaling action
    complete in the audit log.
- **Reconciliation/saga gap — documented, not fixed** (as the task allowed):
  `POST /api/host-pools` still writes the DB row first, then calls ARM, and
  does NOT roll back the DB row if the ARM call fails (it returns 202 with a
  `warning` field instead — this behavior predates this round and is
  unchanged). Same asymmetry exists in the autoscale timer: `deallocate_host`
  and `start_host` actions can fail against ARM after the audit log already
  recorded `scaling_decision_evaluated`, with no automatic re-drive/retry.
  **Next step**: introduce an outbox table (e.g. `pending_arm_operations`)
  written in the same DB transaction as the intent, with a background worker
  that retries against ARM until confirmed, and marks DB state as
  `provisioning_failed` on exhaustion rather than silently diverging from
  reality.

### 4. Tests
Ran `npx jest` in `apps/api`. Result (reproduced this session, not
fabricated):

```
PASS src/__tests__/scalingPolicyEvaluator.test.ts
PASS src/__tests__/costEstimator.test.ts
PASS src/__tests__/armHostPoolClient.test.ts

Test Suites: 3 passed, 3 total
Tests:       22 passed, 22 total
```

All 17 previously-passing tests still pass, plus 5 new ones added this round
(all in `armHostPoolClient.test.ts`): `startVm` request shaping (POST,
Compute URL, auth header), `startVm` error path on non-2xx/non-202, and three
cases for the new `resolveVmNameFromResourceId` helper (happy path,
case-insensitivity, missing-segment error). `tenantAuth.ts` middleware itself
does **not** yet have dedicated unit tests — it was manually verified via
`tsc --noEmit` type-checking and code review only. **Next step**: add a
supertest-based integration test hitting a router with the middleware
mounted, using a mock `withSystem`/pg pool, to cover the 400/401/403/503
branches.

### 5. This file
`PROGRESS.md`, committed.

## What's partial

- **Onboarding grant-status polling**: the wizard cannot poll
  `subscriptions_registry` directly (no GET route exists for it yet); it
  redirects to the audit log as a workaround. Add
  `GET /api/onboarding/tenants/:tenantId/registry` next, returning the
  `subscriptions_registry` row(s) for that tenant, and wire the wizard's
  step 4 to poll it every few seconds instead of linking away.
- **docker-compose.yml**: written and internally consistent with the repo's
  actual structure, but **completely unverified by an actual Docker build**
  — Docker is not installed in this sandbox. Treat as "should probably work,
  needs a real run to confirm" not "confirmed working." See the specific
  `dist/db/migrate.js` relative-path concern flagged above — check that first.
- **Reconciliation/saga hardening**: documented as a known gap in both the
  host-pool creation path and the autoscale action-execution path; not
  fixed. An outbox-pattern approach is sketched above.
- **`startVm` async completion**: fire-and-forget, no polling of ARM's
  long-running-operation status.

## What's not started

- Any web pages beyond the four built (e.g. no settings/tenant-management
  page, no session-host-level UI — session hosts are only visible
  indirectly through the autoscale job, no dedicated list view was built for
  them since the task prioritized host pools + policies + cost + onboarding).
- Real per-user authentication (Graph-issued JWT validation, mapping to
  tenant admin identity) — `tenantAuth.ts` is an improvement over the old
  stub but is still an MVP simplification, not production auth.
- CI/CD, containerized test running, any deployment automation beyond the
  Bicep templates and docker-compose.
- Rate limiting, request validation middleware (e.g. zod/joi schemas) beyond
  the ad-hoc `if (!x) return 400` checks already in the routers.

## Exact next steps for a future continuation round

1. Get Docker in the loop and actually run `docker compose build && docker
   compose up`. Likely trouble spots to check first: npm workspace
   hoisting/symlinks inside the Alpine build layers, and Postgres
   healthcheck timing vs. the entrypoint's own connection-retry loop (the
   `path.join(__dirname, ...)` migrations-path concern from an earlier audit
   was checked this round and is NOT a bug — `docker-entrypoint.sh` runs the
   source `db/migrate.js` directly, not a `dist/` copy).
2. Add `GET /api/onboarding/tenants/:tenantId/registry` and wire the
   onboarding wizard's step 4 to poll it.
3. Add integration tests for `tenantAuth.ts` (supertest + mocked `withSystem`).
4. Implement the outbox/saga pattern for ARM-call reconciliation (host-pool
   creation and autoscale action execution).
5. Add ARM long-running-operation polling to `startVm` (and ideally
   `deleteSessionHost`/`createOrUpdateHostPool` too) rather than
   fire-and-forget.
6. Build a session-host-level UI (list session hosts within a host pool
   detail page, showing status/sessions/allowNewSession, matching the shape
   already returned by `ArmHostPoolClient.listSessionHosts`).
7. Replace the shared-secret `x-api-key` + header `x-tenant-id` combo with
   real signed-in-user auth once there's an actual identity provider
   decision (this was explicitly out of scope per the "no live Entra
   credentials" constraint, and needs a live Entra app registration to build
   and test against — a Phase 0 spike item, see below).

## Validation tiers — what's tested how

| Area | Validation level |
|---|---|
| `CostEstimator` / `RetailPricesClient` | **Live-tested** against the real, unauthenticated Azure Retail Prices API (validated in a prior round; re-confirmed as unchanged this round, still called via the same code path from `/api/cost/estimate`). |
| `ScalingPolicyEvaluator` safety-cap clamping | Unit-tested with mocked host lists (part of the pre-existing 17, still passing). |
| `ArmHostPoolClient` (list/get/create/delete host pools, session hosts, **and now `startVm`**) | Unit-tested against a mocked `FetchLike` — verifies request shape (URL, method, headers, body) and response mapping. **Never called against a real Azure subscription** — there are no live Azure credentials available in this environment, and none were fabricated. |
| `resolveVmNameFromResourceId` | Unit-tested (pure function, no I/O). |
| `tenantAuth` middleware | Type-checked (`tsc --noEmit`) and manually reviewed only — no automated test yet (see next steps). |
| Graph admin-consent URL generation (`buildAdminConsentUrl`, `OnboardingService.getAdminConsentUrl`) | Unit-level shape only — generates a URL string; **never exercised against a real Entra tenant's consent flow**. Needs a real multi-tenant app registration + a test Entra tenant to validate end-to-end (Phase 0 spike item, not done, no credentials available). |
| Deploy-to-Azure RBAC template link + `infra/bicep/rbac-delegation.bicep` | Bicep file written to spec (custom role, no Lighthouse) but **never deployed** — needs a real Azure subscription to run `az deployment group create` against and confirm the role/assignment actually materialize as intended. Not attempted (Phase 0 spike item). |
| `apps/web` frontend | Build-verified (`next build` succeeds, static generation of all 8 routes, no type errors) and manually reviewed for correct API call shapes against the actual router source. **Not run against a live browser session hitting a live API** in this round — no `next dev` + running Postgres + running API integration smoke test was performed. Next round should do this once Docker (or a local Postgres) is available. |
| `docker compose up` end-to-end | **Not run at all.** Docker unavailable in this sandbox. Written carefully, likely close, unverified. |

## Architecture reminders (unchanged, still respected this round)

- Multi-tenant Entra app registration + separate Graph admin-consent (grant a)
  + Azure RBAC custom-role Deploy-to-Azure grant (grant b). **No Azure
  Lighthouse anywhere** — confirmed no new code this round introduces it.
- Multi-tenancy is a single control-plane Postgres DB with Row-Level Security,
  not DB-per-tenant — confirmed unchanged (`db/migrations/001_init.sql`,
  `apps/api/src/db/pool.ts`'s `withTenant`/`withSystem` split).
- No live Azure/Entra/Graph/ARM calls were fabricated as "successful" this
  round. The only live external call anywhere in the system remains the
  public, unauthenticated Azure Retail Prices API.
