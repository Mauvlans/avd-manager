import { PoolClient } from "pg";
import { createHash } from "crypto";

/**
 * Cost Optimization platform, Phase 4 (per Adam's plan, message.txt §
 * 11): recommendation rule framework. Adapted from the plan's stated
 * four-function interface (Eligibility / Evidence / Savings calculation
 * / Risk calculation) into a single evaluate() per rule for this first
 * pass — real detection against real collected data (Phase 1 resources,
 * Phase 3 telemetry, Phase 2 cost), not fabricated findings.
 *
 * A rule's fingerprint must represent the logical finding, not the scan
 * that detected it (plan's own guidance) — sha256(tenantId + ruleId +
 * azureResourceId) here, so re-running detection updates last_detected_at
 * on the SAME row rather than creating a new duplicate recommendation
 * every run.
 */
export interface RuleCandidate {
  azureResourceId: string | null;
  title: string;
  summary: string;
  category: string;
  severity: "low" | "medium" | "high";
  risk: "low" | "medium" | "high";
  estimatedMonthlySavings: number | null;
  currency: string | null;
  confidenceScore: number;
  evidence: Record<string, unknown>;
}

export interface OptimizationRule {
  ruleId: string;
  version: number;
  evaluate(tenantId: string, client: PoolClient): Promise<RuleCandidate[]>;
}

export function buildFingerprint(tenantId: string, ruleId: string, azureResourceId: string | null): string {
  return createHash("sha256").update(`${tenantId}:${ruleId}:${azureResourceId ?? "none"}`).digest("hex");
}

/** Runs every registered rule against real data for a tenant, upserting
 * candidates into `recommendations` keyed on fingerprint (per plan §
 * 6.10: never a fresh row per run). Recommendations no longer detected
 * this run are marked resolved rather than deleted, preserving history —
 * matches the plan's resolved_at column existing for exactly this. */
export async function evaluateRules(
  tenantId: string,
  client: PoolClient,
  rules: OptimizationRule[]
): Promise<{ ruleId: string; candidatesFound: number }[]> {
  const results: { ruleId: string; candidatesFound: number }[] = [];
  const allFingerprints = new Set<string>();

  for (const rule of rules) {
    const candidates = await rule.evaluate(tenantId, client);
    for (const candidate of candidates) {
      const fingerprint = buildFingerprint(tenantId, rule.ruleId, candidate.azureResourceId);
      allFingerprints.add(fingerprint);

      await client.query(
        `INSERT INTO recommendations
           (tenant_id, rule_id, rule_version, azure_resource_id, fingerprint, title, summary, category, severity, risk,
            estimated_monthly_savings, currency, confidence_score, evidence, status, last_detected_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, 'open', now())
         ON CONFLICT (tenant_id, fingerprint)
         DO UPDATE SET
           title = $6, summary = $7, estimated_monthly_savings = $11, confidence_score = $13,
           evidence = $14::jsonb, last_detected_at = now(),
           status = CASE WHEN recommendations.status = 'dismissed' THEN 'dismissed' ELSE 'open' END`,
        [
          tenantId,
          rule.ruleId,
          rule.version,
          candidate.azureResourceId,
          fingerprint,
          candidate.title,
          candidate.summary,
          candidate.category,
          candidate.severity,
          candidate.risk,
          candidate.estimatedMonthlySavings,
          candidate.currency,
          candidate.confidenceScore,
          JSON.stringify(candidate.evidence),
        ]
      );
    }
    results.push({ ruleId: rule.ruleId, candidatesFound: candidates.length });
  }

  // Resolve recommendations that weren't found again this run — real
  // signal that the underlying issue was fixed (or the resource no
  // longer exists), not silently left dangling as "open" forever.
  await client.query(
    `UPDATE recommendations SET status = 'resolved', resolved_at = now()
     WHERE tenant_id = $1 AND status = 'open' AND fingerprint NOT IN (SELECT unnest($2::text[]))`,
    [tenantId, Array.from(allFingerprints)]
  );

  return results;
}
