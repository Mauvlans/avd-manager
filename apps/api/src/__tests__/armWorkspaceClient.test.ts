import { ArmWorkspaceClient } from "../services/armWorkspaceClient";
import type { FetchLike, TokenProvider } from "../services/armHostPoolClient";

class MockTokenProvider implements TokenProvider {
  async getArmToken(_entraTenantId: string): Promise<string> {
    return "mock-token";
  }
}

function fakeWorkspaceArmObj(overrides: any = {}) {
  return {
    id: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/workspaces/ws1",
    name: "ws1",
    location: "eastus",
    properties: {
      friendlyName: "Workspace One",
      applicationGroupReferences: [],
      ...overrides,
    },
  };
}

describe("ArmWorkspaceClient (mocked ARM HTTP)", () => {
  it("shapes the createOrUpdateWorkspace request correctly (PUT, body, api-version)", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => fakeWorkspaceArmObj(),
    })) as unknown as FetchLike;

    const client = new ArmWorkspaceClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.createOrUpdateWorkspace("sub", "rg", "ws1", {
      location: "eastus",
      applicationGroupReferences: [],
    });

    expect(result.outcome).toBe("succeeded");
    if (result.outcome === "succeeded") {
      expect(result.data.name).toBe("ws1");
    }

    const [url, init] = (mockFetch as jest.Mock).mock.calls[0];
    expect(url).toContain("/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/workspaces/ws1");
    expect(url).toContain("api-version=2023-09-05");
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer mock-token");
  });

  it("returns null from getWorkspace on a 404", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "not found" }),
    })) as unknown as FetchLike;
    const client = new ArmWorkspaceClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.getWorkspace("sub", "rg", "missing-ws");
    expect(result).toBeNull();
  });

  it("attachApplicationGroup does a read-modify-write, appending the app group path", async () => {
    const calls: string[] = [];
    const mockFetch: FetchLike = jest.fn(async (url: string, init?: any) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if ((init?.method ?? "GET") === "GET") {
        return { ok: true, status: 200, json: async () => fakeWorkspaceArmObj() };
      }
      // PUT: echo back with the new reference included
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => fakeWorkspaceArmObj(body.properties) };
    }) as unknown as FetchLike;

    const client = new ArmWorkspaceClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.attachApplicationGroup(
      "sub",
      "rg",
      "ws1",
      "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/applicationGroups/ag1"
    );

    expect(result.outcome).toBe("succeeded");
    if (result.outcome === "succeeded") {
      expect(result.data.applicationGroupReferences).toContain(
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/applicationGroups/ag1"
      );
    }
    expect(calls[0]).toMatch(/^GET /);
    expect(calls[1]).toMatch(/^PUT /);
  });

  it("detachApplicationGroup removes the app group path via read-modify-write", async () => {
    const existingRef = "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/applicationGroups/ag1";
    const mockFetch: FetchLike = jest.fn(async (url: string, init?: any) => {
      if ((init?.method ?? "GET") === "GET") {
        return { ok: true, status: 200, json: async () => fakeWorkspaceArmObj({ applicationGroupReferences: [existingRef] }) };
      }
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => fakeWorkspaceArmObj(body.properties) };
    }) as unknown as FetchLike;

    const client = new ArmWorkspaceClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.detachApplicationGroup("sub", "rg", "ws1", existingRef);

    expect(result.outcome).toBe("succeeded");
    if (result.outcome === "succeeded") {
      expect(result.data.applicationGroupReferences).not.toContain(existingRef);
    }
  });

  it("throws a descriptive error on non-404 failures", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: "AuthorizationFailed" } }),
    })) as unknown as FetchLike;
    const client = new ArmWorkspaceClient("tenant-guid", new MockTokenProvider(), mockFetch);
    await expect(client.listWorkspaces("sub", "rg")).rejects.toThrow(/403/);
  });
});
