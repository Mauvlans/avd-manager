import { ArmResourceGroupClient } from "../services/armResourceGroupClient";
import { TokenProvider, FetchLike } from "../services/armHostPoolClient";

class MockTokenProvider implements TokenProvider {
  async getArmToken(): Promise<string> {
    return "mock-token";
  }
}

describe("ArmResourceGroupClient", () => {
  it("lists resource groups with the real ARM shape (name, location) and correct auth/api-version", async () => {
    const mockFetch: FetchLike = jest.fn(async (url: string, init?: any) => ({
      ok: true,
      status: 200,
      json: async () => ({
        value: [
          { id: "/subscriptions/sub1/resourceGroups/rg-avd-prod", name: "rg-avd-prod", location: "eastus" },
          { id: "/subscriptions/sub1/resourceGroups/rg-avd-dev", name: "rg-avd-dev", location: "westus2" },
        ],
      }),
    })) as unknown as FetchLike;

    const client = new ArmResourceGroupClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const groups = await client.listResourceGroups("sub1");

    expect(groups).toEqual([
      { name: "rg-avd-prod", location: "eastus" },
      { name: "rg-avd-dev", location: "westus2" },
    ]);

    const [url, init] = (mockFetch as jest.Mock).mock.calls[0];
    expect(url).toContain("/subscriptions/sub1/resourcegroups");
    expect(url).toContain("api-version=");
    expect(init.headers.Authorization).toBe("Bearer mock-token");
  });

  it("throws with real ARM error detail on a failed request", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: "AuthorizationFailed" } }),
    })) as unknown as FetchLike;

    const client = new ArmResourceGroupClient("tenant-guid", new MockTokenProvider(), mockFetch);
    await expect(client.listResourceGroups("sub1")).rejects.toThrow(/403/);
  });
});
