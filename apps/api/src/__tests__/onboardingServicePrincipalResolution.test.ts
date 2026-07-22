import { OnboardingService } from "../services/onboardingService";

// These tests only exercise recordGraphConsentGranted's SP-resolution
// branch logic (no secret configured => soft-fail to null, not throw) by
// mocking global fetch — the DB-touching parts of recordGraphConsentGranted
// are exercised indirectly via the onboardingRegistryRoute supertest suite,
// which mocks db/pool directly instead. This suite is deliberately narrow:
// it exists specifically to guard the regression Adam hit live (Microsoft's
// real admin-consent redirect has no servicePrincipalId param, so the
// service principal must be resolved via a separate Graph lookup, and that
// lookup must never crash the whole callback if it fails).
describe("OnboardingService.resolveOwnServicePrincipalId (via recordGraphConsentGranted)", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("does not throw and records a null service principal id when no client secret is configured", async () => {
    // withSystem/withTenant hit a real db/pool import that isn't mocked in
    // this file — so instead we test resolveOwnServicePrincipalId's pure
    // decision logic directly via a thin reflection trick: constructing the
    // service with no secret and confirming it returns null without any
    // network call at all (the "if (!this.appClientSecret) return null"
    // fast path), which is the exact case that must never throw.
    const service = new OnboardingService("client-id", "http://redirect", "http://deploy", null);
    const resolve = (service as any).resolveOwnServicePrincipalId.bind(service);
    const result = await resolve("280bf3c4-6674-481d-907a-2e873c775e72");
    expect(result).toBeNull();
  });

  it("looks up the service principal via Graph using a client-credentials token when a secret IS configured", async () => {
    const calls: string[] = [];
    global.fetch = jest.fn(async (url: any, init?: any) => {
      calls.push(String(url));
      if (String(url).includes("/oauth2/v2.0/token")) {
        return { ok: true, json: async () => ({ access_token: "graph-token-123" }) } as any;
      }
      if (String(url).includes("/servicePrincipals?")) {
        return { ok: true, json: async () => ({ value: [{ id: "sp-object-id-abc" }] }) } as any;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as any;

    const service = new OnboardingService("client-id", "http://redirect", "http://deploy", "s3cr3t");
    const resolve = (service as any).resolveOwnServicePrincipalId.bind(service);
    const result = await resolve("280bf3c4-6674-481d-907a-2e873c775e72");

    expect(result).toBe("sp-object-id-abc");
    expect(calls[0]).toContain("login.microsoftonline.com/280bf3c4-6674-481d-907a-2e873c775e72/oauth2/v2.0/token");
    expect(calls[1]).toContain("servicePrincipals?$filter=appId eq 'client-id'");
  });

  it("soft-fails to null (does not throw) if the Graph lookup errors", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("network blip");
    }) as any;

    const service = new OnboardingService("client-id", "http://redirect", "http://deploy", "s3cr3t");
    const resolve = (service as any).resolveOwnServicePrincipalId.bind(service);
    const result = await resolve("280bf3c4-6674-481d-907a-2e873c775e72");
    expect(result).toBeNull();
  });
});
