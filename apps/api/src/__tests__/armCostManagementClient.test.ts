import { ArmCostManagementClient } from "../services/armCostManagementClient";
import { FetchLike, TokenProvider } from "../services/armHostPoolClient";

class MockCostTokenProvider implements TokenProvider {
  async getArmToken(): Promise<string> {
    return "mock-token";
  }
}

describe("ArmCostManagementClient", () => {
  it("queries cost with real Cost Management column/row shape and converts YYYYMMDD UsageDate to YYYY-MM-DD", async () => {
    const mockFetch: FetchLike = jest.fn(async (url: string, init?: any) => {
      const body = JSON.parse(init.body);
      expect(body.type).toBe("ActualCost");
      expect(body.timePeriod).toEqual({ from: "2026-07-01", to: "2026-07-22" });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          properties: {
            columns: [
              { name: "UsageDate" },
              { name: "Cost" },
              { name: "ResourceId" },
              { name: "MeterCategory" },
              { name: "MeterSubcategory" },
              { name: "ServiceFamily" },
              { name: "ChargeType" },
              { name: "Currency" },
            ],
            rows: [
              [20260710, 12.5, "/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1", "Virtual Machines", "D Series", "Compute", "Usage", "USD"],
            ],
          },
        }),
      };
    }) as unknown as FetchLike;

    const client = new ArmCostManagementClient("tenant-guid", new MockCostTokenProvider(), mockFetch);
    const rows = await client.queryCost("sub1", "2026-07-01", "2026-07-22", "ActualCost");

    expect(rows).toHaveLength(1);
    expect(rows[0].usageDate).toBe("2026-07-10");
    expect(rows[0].cost).toBe(12.5);
    expect(rows[0].resourceId).toContain("virtualMachines/vm1");
    expect(rows[0].serviceFamily).toBe("Compute");
    expect(rows[0].currency).toBe("USD");
  });

  it("requests AmortizedCost when specified", async () => {
    const mockFetch: FetchLike = jest.fn(async (url: string, init?: any) => {
      const body = JSON.parse(init.body);
      expect(body.type).toBe("AmortizedCost");
      return { ok: true, status: 200, json: async () => ({ properties: { columns: [], rows: [] } }) };
    }) as unknown as FetchLike;

    const client = new ArmCostManagementClient("tenant-guid", new MockCostTokenProvider(), mockFetch);
    await client.queryCost("sub1", "2026-07-01", "2026-07-22", "AmortizedCost");
    expect(mockFetch).toHaveBeenCalled();
  });

  it("throws with real ARM error detail on a failed request", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: "AuthorizationFailed" } }),
    })) as unknown as FetchLike;

    const client = new ArmCostManagementClient("tenant-guid", new MockCostTokenProvider(), mockFetch);
    await expect(client.queryCost("sub1", "2026-07-01", "2026-07-22")).rejects.toThrow(/403/);
  });
});
