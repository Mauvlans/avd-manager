import request from "supertest";
import express from "express";
import { serviceVariablesRouter } from "../routes/serviceVariables";

// Mocks db/pool's withTenant to run the callback with a fake client we
// control, matching this codebase's established test pattern for
// tenant-scoped routes (see onboardingRegistryRoute.test.ts / tenantAuth.test.ts).
jest.mock("../db/pool", () => ({
  withTenant: async (_tenantId: string, fn: (client: any) => Promise<any>) => fn(mockClient),
}));
jest.mock("../lib/auditLog", () => ({ writeAuditLog: jest.fn() }));
jest.mock("../middleware/tenantAuth", () => ({
  tenantAuth: (req: any, _res: any, next: any) => {
    req.tenantId = req.header("x-tenant-id") || "test-tenant";
    next();
  },
}));

let mockRows: any[] = [];
const mockClient = {
  query: jest.fn(async (sql: string) => {
    if (sql.includes("SELECT variable_key, selected_values FROM service_variables WHERE tenant_id")) {
      return { rows: mockRows };
    }
    if (sql.includes("SELECT selected_values FROM service_variables WHERE tenant_id")) {
      return { rows: mockRows.length ? [{ selected_values: mockRows[0].selected_values }] : [] };
    }
    if (sql.includes("INSERT INTO service_variables")) {
      return { rows: [] };
    }
    return { rows: [] };
  }),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/service-variables", serviceVariablesRouter);
  return app;
}

describe("serviceVariablesRouter", () => {
  beforeEach(() => {
    mockRows = [];
    mockClient.query.mockClear();
  });

  it("GET / defaults to ALL catalog options selected when nothing configured yet", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/service-variables").set("x-tenant-id", "tenant-1");
    expect(res.status).toBe(200);
    const regions = res.body.find((v: any) => v.key === "regions");
    expect(regions).toBeDefined();
    expect(regions.selectedValues.length).toBe(regions.options.length);
    expect(regions.selectedValues).toContain("eastus");
  });

  it("GET / reflects a stored selection instead of the default-all", async () => {
    mockRows = [{ variable_key: "regions", selected_values: ["eastus", "westeurope"] }];
    const app = buildApp();
    const res = await request(app).get("/api/service-variables").set("x-tenant-id", "tenant-1");
    const regions = res.body.find((v: any) => v.key === "regions");
    expect(regions.selectedValues).toEqual(["eastus", "westeurope"]);
  });

  it("PUT /:key rejects an unknown variable key", async () => {
    const app = buildApp();
    const res = await request(app)
      .put("/api/service-variables/not-a-real-key")
      .set("x-tenant-id", "tenant-1")
      .send({ selectedValues: ["eastus"] });
    expect(res.status).toBe(404);
  });

  it("PUT /:key rejects a value not in the catalog", async () => {
    const app = buildApp();
    const res = await request(app)
      .put("/api/service-variables/regions")
      .set("x-tenant-id", "tenant-1")
      .send({ selectedValues: ["not-a-real-region"] });
    expect(res.status).toBe(400);
  });

  it("PUT /:key accepts a valid selection and echoes it back", async () => {
    const app = buildApp();
    const res = await request(app)
      .put("/api/service-variables/regions")
      .set("x-tenant-id", "tenant-1")
      .send({ selectedValues: ["eastus", "westus2"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: "regions", selectedValues: ["eastus", "westus2"] });
  });
});
