import type { FetchLike, TokenProvider } from "./armHostPoolClient";

/**
 * Resolves an Azure subscription's real displayName via ARM
 * (GET /subscriptions/{id}), for showing a human-readable label instead
 * of a raw subscription GUID — per Adam's Host Pools mock ("MSFT -
 * External Sub - Mauvlan" instead of a bare id). This is a genuine Azure
 * Subscription resource property (Microsoft.Resources subscriptions API,
 * not something we invent or ask an admin to type in), fetched once at
 * the moment RBAC is granted (see onboardingService.recordRbacGranted)
 * and cached in subscriptions_registry.subscription_display_name rather
 * than looked up live on every page render.
 */
const ARM_BASE = "https://management.azure.com";
const SUBSCRIPTIONS_API_VERSION = "2022-12-01";

export class ArmSubscriptionInfoClient {
  constructor(
    private readonly entraTenantId: string,
    private readonly tokenProvider: TokenProvider,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  /** Returns the subscription's real displayName, or null if the lookup
   * fails (network hiccup, insufficient permission on this one call) —
   * soft failure, matching onboardingService.resolveOwnServicePrincipalId's
   * precedent of not blocking the whole RBAC-grant recording on one
   * best-effort enrichment call. */
  async getDisplayName(subscriptionId: string): Promise<string | null> {
    try {
      const token = await this.tokenProvider.getArmToken(this.entraTenantId);
      const res = await this.fetchImpl(`${ARM_BASE}/subscriptions/${subscriptionId}?api-version=${SUBSCRIPTIONS_API_VERSION}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return typeof data.displayName === "string" ? data.displayName : null;
    } catch {
      return null;
    }
  }
}
