import { ArmApplicationGroupClient } from "../services/armApplicationGroupClient";
import type { FetchLike, TokenProvider } from "../services/armHostPoolClient";

class MockTokenProvider implements TokenProvider {
  async getArmToken(_entraTenantId: string): Promise<string> {
    return "mock-token";
  }
}

function fakeAppGroupArmObj(overrides: any = {}) {
  return {
    id: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/applicationGroups/ag1",
    name: "ag1",
    location: "eastus",
    properties: {
      friendlyName: "AG One",
      hostPoolArmPath: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/hostPools/hp1",
      applicationGroupType: "Desktop",
      ...overrides,
    },
  };
}

describe("ArmApplicationGroupClient (mocked ARM HTTP)", () => {
  it("shapes the createOrUpdateApplicationGroup request correctly (PUT, body, api-version)", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => fakeAppGroupArmObj(),
    })) as unknown as FetchLike;

    const client = new ArmApplicationGroupClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.createOrUpdateApplicationGroup("sub", "rg", "ag1", {
      location: "eastus",
      hostPoolArmPath: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/hostPools/hp1",
      applicationGroupType: "Desktop",
    });

    expect(result.outcome).toBe("succeeded");
    if (result.outcome === "succeeded") {
      expect(result.data.name).toBe("ag1");
      expect(result.data.applicationGroupType).toBe("Desktop");
      expect(result.data.hostPoolArmPath).toContain("/hostPools/hp1");
    }

    const [url, init] = (mockFetch as jest.Mock).mock.calls[0];
    expect(url).toContain("/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/applicationGroups/ag1");
    expect(url).toContain("api-version=2023-09-05");
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer mock-token");
    const body = JSON.parse(init.body);
    expect(body.properties.applicationGroupType).toBe("Desktop");
    expect(body.properties.hostPoolArmPath).toContain("/hostPools/hp1");
  });

  it("returns null from getApplicationGroup on a 404", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "not found" }),
    })) as unknown as FetchLike;
    const client = new ArmApplicationGroupClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.getApplicationGroup("sub", "rg", "missing-ag");
    expect(result).toBeNull();
  });

  it("throws a descriptive error on non-404 failures", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: "AuthorizationFailed" } }),
    })) as unknown as FetchLike;
    const client = new ArmApplicationGroupClient("tenant-guid", new MockTokenProvider(), mockFetch);
    await expect(client.listApplicationGroups("sub", "rg")).rejects.toThrow(/403/);
  });

  it("maps listApplicationGroups response shape correctly, including RemoteApp type", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        value: [fakeAppGroupArmObj(), fakeAppGroupArmObj({ applicationGroupType: "RemoteApp" })],
      }),
    })) as unknown as FetchLike;
    const client = new ArmApplicationGroupClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const groups = await client.listApplicationGroups("sub", "rg");
    expect(groups).toHaveLength(2);
    expect(groups[0].applicationGroupType).toBe("Desktop");
    expect(groups[1].applicationGroupType).toBe("RemoteApp");
  });

  it("deleteApplicationGroup issues a DELETE to the app group URL", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as FetchLike;
    const client = new ArmApplicationGroupClient("tenant-guid", new MockTokenProvider(), mockFetch);
    await client.deleteApplicationGroup("sub", "rg", "ag1");
    const [url, init] = (mockFetch as jest.Mock).mock.calls[0];
    expect(url).toContain("/applicationGroups/ag1");
    expect(init.method).toBe("DELETE");
  });
});
