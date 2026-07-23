import { UnattachedDiskRule } from "../services/rules/storageRules";

function mockClient(rows: any[]) {
  return { query: jest.fn(async () => ({ rows })) } as any;
}

describe("UnattachedDiskRule", () => {
  it("flags a disk with diskState Unattached", async () => {
    const client = mockClient([
      {
        azure_resource_id: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Compute/disks/disk1",
        resource_name: "disk1",
        resource_group: "rg",
        subscription_id: "x",
        sku: { name: "Premium_LRS" },
        properties: { diskState: "Unattached", diskSizeGB: 128 },
        first_seen_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);

    const rule = new UnattachedDiskRule();
    const candidates = await rule.evaluate("tenant1", client);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].category).toBe("storage");
    expect(candidates[0].risk).toBe("medium");
    expect(candidates[0].evidence.diskSizeGB).toBe(128);
  });

  it("does not flag an attached disk", async () => {
    const client = mockClient([
      {
        azure_resource_id: "/x/disk1",
        resource_name: "disk1",
        resource_group: "rg",
        subscription_id: "x",
        sku: { name: "Premium_LRS" },
        properties: { diskState: "Attached", diskSizeGB: 128 },
        first_seen_at: new Date().toISOString(),
      },
    ]);

    const rule = new UnattachedDiskRule();
    const candidates = await rule.evaluate("tenant1", client);
    expect(candidates).toHaveLength(0);
  });
});
