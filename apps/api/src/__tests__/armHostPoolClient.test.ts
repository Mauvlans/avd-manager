import { ArmHostPoolClient, FetchLike, TokenProvider, resolveVmNameFromResourceId } from "../services/armHostPoolClient";

class MockTokenProvider implements TokenProvider {
  async getArmToken(_entraTenantId: string): Promise<string> {
    return "mock-token";
  }
}

describe("ArmHostPoolClient (mocked ARM HTTP)", () => {
  it("shapes the createOrUpdateHostPool request correctly (PUT, body, api-version)", async () => {
    const mockFetch: FetchLike = jest.fn(async (url: string, init?: any) => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/hostPools/pool1",
        name: "pool1",
        location: "eastus",
        properties: { hostPoolType: "Pooled", loadBalancerType: "BreadthFirst", maxSessionLimit: 10 },
      }),
    })) as unknown as FetchLike;

    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.createOrUpdateHostPool("sub", "rg", "pool1", {
      location: "eastus",
      hostPoolType: "Pooled",
      loadBalancerType: "BreadthFirst",
      maxSessionLimit: 10,
    });

    expect(result.name).toBe("pool1");
    expect(result.hostPoolType).toBe("Pooled");

    const [url, init] = (mockFetch as jest.Mock).mock.calls[0];
    expect(url).toContain("/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/hostPools/pool1");
    expect(url).toContain("api-version=");
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer mock-token");
    const body = JSON.parse(init.body);
    expect(body.properties.hostPoolType).toBe("Pooled");
  });

  it("returns null from getHostPool on a 404", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "not found" }),
    })) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.getHostPool("sub", "rg", "missing-pool");
    expect(result).toBeNull();
  });

  it("throws a descriptive error on non-404 failures", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: "AuthorizationFailed" } }),
    })) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    await expect(client.listHostPools("sub", "rg")).rejects.toThrow(/403/);
  });

  it("maps listSessionHosts response shape correctly", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        value: [
          {
            name: "host1.contoso.com",
            properties: {
              resourceId: "/subscriptions/sub/.../virtualMachines/host1",
              status: "Available",
              sessions: 3,
              allowNewSession: true,
              virtualMachineSize: "Standard_D2s_v5",
              lastHeartBeat: "2024-01-01T00:00:00Z",
            },
          },
        ],
      }),
    })) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const hosts = await client.listSessionHosts("sub", "rg", "pool1");
    expect(hosts).toHaveLength(1);
    expect(hosts[0].name).toBe("host1.contoso.com");
    expect(hosts[0].sessions).toBe(3);
    expect(hosts[0].status).toBe("Available");
  });

  it("startVm calls Microsoft.Compute start action (POST) with correct URL and auth", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: true,
      status: 202,
      json: async () => ({}),
    })) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    await client.startVm("sub", "rg", "host1");

    const [url, init] = (mockFetch as jest.Mock).mock.calls[0];
    expect(url).toContain("/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/host1/start");
    expect(url).toContain("api-version=");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer mock-token");
  });

  it("startVm throws a descriptive error on failure (non-2xx, non-202)", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: "AuthorizationFailed" } }),
    })) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    await expect(client.startVm("sub", "rg", "host1")).rejects.toThrow(/403/);
  });
});

describe("resolveVmNameFromResourceId", () => {
  it("extracts the VM name from a well-formed ARM resourceId", () => {
    const id = "/subscriptions/sub-id/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/host1";
    expect(resolveVmNameFromResourceId(id)).toBe("host1");
  });

  it("is case-insensitive on the 'virtualMachines' segment", () => {
    const id = "/subscriptions/sub-id/resourcegroups/rg/providers/microsoft.compute/VirtualMachines/host2";
    expect(resolveVmNameFromResourceId(id)).toBe("host2");
  });

  it("throws when resourceId has no virtualMachines segment", () => {
    expect(() => resolveVmNameFromResourceId("/subscriptions/sub-id/resourceGroups/rg")).toThrow(
      /could not resolve VM name/
    );
  });
});
