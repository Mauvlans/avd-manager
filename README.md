# AVD Manager

A multi-tenant SaaS control plane for managing Azure Virtual Desktop (AVD) at scale. Host pool / session host lifecycle, autoscaling & cost
optimization, user & app management, and cost/usage reporting, across many customer
Azure tenants from a single control plane.

## Stack

- **Backend**: Node.js 20 + TypeScript, Express API on Azure App Service / Functions.
- **Frontend**: Next.js (React) SPA.
- **DB**: PostgreSQL (control plane), row-level security (RLS) for tenant isolation.
- **Infra**: Bicep templates for customer-side RBAC delegation + session host provisioning.
- **Autoscaling**: timer-triggered Azure Function evaluating scaling policies with hard
  safety caps.

## Core architecture decisions (do not deviate without a new ADR)

1. **No Azure Lighthouse.** Cross-tenant delegation explicitly rejected by the product
   owner. Delegation is via a **single multi-tenant Entra ID app registration**, granted
   per customer tenant via two independent grants during onboarding:
   - **(a) Microsoft Graph admin consent** — an OAuth admin-consent URL the customer's
     Global Admin visits, creating a service principal for our app in their tenant with
     scopes like `User.Read.All`, `Group.Read.All`, `Directory.Read.All`. Used for
     Entra ID group sync / user management.
   - **(b) Azure RBAC custom role assignment** — a separate "Deploy to Azure" Bicep
     template the customer runs in their own subscription, creating a **least-privilege
     custom RBAC role** scoped to `Microsoft.DesktopVirtualization/*` and
     `Microsoft.Compute/virtualMachines/*` actions only, scoped to specific
     subscriptions/resource groups. **Never Owner or Contributor.** This role is
     assigned to our app's service principal.
   These two grants are tracked independently in `subscriptions_registry` — a tenant
   can have Graph consent without RBAC (or vice versa), and the app must degrade
   gracefully (e.g. no group sync without Graph consent; no host pool actions without
   RBAC).

2. **Single control-plane database, RLS-based multi-tenancy.** One Postgres instance,
   one schema, every tenant-scoped table carries `tenant_id` and has a Postgres
   Row-Level-Security policy enforcing `tenant_id = current_setting('app.current_tenant')`.
   No database-per-tenant. This keeps ops simple at our scale and avoids N-database
   migration fan-out.

3. **Subscription registry as the source of truth for delegation state.** Because there
   is no Lighthouse-style "delegated resource management" blade to eyeball, we
   maintain our own table (`subscriptions_registry`) tracking: registered subscription
   IDs per tenant, in-scope resource groups, which RBAC roles are actually currently
   assigned (verified, not just "we think we asked for it"), and Graph consent status.
   A periodic **permission health-check job** re-verifies RBAC role assignments against
   Azure and flags drift (role removed/modified out-of-band) — this is our
   Lighthouse-replacement visibility mechanism.

4. **Hard safety caps in the autoscale engine.** Every scaling policy evaluation is
   bounded by non-negotiable safety caps: `max_hosts_per_action` (max session hosts
   started/stopped/deleted in one evaluation cycle) and `max_cost_delta_per_action`
   (max estimated $/hr cost swing allowed in one action). These are enforced in code
   (`ScalingPolicyEvaluator`), not just configuration hints — a policy that would
   exceed them is clamped and logged, never silently exceeded. Rationale: mis-scaling a
   customer's production VMs is an existential risk for this product.

5. **Managed Identity + Key Vault.** Service-to-service Azure auth uses Managed
   Identity where the runtime supports it (Azure Functions/App Service); all
   secrets (DB connection strings, Entra app client secret, etc.) live in Key Vault,
   referenced via Key Vault references / SDK, never hardcoded or in plain app settings.

6. **Full audit trail.** Every mutating action (host pool create/update/delete, scaling
   action, RBAC/consent status change, policy change) writes an `audit_log` row with
   actor (user or system/job identity), tenant_id, timestamp, action, and before/after
   JSON state.

## Monorepo layout

```
apps/
  api/            Express + TypeScript API, Azure Functions (autoscale timer, health-check job)
  web/            Next.js frontend (onboarding wizard, host pool UI, scaling policy UI, cost dashboard)
infra/
  bicep/          Bicep templates: customer RBAC delegation, AVD session host provisioning
packages/
  shared/         Shared TypeScript types/interfaces used by api + web
db/
  migrations/     SQL migrations for the control-plane Postgres schema
docker-compose.yml  Local dev: Postgres + API + web
```

## What's validated vs. what needs a real Azure tenant

**Validated locally (unit-tested / runnable in this sandbox, no live Azure needed):**
- DB schema + RLS migrations (structure reviewed; RLS policy SQL included, tested via
  `pg-mem`/integration test where feasible).
- Scaling policy evaluator + safety cap enforcement (pure logic, fully unit tested with
  fixtures).
- Cost estimator against the **live public Azure Retail Prices API**
  (`https://prices.azure.com/api/retail/prices`) — this one is unauthenticated and was
  called for real during development.
- ARM/Graph HTTP client request shaping (URL, headers, body) — unit tested against
  mocked `fetch`/HTTP layer, not against real Azure.
- Frontend UI flows (onboarding wizard, host pool list, policy config, cost dashboard)
  render against the local API with fixture/mock data.

**NOT validated end-to-end — requires a real Entra tenant + Azure subscription
(Phase 0 spike before GA):**
- Actually visiting the Graph admin-consent URL and confirming a service principal
  appears in a customer tenant.
- Actually running the Deploy-to-Azure RBAC Bicep template in a real subscription and
  confirming the custom role + assignment appear and are least-privilege-correct.
- Real ARM API calls to `Microsoft.DesktopVirtualization` (host pools, session hosts)
  using a token acquired via the granted RBAC role — the HTTP client code is real and
  correctly shaped, but has only been run against mocks in this sandbox.
- Real Cost Management API calls (requires a subscription with actual spend).
- Managed Identity token acquisition (requires running inside Azure).

## Local dev

```bash
docker compose up --build
```

This starts Postgres (with migrations auto-applied), the API on :4000, and the web
app on :3000. See `PROGRESS.md` for current build status and next steps.
