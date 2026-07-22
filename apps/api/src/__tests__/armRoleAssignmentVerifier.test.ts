import { ArmRoleAssignmentVerifier } from "../services/armRoleAssignmentVerifier";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as any;
}

describe("ArmRoleAssignmentVerifier (mocked ARM/AAD HTTP)", () => {
  const roleDefId =
    "/subscriptions/e6ab1306-dfc4-4975-9f15-1df30c4699e2/providers/Microsoft.Authorization/roleDefinitions/74b6e851-c680-5c3b-9875-73881879293d";

  it("returns true when a matching role assignment is found", async () => {
    const mockFetch = jest.fn(async (url: string) => {
      if (url.includes("/oauth2/v2.0/token")) return jsonResponse({ access_token: "tok" });
      if (url.includes("/roleAssignments?")) {
        return jsonResponse({
          value: [
            { properties: { roleDefinitionId: roleDefId, principalId: "sp-1" } },
            { properties: { roleDefinitionId: "/some/other/role", principalId: "sp-2" } },
          ],
        });
      }
      throw new Error(`unexpected call: ${url}`);
    }) as unknown as typeof fetch;

    const verifier = new ArmRoleAssignmentVerifier("client-id", "secret", mockFetch);
    const result = await verifier.verify({
      entraTenantId: "tenant-guid",
      subscriptionId: "e6ab1306-dfc4-4975-9f15-1df30c4699e2",
      resourceGroups: [],
      roleDefinitionId: roleDefId,
    });

    expect(result).toBe(true);
  });

  it("returns false (drift) when no matching role assignment is found", async () => {
    const mockFetch = jest.fn(async (url: string) => {
      if (url.includes("/oauth2/v2.0/token")) return jsonResponse({ access_token: "tok" });
      if (url.includes("/roleAssignments?")) return jsonResponse({ value: [] });
      throw new Error(`unexpected call: ${url}`);
    }) as unknown as typeof fetch;

    const verifier = new ArmRoleAssignmentVerifier("client-id", "secret", mockFetch);
    const result = await verifier.verify({
      entraTenantId: "tenant-guid",
      subscriptionId: "e6ab1306-dfc4-4975-9f15-1df30c4699e2",
      resourceGroups: [],
      roleDefinitionId: roleDefId,
    });

    expect(result).toBe(false);
  });

  it("returns false if the ARM list call itself fails (403/404)", async () => {
    const mockFetch = jest.fn(async (url: string) => {
      if (url.includes("/oauth2/v2.0/token")) return jsonResponse({ access_token: "tok" });
      if (url.includes("/roleAssignments?")) return jsonResponse({ error: "forbidden" }, false, 403);
      throw new Error(`unexpected call: ${url}`);
    }) as unknown as typeof fetch;

    const verifier = new ArmRoleAssignmentVerifier("client-id", "secret", mockFetch);
    const result = await verifier.verify({
      entraTenantId: "tenant-guid",
      subscriptionId: "e6ab1306-dfc4-4975-9f15-1df30c4699e2",
      resourceGroups: [],
      roleDefinitionId: roleDefId,
    });

    expect(result).toBe(false);
  });

  it("returns false without making any network call if subscriptionId or roleDefinitionId is missing", async () => {
    const mockFetch = jest.fn(async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;

    const verifier = new ArmRoleAssignmentVerifier("client-id", "secret", mockFetch);
    const result = await verifier.verify({
      entraTenantId: "tenant-guid",
      subscriptionId: "",
      resourceGroups: [],
      roleDefinitionId: "",
    });

    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
