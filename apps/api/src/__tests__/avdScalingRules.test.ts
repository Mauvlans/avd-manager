import { NoScalingPlanRule, EmptyHostPoolRule } from "../services/rules/avdScalingRules";

/** Minimal mock PoolClient: routes SQL by matching a keyword in the query
 * string to canned result sets, in the order each rule under test is
 * known to issue queries — good enough for unit-testing rule LOGIC
 * without a real Postgres connection, matching this codebase's existing
 * mocked-ARM-HTTP test convention for external dependencies. */
function mockClient(responses: Record<string, any[]>) {
  return {
    query: jest.fn(async (sql: string) => {
      for (const [keyword, rows] of Object.entries(responses)) {
        if (sql.includes(keyword)) return { rows };
      }
      return { rows: [] };
    }),
  } as any;
}

describe("NoScalingPlanRule", () => {
  it("flags a Pooled host pool with no attached scaling plan", async () => {
    const client = mockClient({
      "microsoft.desktopvirtualization/hostpools": [
        {
          azure_resource_id: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/hostPools/pool1",
          resource_name: "pool1",
          resource_group: "rg",
          subscription_id: "x",
          properties: { hostPoolType: "Pooled" },
        },
      ],
      "microsoft.desktopvirtualization/scalingplans": [],
    });

    const rule = new NoScalingPlanRule();
    const candidates = await rule.evaluate("tenant1", client);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].azureResourceId).toContain("pool1");
    expect(candidates[0].category).toBe("scaling");
  });

  it("does not flag a host pool that HAS a scaling plan attached", async () => {
    const poolId = "/subscriptions/x/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/hostPools/pool1";
    const client = mockClient({
      "microsoft.desktopvirtualization/hostpools": [
        { azure_resource_id: poolId, resource_name: "pool1", resource_group: "rg", subscription_id: "x", properties: { hostPoolType: "Pooled" } },
      ],
      "microsoft.desktopvirtualization/scalingplans": [
        { properties: { hostPoolReferences: [{ hostPoolArmPath: poolId }] } },
      ],
    });

    const rule = new NoScalingPlanRule();
    const candidates = await rule.evaluate("tenant1", client);
    expect(candidates).toHaveLength(0);
  });

  it("does not flag a Personal host pool (rule is scoped to Pooled only, per the plan)", async () => {
    const client = mockClient({
      "microsoft.desktopvirtualization/hostpools": [
        { azure_resource_id: "/x/pool1", resource_name: "pool1", resource_group: "rg", subscription_id: "x", properties: { hostPoolType: "Personal" } },
      ],
      "microsoft.desktopvirtualization/scalingplans": [],
    });

    const rule = new NoScalingPlanRule();
    const candidates = await rule.evaluate("tenant1", client);
    expect(candidates).toHaveLength(0);
  });
});

describe("EmptyHostPoolRule", () => {
  it("flags a host pool with zero running session hosts, using real telemetry", async () => {
    const client = mockClient({
      "microsoft.desktopvirtualization/hostpools": [
        { azure_resource_id: "/x/pool1", resource_name: "pool1", resource_group: "rg", subscription_id: "x" },
      ],
      avd_session_hourly: [{ running_session_host_count: 0 }],
    });

    const rule = new EmptyHostPoolRule();
    const candidates = await rule.evaluate("tenant1", client);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidenceScore).toBe(90);
    expect(candidates[0].estimatedMonthlySavings).toBe(0);
  });

  it("does not flag a host pool with no telemetry collected yet (doesn't guess)", async () => {
    const client = mockClient({
      "microsoft.desktopvirtualization/hostpools": [
        { azure_resource_id: "/x/pool1", resource_name: "pool1", resource_group: "rg", subscription_id: "x" },
      ],
      avd_session_hourly: [],
    });

    const rule = new EmptyHostPoolRule();
    const candidates = await rule.evaluate("tenant1", client);
    expect(candidates).toHaveLength(0);
  });

  it("does not flag a host pool with running session hosts", async () => {
    const client = mockClient({
      "microsoft.desktopvirtualization/hostpools": [
        { azure_resource_id: "/x/pool1", resource_name: "pool1", resource_group: "rg", subscription_id: "x" },
      ],
      avd_session_hourly: [{ running_session_host_count: 3 }],
    });

    const rule = new EmptyHostPoolRule();
    const candidates = await rule.evaluate("tenant1", client);
    expect(candidates).toHaveLength(0);
  });
});
