import { ArmScalingPlanClient } from "../services/armScalingPlanClient";
import type { FetchLike, TokenProvider } from "../services/armHostPoolClient";

class MockTokenProvider implements TokenProvider {
  async getArmToken(_entraTenantId: string): Promise<string> {
    return "mock-token";
  }
}

function fakePlanArmObj(overrides: any = {}) {
  return {
    id: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/scalingPlans/plan1",
    name: "plan1",
    location: "eastus",
    properties: {
      friendlyName: "Plan One",
      timeZone: "UTC",
      hostPoolType: "Pooled",
      schedules: [],
      hostPoolReferences: [],
      ...overrides,
    },
  };
}

describe("ArmScalingPlanClient (mocked ARM HTTP)", () => {
  it("shapes the createOrUpdateScalingPlan request correctly (PUT, body, api-version)", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => fakePlanArmObj(),
    })) as unknown as FetchLike;

    const client = new ArmScalingPlanClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.createOrUpdateScalingPlan("sub", "rg", "plan1", {
      location: "eastus",
      timeZone: "UTC",
      hostPoolType: "Pooled",
      schedules: [],
      hostPoolReferences: [],
    });

    expect(result.outcome).toBe("succeeded");
    if (result.outcome === "succeeded") {
      expect(result.data.name).toBe("plan1");
      expect(result.data.hostPoolType).toBe("Pooled");
    }

    const [url, init] = (mockFetch as jest.Mock).mock.calls[0];
    expect(url).toContain("/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/scalingPlans/plan1");
    expect(url).toContain("api-version=2023-09-05");
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer mock-token");
    const body = JSON.parse(init.body);
    expect(body.properties.hostPoolType).toBe("Pooled");
  });

  it("returns null from getScalingPlan on a 404", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "not found" }),
    })) as unknown as FetchLike;
    const client = new ArmScalingPlanClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.getScalingPlan("sub", "rg", "missing-plan");
    expect(result).toBeNull();
  });

  it("throws a descriptive error on non-404 failures", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: "AuthorizationFailed" } }),
    })) as unknown as FetchLike;
    const client = new ArmScalingPlanClient("tenant-guid", new MockTokenProvider(), mockFetch);
    await expect(client.listScalingPlans("sub", "rg")).rejects.toThrow(/403/);
  });

  it("maps listScalingPlans response shape correctly", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ value: [fakePlanArmObj()] }),
    })) as unknown as FetchLike;
    const client = new ArmScalingPlanClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const plans = await client.listScalingPlans("sub", "rg");
    expect(plans).toHaveLength(1);
    expect(plans[0].name).toBe("plan1");
    expect(plans[0].timeZone).toBe("UTC");
  });

  it("attachScalingPlanToHostPool reads the plan, adds the host pool reference, and PUTs the whole plan back", async () => {
    const hostPoolArmPath =
      "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/hostPools/pool1";
    let putBody: any = null;
    const mockFetch: FetchLike = jest.fn(async (_url: string, init?: any) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => fakePlanArmObj({ hostPoolReferences: putBody.properties.hostPoolReferences }),
        };
      }
      // GET: existing plan with no host pool references yet.
      return { ok: true, status: 200, json: async () => fakePlanArmObj() };
    }) as unknown as FetchLike;

    const client = new ArmScalingPlanClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.attachScalingPlanToHostPool("sub", "rg", "plan1", hostPoolArmPath, true);

    expect(result.outcome).toBe("succeeded");
    expect(putBody.properties.hostPoolReferences).toEqual([
      { hostPoolArmPath, scalingPlanEnabled: true },
    ]);
  });

  it("detachScalingPlanFromHostPool removes the matching host pool reference and PUTs the plan back", async () => {
    const hostPoolArmPath =
      "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/hostPools/pool1";
    let putBody: any = null;
    const mockFetch: FetchLike = jest.fn(async (_url: string, init?: any) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => fakePlanArmObj({ hostPoolReferences: putBody.properties.hostPoolReferences }),
        };
      }
      // GET: plan currently has the host pool attached.
      return {
        ok: true,
        status: 200,
        json: async () => fakePlanArmObj({ hostPoolReferences: [{ hostPoolArmPath, scalingPlanEnabled: true }] }),
      };
    }) as unknown as FetchLike;

    const client = new ArmScalingPlanClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.detachScalingPlanFromHostPool("sub", "rg", "plan1", hostPoolArmPath);

    expect(result.outcome).toBe("succeeded");
    expect(putBody.properties.hostPoolReferences).toEqual([]);
  });

  it("createOrUpdateScalingPlan polls the Azure-AsyncOperation URL on 202 Accepted before returning succeeded", async () => {
    let pollCount = 0;
    const mockFetch: FetchLike = jest.fn(async (url: string, init?: any) => {
      if (init?.method === "PUT") {
        return {
          ok: true,
          status: 202,
          json: async () => ({}),
          headers: { get: (name: string) => (name === "Azure-AsyncOperation" ? "https://management.azure.com/poll-url" : null) },
        };
      }
      if (url === "https://management.azure.com/poll-url") {
        pollCount += 1;
        return { ok: true, status: 200, json: async () => ({ status: "Succeeded" }) };
      }
      // Final re-fetch of the resource.
      return { ok: true, status: 200, json: async () => fakePlanArmObj() };
    }) as unknown as FetchLike;

    const client = new ArmScalingPlanClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const result = await client.createOrUpdateScalingPlan(
      "sub",
      "rg",
      "plan1",
      { location: "eastus", timeZone: "UTC", hostPoolType: "Pooled", schedules: [], hostPoolReferences: [] },
      { pollIntervalMs: 1 }
    );

    expect(result.outcome).toBe("succeeded");
    expect(pollCount).toBeGreaterThanOrEqual(1);
  });
});
