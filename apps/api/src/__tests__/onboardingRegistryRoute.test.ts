import express from "express";
import request from "supertest";

// Mock the DB layer at the same boundary as tenantAuth.test.ts, consistent
// with this repo's convention of accessing Postgres only through
// withTenant/withSystem — no real Postgres connection needed for this route.
jest.mock("../db/pool", () => ({
  withSystem: jest.fn(),
  withTenant: jest.fn(),
}));

import { withTenant } from "../db/pool";
import { onboardingRouter } from "../routes/onboarding";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/onboarding", onboardingRouter);
  return app;
}

describe("GET /api/onboarding/tenants/:tenantId/registry (supertest)", () => {
  const mockWithTenant = withTenant as jest.Mock;

  beforeEach(() => {
    mockWithTenant.mockReset();
  });

  it("returns the tenant's subscriptions_registry rows as JSON", async () => {
    const fakeRows = [
      {
        id: "reg-1",
        tenant_id: "tenant-1",
        subscription_id: "sub-1",
        resource_groups: ["rg1"],
        rbac_role_definition_id: "role-1",
        rbac_grant_status: "granted",
        rbac_last_verified_at: "2024-01-01T00:00:00Z",
        rbac_drift_details: null,
        graph_consent_status: "granted",
        graph_consent_service_principal_id: "sp-1",
        graph_consent_granted_at: "2024-01-01T00:00:00Z",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      },
    ];
    mockWithTenant.mockImplementation(async (tenantId: string, fn: any) =>
      fn({ query: jest.fn().mockResolvedValue({ rows: fakeRows }) })
    );

    const app = buildApp();
    const res = await request(app).get("/api/onboarding/tenants/tenant-1/registry");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fakeRows);
    // Confirms the route scopes the read via withTenant (RLS), not withSystem.
    expect(mockWithTenant).toHaveBeenCalledWith("tenant-1", expect.any(Function));
  });

  it("returns an empty array when the tenant has no registry rows yet", async () => {
    mockWithTenant.mockImplementation(async (_tenantId: string, fn: any) =>
      fn({ query: jest.fn().mockResolvedValue({ rows: [] }) })
    );

    const app = buildApp();
    const res = await request(app).get("/api/onboarding/tenants/tenant-2/registry");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

});
