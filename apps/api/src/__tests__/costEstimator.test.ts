import { CostEstimator, RetailPricesClient } from "../services/costEstimator";
import type { FetchLike } from "../services/armHostPoolClient";

describe("CostEstimator (pure math)", () => {
  const estimator = new CostEstimator();

  it("estimates hourly cost as price * hosts", () => {
    expect(estimator.estimateHourlyCost(0.096, 5)).toBeCloseTo(0.48, 5);
  });

  it("estimates cost delta for scale-out/in", () => {
    expect(estimator.estimateCostDelta(0.1, 3, 1)).toBeCloseTo(0.2, 5);
    expect(estimator.estimateCostDelta(0.1, 0, 3)).toBeCloseTo(-0.3, 5);
  });

  it("estimates a rough monthly cost for always-on hosts", () => {
    // 0.1/hr * 2 hosts * 24h * 30d = 144
    expect(estimator.estimateMonthlyCost(0.1, 2)).toBeCloseTo(144, 2);
  });
});

describe("RetailPricesClient (mocked HTTP)", () => {
  it("parses a retail prices API response into a RetailPriceItem", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        Items: [
          {
            armSkuName: "Standard_D2s_v5",
            armRegionName: "eastus",
            retailPrice: 0.096,
            unitOfMeasure: "1 Hour",
            currencyCode: "USD",
            productName: "Windows Server",
            meterName: "D2s v5",
          },
        ],
      }),
    })) as unknown as FetchLike;

    const client = new RetailPricesClient(mockFetch);
    const price = await client.getVmHourlyPrice("Standard_D2s_v5", "eastus");
    expect(price).not.toBeNull();
    expect(price?.retailPrice).toBe(0.096);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = (mockFetch as jest.Mock).mock.calls[0];
    expect(url).toContain("prices.azure.com");
    expect(url).toContain("armSkuName");
  });

  it("returns null when no items match", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ Items: [] }),
    })) as unknown as FetchLike;
    const client = new RetailPricesClient(mockFetch);
    const price = await client.getVmHourlyPrice("Nonexistent_Sku", "nowhere");
    expect(price).toBeNull();
  });

  it("throws when the API returns a non-ok response", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as FetchLike;
    const client = new RetailPricesClient(mockFetch);
    await expect(client.getVmHourlyPrice("x", "y")).rejects.toThrow(/500/);
  });
});
