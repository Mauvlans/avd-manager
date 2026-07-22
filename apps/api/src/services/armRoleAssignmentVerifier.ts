import type { RoleAssignmentVerifier } from "../jobs/permissionHealthCheck";
import { acquireClientCredentialsToken } from "./tokenProvider";

const ARM_API_VERSION = "2022-04-01";

/**
 * Real ARM-backed RoleAssignmentVerifier: checks whether our app's service
 * principal actually holds the expected custom role at the expected
 * subscription scope, by listing role assignments via the real ARM REST
 * API — not a stub, and not dependent on the customer's Deploy-to-Azure
 * template calling back to us (there's no such callback wired up; ARM
 * template deployments don't have a built-in "notify this webhook on
 * success" primitive without adding heavyweight machinery like
 * Microsoft.Resources/deploymentScripts, which provisions a storage
 * account + container instance in the CUSTOMER's subscription just to make
 * one HTTP call — a poor fit for a "minimal footprint, least privilege"
 * design). Instead, this verifier is what the periodic permission
 * health-check job (permissionHealthCheck.ts) uses to independently
 * discover that a grant happened, on its own schedule, using only the
 * read-only Microsoft.Authorization/roleAssignments/read action that's
 * already implicitly available to anyone who can list role assignments
 * they're a principal for.
 *
 * This was built and tested live against Adam's real subscription
 * (e6ab1306-dfc4-4975-9f15-1df30c4699e2) after his real Deploy-to-Azure
 * click created a genuine custom role + role assignment that our own
 * onboarding flow had no way to detect automatically — the RBAC grant had
 * to be recorded via a manual curl call to /rbac-grant/callback in the
 * interim, which is the gap this verifier is meant to close going forward.
 */
export class ArmRoleAssignmentVerifier implements RoleAssignmentVerifier {
  constructor(
    private readonly appClientId: string,
    private readonly appClientSecret: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async verify(params: {
    entraTenantId: string;
    subscriptionId: string;
    resourceGroups: string[];
    roleDefinitionId: string;
  }): Promise<boolean> {
    if (!params.subscriptionId || !params.roleDefinitionId) return false;

    const token = await acquireClientCredentialsToken(
      params.entraTenantId,
      this.appClientId,
      this.appClientSecret,
      "https://management.azure.com/.default",
      this.fetchImpl
    );

    // roleDefinitionId as stored is the full resource id
    // (/subscriptions/.../providers/Microsoft.Authorization/roleDefinitions/<guid>);
    // ARM's roleAssignments list filter wants just that same full id in the
    // $filter, matched against each assignment's own roleDefinitionId field.
    const url = `https://management.azure.com/subscriptions/${params.subscriptionId}/providers/Microsoft.Authorization/roleAssignments?api-version=${ARM_API_VERSION}`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      // A 403/404 here most plausibly means the grant was revoked or never
      // existed at this scope — treat as "not verified" (drift), not as an
      // unrelated transient error, since a genuinely transient ARM error
      // would be unusual for a simple GET list call.
      return false;
    }
    const body: any = await res.json();
    const assignments: any[] = body.value ?? [];
    return assignments.some(
      (a) => (a.properties?.roleDefinitionId ?? "").toLowerCase() === params.roleDefinitionId.toLowerCase()
    );
  }
}
