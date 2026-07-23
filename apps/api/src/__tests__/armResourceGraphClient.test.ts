import { ArmResourceGraphClient } from "../services/armResourceGraphClient";
import { FetchLike, TokenProvider } from "../services/armHostPoolClient";

class MockTokenProvider implements TokenProvider {
  async getArmToken(): Promise<string> {
    return "mock-token";
  }
}

describe("ArmResourceGraphClient", () => {
  it("queries resources across the given subscriptions with the real Resource Graph shape and paginates via $skipToken", async () => {
    let call = 0;
    const mockFetch: FetchLike = jest.fn(async (url: string, init?: any) => {
      call++;
      const body = JSON.parse(init.body);
      expect(body.subscriptions).toEqual(["sub1", "sub2"]);
      if (call === 1) {
        expect(body.options).toBeUndefined();
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: "/subscriptions/sub1/.../hostpools/pool1", name: "pool1", type: "microsoft.desktopvirtualization/hostpools", resourceGroup: "rg1", location: "eastus", subscriptionId: "sub1", sku: null, tags: { env: "prod" }, properties: {} },
            ],
            $skipToken: "page2token",
          }),
        };
      }
      expect(body.options.$skipToken).toBe("page2token");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "/subscriptions/sub2/.../virtualmachines/vm1", name: "vm1", type: "microsoft.compute/virtualmachines", resourceGroup: "rg2", location: "westus2", subscriptionId: "sub2", sku: { name: "Standard_D2s_v5" }, tags: {}, properties: {} },
          ],
        }),
      };
    }) as unknown as FetchLike;

    const client = new ArmResourceGraphClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const rows = await client.queryResources(["sub1", "sub2"]);

    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("pool1");
    expect(rows[0].tags).toEqual({ env: "prod" });
    expect(rows[1].name).toBe("vm1");
    expect(rows[1].sku).toEqual({ name: "Standard_D2s_v5" });
    expect(call).toBe(2);
  });

  it("stops paginating once maxPages is reached even if $skipToken is still present", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "/x", name: "x", type: "t", resourceGroup: "rg", location: "eastus", subscriptionId: "sub1", sku: null, tags: {}, properties: {} }], $skipToken: "always-more" }),
    })) as unknown as FetchLike;

    const client = new ArmResourceGraphClient("tenant-guid", new MockTokenProvider(), mockFetch);
    const rows = await client.queryResources(["sub1"], { maxPages: 3 });

    expect(rows).toHaveLength(3);
    expect((mockFetch as jest.Mock).mock.calls).toHaveLength(3);
  });

  it("throws with real ARM error detail on a failed request", async () => {
    const mockFetch: FetchLike = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: "AuthorizationFailed" } }),
    })) as unknown as FetchLike;

    const client = new ArmResourceGraphClient("tenant-guid", new MockTokenProvider(), mockFetch);
    await expect(client.queryResources(["sub1"])).rejects.toThrow(/403/);
  });
});
