import request from "supertest";
import express from "express";

jest.mock("../services/bicepCompiler", () => ({
  compileBicepToArmJson: jest.fn(async (source: string) => {
    if (source.includes("BROKEN")) {
      const { BicepCompileError } = jest.requireActual("../services/bicepCompiler");
      throw new BicepCompileError("bicep build exited with code 1", "some compiler error");
    }
    return {
      armJson: JSON.stringify({
        parameters: { foo: { type: "string", defaultValue: "bar" } },
      }),
    };
  }),
  BicepCompileError: jest.requireActual("../services/bicepCompiler").BicepCompileError,
}));
jest.mock("../services/customTemplateStore", () => ({
  storeCustomTemplate: jest.fn(async (tenantId: string, fileName: string, armJson: string) => ({
    id: "template-1",
    tenantId,
    fileName,
    armJson,
    uploadedAt: "2026-01-01T00:00:00Z",
  })),
  getCustomTemplate: jest.fn(async (id: string) =>
    id === "template-1"
      ? { id: "template-1", tenantId: "tenant-1", fileName: "x.bicep", armJson: '{"parameters":{}}', uploadedAt: "x" }
      : null
  ),
}));
jest.mock("../db/pool", () => ({
  withTenant: async (_tenantId: string, fn: (client: any) => Promise<any>) => fn({ query: jest.fn() }),
}));
jest.mock("../lib/auditLog", () => ({ writeAuditLog: jest.fn() }));
jest.mock("../middleware/tenantAuth", () => ({
  tenantAuth: (req: any, _res: any, next: any) => {
    req.tenantId = req.header("x-tenant-id") || "test-tenant";
    next();
  },
}));
jest.mock("../services/platformConfigStore", () => ({
  getPlatformConfig: () => ({ publicApiBaseUrl: "https://example.trycloudflare.com" }),
}));

import { customTemplatesRouter } from "../routes/customTemplates";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/custom-templates", customTemplatesRouter);
  return app;
}

describe("customTemplatesRouter", () => {
  it("POST /upload compiles a .bicep file and returns parameters + deploy link", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/custom-templates/upload")
      .set("x-tenant-id", "tenant-1")
      .attach("file", Buffer.from("param foo string = 'bar'\n"), "test.bicep");

    expect(res.status).toBe(200);
    expect(res.body.parameters).toEqual([
      { name: "foo", type: "string", defaultValue: "bar", required: false },
    ]);
    expect(res.body.rawUrl).toBe("https://example.trycloudflare.com/api/custom-templates/raw/template-1");
    expect(res.body.deployUrl).toContain("https://portal.azure.com/#create/Microsoft.Template/uri/");
    expect(res.body.deployUrl).toContain(encodeURIComponent(res.body.rawUrl));
  });

  it("POST /upload accepts a plain ARM .json file without compiling", async () => {
    const app = buildApp();
    const armJson = JSON.stringify({ parameters: { region: { type: "string" } } });
    const res = await request(app)
      .post("/api/custom-templates/upload")
      .set("x-tenant-id", "tenant-1")
      .attach("file", Buffer.from(armJson), "test.json");

    expect(res.status).toBe(200);
    expect(res.body.parameters).toEqual([{ name: "region", type: "string", required: true }]);
  });

  it("POST /upload returns 400 with compiler detail when bicep compilation fails", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/custom-templates/upload")
      .set("x-tenant-id", "tenant-1")
      .attach("file", Buffer.from("BROKEN bicep source"), "test.bicep");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("bicep compile failed");
    expect(res.body.detail).toContain("some compiler error");
  });

  it("POST /upload returns 400 for invalid (non-JSON) .json upload", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/custom-templates/upload")
      .set("x-tenant-id", "tenant-1")
      .attach("file", Buffer.from("{not valid json"), "test.json");

    expect(res.status).toBe(400);
  });

  it("POST /upload returns 400 with no file attached", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/custom-templates/upload").set("x-tenant-id", "tenant-1");
    expect(res.status).toBe(400);
  });

  it("GET /raw/:id is unauthenticated (no x-tenant-id needed) and returns the stored ARM JSON", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/custom-templates/raw/template-1");
    expect(res.status).toBe(200);
    expect(res.header["content-type"]).toContain("application/json");
    expect(JSON.parse(res.text)).toEqual({ parameters: {} });
  });

  it("GET /raw/:id returns 404 for an unknown id", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/custom-templates/raw/does-not-exist");
    expect(res.status).toBe(404);
  });
});
