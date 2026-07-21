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

    expect(result.outcome).toBe("succeeded");
    if (result.outcome === "succeeded") {
      expect(result.data.name).toBe("pool1");
      expect(result.data.hostPoolType).toBe("Pooled");
    }

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

  it("startVm calls Microsoft.Compute start action (POST) with correct URL and auth, then polls provisioningState fallback to success (no Azure-AsyncOperation header)", async () => {
    let callCount = 0;
    const mockFetch: FetchLike = jest.fn(async (_url: string, init?: any) => {
      callCount += 1;
      if (init?.method === "POST") {
        return { ok: true, status: 202, json: async () => ({}), headers: { get: () => null } };
      }
      // Poll call: provisioningState fallback (no Azure-AsyncOperation header returned)
      return {
        ok: true,
        status: 200,
        json: async () => ({ properties: { provisioningState: "Succeeded" } }),
      };
    }) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.startVm("sub", "rg", "host1", { pollIntervalMs: 1 });

    expect(result).toEqual({ outcome: "succeeded" });
    const [url, init] = (mockFetch as jest.Mock).mock.calls[0];
    expect(url).toContain("/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/host1/start");
    expect(url).toContain("api-version=");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer mock-token");
    expect(callCount).toBeGreaterThan(1);
  });

  it("startVm returns immediate success on 200 (VM already running) without polling", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      headers: { get: () => null },
    })) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.startVm("sub", "rg", "host1");
    expect(result).toEqual({ outcome: "succeeded" });
    expect((mockFetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it("startVm polls the Azure-AsyncOperation URL and reports failed outcome on operation failure", async () => {
    const mockFetch: FetchLike = jest.fn(async (url: string, init?: any) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          status: 202,
          json: async () => ({}),
          headers: { get: (name: string) => (name.toLowerCase() === "azure-asyncoperation" ? "https://management.azure.com/opstatus/op1" : null) },
        };
      }
      expect(url).toBe("https://management.azure.com/opstatus/op1");
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "Failed", error: { code: "OSProvisioningTimedOut" } }),
      };
    }) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.startVm("sub", "rg", "host1", { pollIntervalMs: 1 });
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.reason).toContain("OSProvisioningTimedOut");
    }
  });

  it("startVm times out and reports a timeout outcome if the operation never reaches a terminal state", async () => {
    const mockFetch: FetchLike = jest.fn(async (_url: string, init?: any) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          status: 202,
          json: async () => ({}),
          headers: { get: (name: string) => (name.toLowerCase() === "azure-asyncoperation" ? "https://management.azure.com/opstatus/op1" : null) },
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: "InProgress" }) };
    }) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.startVm("sub", "rg", "host1", { timeoutMs: 5, pollIntervalMs: 2 });
    expect(result.outcome).toBe("timeout");
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

describe("ArmHostPoolClient — createOrUpdateHostPool polling (Microsoft.DesktopVirtualization LRO)", () => {
  it("returns immediate success on 200 without polling", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "/subscriptions/sub/.../hostPools/pool1",
        name: "pool1",
        location: "eastus",
        properties: { hostPoolType: "Pooled", loadBalancerType: "BreadthFirst", maxSessionLimit: 10 },
      }),
      headers: { get: () => null },
    })) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.createOrUpdateHostPool("sub", "rg", "pool1", {
      location: "eastus",
      hostPoolType: "Pooled",
      loadBalancerType: "BreadthFirst",
      maxSessionLimit: 10,
    });
    expect(result.outcome).toBe("succeeded");
    if (result.outcome === "succeeded") expect(result.data.name).toBe("pool1");
    expect((mockFetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it("polls Azure-AsyncOperation on 202, then re-fetches the resource on success", async () => {
    let callCount = 0;
    const mockFetch: FetchLike = jest.fn(async (url: string, init?: any) => {
      callCount += 1;
      if (init?.method === "PUT") {
        return {
          ok: true,
          status: 202,
          json: async () => ({}),
          headers: { get: (n: string) => (n.toLowerCase() === "azure-asyncoperation" ? "https://management.azure.com/opstatus/hp1" : null) },
        };
      }
      if (url === "https://management.azure.com/opstatus/hp1") {
        return { ok: true, status: 200, json: async () => ({ status: "Succeeded" }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "/subscriptions/sub/.../hostPools/pool1",
          name: "pool1",
          location: "eastus",
          properties: { hostPoolType: "Pooled", loadBalancerType: "BreadthFirst", maxSessionLimit: 10 },
        }),
      };
    }) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.createOrUpdateHostPool(
      "sub",
      "rg",
      "pool1",
      { location: "eastus", hostPoolType: "Pooled", loadBalancerType: "BreadthFirst", maxSessionLimit: 10 },
      { pollIntervalMs: 1 }
    );
    expect(result.outcome).toBe("succeeded");
    if (result.outcome === "succeeded") expect(result.data.name).toBe("pool1");
    expect(callCount).toBeGreaterThan(2);
  });

  it("reports failed outcome when the async operation fails", async () => {
    const mockFetch: FetchLike = jest.fn(async (_url: string, init?: any) => {
      if (init?.method === "PUT") {
        return {
          ok: true,
          status: 202,
          json: async () => ({}),
          headers: { get: (n: string) => (n.toLowerCase() === "azure-asyncoperation" ? "https://management.azure.com/opstatus/hp2" : null) },
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: "Failed", error: { code: "QuotaExceeded" } }) };
    }) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.createOrUpdateHostPool(
      "sub",
      "rg",
      "pool2",
      { location: "eastus", hostPoolType: "Pooled", loadBalancerType: "BreadthFirst", maxSessionLimit: 10 },
      { pollIntervalMs: 1 }
    );
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.reason).toContain("QuotaExceeded");
  });

  it("times out if the operation never reaches a terminal state", async () => {
    const mockFetch: FetchLike = jest.fn(async (_url: string, init?: any) => {
      if (init?.method === "PUT") {
        return {
          ok: true,
          status: 202,
          json: async () => ({}),
          headers: { get: (n: string) => (n.toLowerCase() === "azure-asyncoperation" ? "https://management.azure.com/opstatus/hp3" : null) },
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: "InProgress" }) };
    }) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.createOrUpdateHostPool(
      "sub",
      "rg",
      "pool3",
      { location: "eastus", hostPoolType: "Pooled", loadBalancerType: "BreadthFirst", maxSessionLimit: 10 },
      { timeoutMs: 5, pollIntervalMs: 2 }
    );
    expect(result.outcome).toBe("timeout");
  });
});

