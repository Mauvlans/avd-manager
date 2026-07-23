import { buildFingerprint } from "../services/rules/ruleFramework";

describe("buildFingerprint", () => {
  it("is stable for the same (tenant, rule, resource) triple", () => {
    const a = buildFingerprint("tenant1", "AVD-SCALING-001", "/subscriptions/x/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/hostPools/pool1");
    const b = buildFingerprint("tenant1", "AVD-SCALING-001", "/subscriptions/x/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/hostPools/pool1");
    expect(a).toBe(b);
  });

  it("differs across different rules for the same resource (a resource can have multiple distinct findings)", () => {
    const a = buildFingerprint("tenant1", "AVD-SCALING-001", "/subscriptions/x/.../pool1");
    const b = buildFingerprint("tenant1", "AVD-HOSTPOOL-001", "/subscriptions/x/.../pool1");
    expect(a).not.toBe(b);
  });

  it("differs across tenants for the same rule/resource (no cross-tenant fingerprint collision)", () => {
    const a = buildFingerprint("tenant1", "AVD-SCALING-001", "/subscriptions/x/.../pool1");
    const b = buildFingerprint("tenant2", "AVD-SCALING-001", "/subscriptions/x/.../pool1");
    expect(a).not.toBe(b);
  });

  it("handles a null resource id without throwing", () => {
    expect(() => buildFingerprint("tenant1", "SOME-RULE", null)).not.toThrow();
  });
});
