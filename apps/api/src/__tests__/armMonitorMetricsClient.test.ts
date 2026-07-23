import { ArmMonitorMetricsClient } from "../services/armMonitorMetricsClient";
import { FetchLike, TokenProvider } from "../services/armHostPoolClient";

class MockMetricsTokenProvider implements TokenProvider {
  async getArmToken(): Promise<string> {
    return "mock-token";
  }
}

describe("ArmMonitorMetricsClient", () => {
  it("fetches VM metrics with real Azure Monitor response shape and correct URL/auth", async () => {
    const mockFetch: FetchLike = jest.fn(async (url: string, init?: any) => {
      expect(url).toContain("/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1/providers/Microsoft.Insights/metrics");
      expect(url).toContain("metricnames=");
      expect(url).toContain("interval=PT1H");
      expect(init.headers.Authorization).toBe("Bearer mock-token");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          value: [
            {
              name: { value: "Percentage CPU", localizedValue: "Percentage CPU" },
              unit: "Percent",
              timeseries: [
                {
                  data: [
                    { timeStamp: "2026-07-22T00:00:00Z", average: 12.5, maximum: 45.0, minimum: 2.1 },
                    { timeStamp: "2026-07-22T01:00:00Z", average: 15.0, maximum: 50.0, minimum: 3.0 },
                  ],
                },
              ],
            },
          ],
        }),
      };
    }) as unknown as FetchLike;

    const client = new ArmMonitorMetricsClient("tenant-guid", new MockMetricsTokenProvider(), mockFetch);
    const series = await client.getVmMetrics(
      "/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1",
      "2026-07-22T00:00:00Z",
      "2026-07-23T00:00:00Z"
    );

    expect(series).toHaveLength(1);
    expect(series[0].metricName).toBe("Percentage CPU");
    expect(series[0].unit).toBe("Percent");
    expect(series[0].dataPoints).toHaveLength(2);
    expect(series[0].dataPoints[0].average).toBe(12.5);
    expect(series[0].dataPoints[1].maximum).toBe(50.0);
  });

  it("throws with real ARM error detail on a failed request", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: "ResourceNotFound" } }),
    })) as unknown as FetchLike;

    const client = new ArmMonitorMetricsClient("tenant-guid", new MockMetricsTokenProvider(), mockFetch);
    await expect(
      client.getVmMetrics("/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/gone", "2026-07-22T00:00:00Z", "2026-07-23T00:00:00Z")
    ).rejects.toThrow(/404/);
  });
});