describe("ArmHostPoolClient — deleteSessionHost polling", () => {
  it("returns immediate success on 200/204 without polling", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: true,
      status: 204,
      json: async () => ({}),
      headers: { get: () => null },
    })) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.deleteSessionHost("sub", "rg", "pool1", "host1");
    expect(result.outcome).toBe("succeeded");
    expect((mockFetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it("polls Azure-AsyncOperation on 202 and reports success", async () => {
    const mockFetch: FetchLike = jest.fn(async (_url: string, init?: any) => {
      if (init?.method === "DELETE") {
        return {
          ok: true,
          status: 202,
          json: async () => ({}),
          headers: { get: (n: string) => (n.toLowerCase() === "azure-asyncoperation" ? "https://management.azure.com/opstatus/del1" : null) },
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: "Succeeded" }) };
    }) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.deleteSessionHost("sub", "rg", "pool1", "host1", { pollIntervalMs: 1 });
    expect(result.outcome).toBe("succeeded");
  });

  it("reports failed outcome when the delete operation fails", async () => {
    const mockFetch: FetchLike = jest.fn(async (_url: string, init?: any) => {
      if (init?.method === "DELETE") {
        return {
          ok: true,
          status: 202,
          json: async () => ({}),
          headers: { get: (n: string) => (n.toLowerCase() === "azure-asyncoperation" ? "https://management.azure.com/opstatus/del2" : null) },
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: "Failed", error: { code: "ResourceBusy" } }) };
    }) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.deleteSessionHost("sub", "rg", "pool1", "host2", { pollIntervalMs: 1 });
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.reason).toContain("ResourceBusy");
  });

  it("times out if the delete operation never reaches a terminal state", async () => {
    const mockFetch: FetchLike = jest.fn(async (_url: string, init?: any) => {
      if (init?.method === "DELETE") {
        return {
          ok: true,
          status: 202,
          json: async () => ({}),
          headers: { get: (n: string) => (n.toLowerCase() === "azure-asyncoperation" ? "https://management.azure.com/opstatus/del3" : null) },
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: "InProgress" }) };
    }) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.deleteSessionHost("sub", "rg", "pool1", "host3", { timeoutMs: 5, pollIntervalMs: 2 });
    expect(result.outcome).toBe("timeout");
  });

  it("falls back to polling for a 404 (gone) when no Azure-AsyncOperation header is returned", async () => {
    let getCalls = 0;
    const mockFetch: FetchLike = jest.fn(async (_url: string, init?: any) => {
      if (init?.method === "DELETE") {
        return { ok: true, status: 202, json: async () => ({}), headers: { get: () => null } };
      }
      getCalls += 1;
      if (getCalls < 2) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as FetchLike;
    const client = new ArmHostPoolClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.deleteSessionHost("sub", "rg", "pool1", "host4", { pollIntervalMs: 1 });
    expect(result.outcome).toBe("succeeded");
  });
});