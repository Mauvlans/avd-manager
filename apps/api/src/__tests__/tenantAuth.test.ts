import express from "express";
import request from "supertest";

// Mock the DB layer the same way the middleware imports it — no real
// Postgres connection needed. Mocked at the module boundary consistent with
// how this repo structures its DB access (withSystem/withTenant wrappers in
// ../db/pool), rather than reaching for a DB-mocking library.
jest.mock("../db/pool", () => ({
  withSystem: jest.fn(),
  withTenant: jest.fn(),
}));

import { withSystem } from "../db/pool";
import { tenantAuth } from "../middleware/tenantAuth";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get("/protected", tenantAuth, (req, res) => {
    res.json({ tenantId: (req as any).tenantId });
  });
  return app;
}

describe("tenantAuth middleware (supertest)", () => {
  const mockWithSystem = withSystem as jest.Mock;

  beforeEach(() => {
    mockWithSystem.mockReset();
    delete process.env.API_AUTH_TOKEN;
  });

  it("allows a valid, active tenant through and attaches tenantId to the request", async () => {
    mockWithSystem.mockImplementation(async (fn: any) =>
      fn({ query: jest.fn().mockResolvedValue({ rows: [{ id: "tenant-1", status: "active" }] }) })
    );
    const app = buildApp();
    const res = await request(app).get("/protected").set("x-tenant-id", "tenant-1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tenantId: "tenant-1" });
  });

  it("returns 403 for an unknown tenant id", async () => {
    mockWithSystem.mockImplementation(async (fn: any) =>
      fn({ query: jest.fn().mockResolvedValue({ rows: [] }) })
    );
    const app = buildApp();
    const res = await request(app).get("/protected").set("x-tenant-id", "does-not-exist");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/unknown tenant/);
  });

  it("returns 403 for a suspended tenant", async () => {
    mockWithSystem.mockImplementation(async (fn: any) =>
      fn({ query: jest.fn().mockResolvedValue({ rows: [{ id: "tenant-2", status: "suspended" }] }) })
    );
    const app = buildApp();
    const res = await request(app).get("/protected").set("x-tenant-id", "tenant-2");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/suspended/);
  });

  it("returns 400 when x-tenant-id header is missing", async () => {
    const app = buildApp();
    const res = await request(app).get("/protected");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-tenant-id/);
  });

  it("returns 503 when the DB lookup throws (fail closed, not open)", async () => {
    mockWithSystem.mockRejectedValue(new Error("connection refused"));
    const app = buildApp();
    const res = await request(app).get("/protected").set("x-tenant-id", "tenant-1");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/auth check failed/);
  });

  describe("when API_AUTH_TOKEN is set", () => {
    beforeEach(() => {
      process.env.API_AUTH_TOKEN = "s3cret";
      mockWithSystem.mockImplementation(async (fn: any) =>
        fn({ query: jest.fn().mockResolvedValue({ rows: [{ id: "tenant-1", status: "active" }] }) })
      );
    });

    it("returns 401 when x-api-key is missing", async () => {
      const app = buildApp();
      const res = await request(app).get("/protected").set("x-tenant-id", "tenant-1");
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/x-api-key/);
    });

    it("returns 401 when x-api-key is wrong", async () => {
      const app = buildApp();
      const res = await request(app)
        .get("/protected")
        .set("x-tenant-id", "tenant-1")
        .set("x-api-key", "wrong-value");
      expect(res.status).toBe(401);
    });

    it("allows the request through when x-api-key matches API_AUTH_TOKEN", async () => {
      const app = buildApp();
      const res = await request(app)
        .get("/protected")
        .set("x-tenant-id", "tenant-1")
        .set("x-api-key", "s3cret");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tenantId: "tenant-1" });
    });
  });
});
