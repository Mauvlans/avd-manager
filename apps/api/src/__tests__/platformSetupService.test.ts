import { PlatformSetupService } from "../services/platformSetupService";
import type { FetchLike } from "../services/armHostPoolClient";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as any;
}

describe("PlatformSetupService (mocked Graph/AAD HTTP)", () => {
  it("startDeviceCode posts to the AAD devicecode endpoint with the well-known Graph PowerShell client id", async () => {
    const mockFetch: FetchLike = jest.fn(async () =>
      jsonResponse({
        device_code: "dc123",
        user_code: "ABC-DEF",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 900,
        interval: 5,
        message: "go sign in",
      })
    ) as unknown as FetchLike;

    const service = new PlatformSetupService(mockFetch);
    const session = await service.startDeviceCode();

    expect(session.user_code).toBe("ABC-DEF");
    const [url, init] = (mockFetch as jest.Mock).mock.calls[0];
    expect(url).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode");
    expect(init.body).toContain("client_id=14d82eec-204b-4c2f-b7e8-296a70dab67e");
    expect(init.body).toContain("Application.ReadWrite.All");
  });

  it("pollDeviceCode returns pending on authorization_pending", async () => {
    const mockFetch: FetchLike = jest.fn(async () =>
      jsonResponse({ error: "authorization_pending" }, false, 400)
    ) as unknown as FetchLike;
    const service = new PlatformSetupService(mockFetch);
    const outcome = await service.pollDeviceCode("dc123");
    expect(outcome.status).toBe("pending");
  });

  it("pollDeviceCode returns authorized with tokens on success", async () => {
    const mockFetch: FetchLike = jest.fn(async () =>
      jsonResponse({ access_token: "at123", refresh_token: "rt123" }, true, 200)
    ) as unknown as FetchLike;
    const service = new PlatformSetupService(mockFetch);
    const outcome = await service.pollDeviceCode("dc123");
    expect(outcome.status).toBe("authorized");
    if (outcome.status === "authorized") {
      expect(outcome.accessToken).toBe("at123");
    }
  });

  it("pollDeviceCode returns expired/denied appropriately", async () => {
    const expiredFetch: FetchLike = jest.fn(async () =>
      jsonResponse({ error: "expired_token" }, false, 400)
    ) as unknown as FetchLike;
    const service1 = new PlatformSetupService(expiredFetch);
    expect((await service1.pollDeviceCode("dc")).status).toBe("expired");

    const deniedFetch: FetchLike = jest.fn(async () =>
      jsonResponse({ error: "access_denied", error_description: "user declined" }, false, 400)
    ) as unknown as FetchLike;
    const service2 = new PlatformSetupService(deniedFetch);
    const outcome = await service2.pollDeviceCode("dc");
    expect(outcome.status).toBe("denied");
  });

  it("createPlatformAppRegistration creates app, service principal, secret, and grants app roles against Microsoft Graph's resource SP (not our own)", async () => {
    const calls: string[] = [];
    const mockFetch: FetchLike = jest.fn(async (url: string, init?: any) => {
      calls.push(url);
      if (url === "https://graph.microsoft.com/v1.0/applications") {
        return jsonResponse({ id: "obj-1", appId: "app-1" });
      }
      if (url === "https://graph.microsoft.com/v1.0/servicePrincipals") {
        return jsonResponse({ id: "sp-1" });
      }
      if (url.includes("/addPassword")) {
        return jsonResponse({ secretText: "s3cr3t" });
      }
      if (url.includes("$filter=appId eq '00000003-0000-0000-c000-000000000000'")) {
        return jsonResponse({ value: [{ id: "graph-resource-sp-id" }] });
      }
      if (url.includes("/appRoleAssignedTo")) {
        return jsonResponse({});
      }
      throw new Error(`unexpected call: ${url}`);
    }) as unknown as FetchLike;

    const service = new PlatformSetupService(mockFetch);
    const result = await service.createPlatformAppRegistration(
      "admin-access-token",
      "AVD Manager (dev)",
      "http://localhost:4001/api/onboarding/graph-consent/callback"
    );

    expect(result).toEqual({
      appId: "app-1",
      objectId: "obj-1",
      clientSecret: "s3cr3t",
      servicePrincipalId: "sp-1",
      adminConsentGranted: true,
    });

    // Verify the redirect URI was registered on the app at creation time —
    // without this, real admin-consent sign-ins fail with AADSTS500113
    // ("No reply address is registered for the application").
    const createAppCall = (mockFetch as jest.Mock).mock.calls.find(
      ([url]: [string]) => url === "https://graph.microsoft.com/v1.0/applications"
    );
    const createAppBody = JSON.parse(createAppCall[1].body);
    expect(createAppBody.web.redirectUris).toEqual(["http://localhost:4001/api/onboarding/graph-consent/callback"]);

    // Verify the app-role grants were resourced against Graph's SP, not our own
    const grantCalls = (mockFetch as jest.Mock).mock.calls.filter(([url]: [string]) =>
      url.includes("/appRoleAssignedTo")
    );
    expect(grantCalls.length).toBe(3); // User.Read.All, Group.Read.All, Directory.Read.All
    for (const [, init] of grantCalls) {
      const body = JSON.parse(init.body);
      expect(body.resourceId).toBe("graph-resource-sp-id");
      expect(body.principalId).toBe("sp-1");
    }
  });

  it("createPlatformAppRegistration surfaces adminConsentGranted=false if a role grant fails", async () => {
    const mockFetch: FetchLike = jest.fn(async (url: string) => {
      if (url === "https://graph.microsoft.com/v1.0/applications") return jsonResponse({ id: "obj-1", appId: "app-1" });
      if (url === "https://graph.microsoft.com/v1.0/servicePrincipals") return jsonResponse({ id: "sp-1" });
      if (url.includes("/addPassword")) return jsonResponse({ secretText: "s3cr3t" });
      if (url.includes("$filter=appId eq")) return jsonResponse({ value: [{ id: "graph-resource-sp-id" }] });
      if (url.includes("/appRoleAssignedTo")) return jsonResponse({ error: "forbidden" }, false, 403);
      throw new Error(`unexpected call: ${url}`);
    }) as unknown as FetchLike;

    const service = new PlatformSetupService(mockFetch);
    const result = await service.createPlatformAppRegistration(
      "admin-access-token",
      "AVD Manager (dev)",
      "http://localhost:4001/api/onboarding/graph-consent/callback"
    );
    expect(result.adminConsentGranted).toBe(false);
  });
});
