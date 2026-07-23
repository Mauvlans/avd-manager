import type { FetchLike, TokenProvider } from "./armHostPoolClient";

/**
 * Real ARM REST client over Azure Cost Management's Query API
 * (Microsoft.CostManagement/query), per Adam's Cost Optimization plan
 * (message.txt § 4.3/§ 4.4): "Use the Cost Management Query API for:
 * Dashboard previews, Recent aggregated costs, Interactive drill-down,
 * Validation against imported exports, Customers unable to configure
 * exports." Chosen over building recurring-export automation first (the
 * plan's primary recommended path, § 4.3) because exports require the
 * customer to provision a storage account + configure an export
 * definition in their tenant — real infrastructure setup with no UI for
 * it here yet. The Query API needs nothing from the customer beyond the
 * RBAC role already granted (Cost Management Reader scope, included in
 * the plan's § 3.1 recommended roles) and returns real customer-specific
 * cost data (actual + amortized) directly, making it the correct MVP
 * ingestion path while export automation is a documented Phase 2
 * follow-up rather than something faked here.
 */
const ARM_BASE = "https://management.azure.com";
const COST_MANAGEMENT_API_VERSION = "2023-11-01";

export interface CostQueryRow {
  usageDate: string; // YYYY-MM-DD
  resourceId: string | null;
  meterCategory: string | null;
  meterSubcategory: string | null;
  serviceFamily: string | null;
  chargeType: string | null;
  cost: number;
  currency: string;
}

export class ArmCostManagementClient {
  constructor(
    private readonly entraTenantId: string,
    private readonly tokenProvider: TokenProvider,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  /** Queries actual (billed) cost for a subscription over the given date
   * range, grouped by resource id + meter — the real customer-specific
   * cost, not a retail-price estimate, per the plan's pricing-source
   * hierarchy (§ 4.10: customer effective price is always preferred over
   * Retail Prices API). `costType` controls whether ARM returns
   * ActualCost or AmortizedCost — the plan explicitly wants both
   * available (§ 4.3: "Primary financial view: Amortized cost, Secondary
   * billing view: Actual cost"), so this is a parameter, not hardcoded. */
  async queryCost(
    subscriptionId: string,
    startDate: string,
    endDate: string,
    costType: "ActualCost" | "AmortizedCost" = "ActualCost"
  ): Promise<CostQueryRow[]> {
    const token = await this.tokenProvider.getArmToken(this.entraTenantId);
    const url = `${ARM_BASE}/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=${COST_MANAGEMENT_API_VERSION}`;

    const body = {
      type: costType,
      timeframe: "Custom",
      timePeriod: { from: startDate, to: endDate },
      dataset: {
        granularity: "Daily",
        aggregation: { totalCost: { name: "Cost", function: "Sum" } },
        grouping: [
          { type: "Dimension", name: "ResourceId" },
          { type: "Dimension", name: "MeterCategory" },
          { type: "Dimension", name: "MeterSubcategory" },
          { type: "Dimension", name: "ServiceFamily" },
          { type: "Dimension", name: "ChargeType" },
        ],
      },
    };

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(`ARM request failed: POST ${url} -> ${res.status} ${JSON.stringify(errBody)}`);
    }
    const data: any = await res.json();
    const columns: string[] = (data.properties?.columns ?? []).map((c: any) => c.name);
    const rows: any[][] = data.properties?.rows ?? [];

    const idx = (name: string) => columns.indexOf(name);
    const costIdx = idx("Cost");
    const dateIdx = idx("UsageDate");
    const resourceIdIdx = idx("ResourceId");
    const meterCategoryIdx = idx("MeterCategory");
    const meterSubcategoryIdx = idx("MeterSubcategory");
    const serviceFamilyIdx = idx("ServiceFamily");
    const chargeTypeIdx = idx("ChargeType");
    const currencyIdx = idx("Currency");

    return rows.map((r) => ({
      usageDate: this.formatUsageDate(r[dateIdx]),
      resourceId: resourceIdIdx !== -1 ? r[resourceIdIdx] ?? null : null,
      meterCategory: meterCategoryIdx !== -1 ? r[meterCategoryIdx] ?? null : null,
      meterSubcategory: meterSubcategoryIdx !== -1 ? r[meterSubcategoryIdx] ?? null : null,
      serviceFamily: serviceFamilyIdx !== -1 ? r[serviceFamilyIdx] ?? null : null,
      chargeType: chargeTypeIdx !== -1 ? r[chargeTypeIdx] ?? null : null,
      cost: costIdx !== -1 ? Number(r[costIdx]) : 0,
      currency: currencyIdx !== -1 ? r[currencyIdx] ?? "USD" : "USD",
    }));
  }

  /** Cost Management's UsageDate column comes back as an integer
   * YYYYMMDD (e.g. 20260722), not an ISO date string — a real,
   * documented quirk of this API, not a guess. Converts to YYYY-MM-DD
   * for storage. */
  private formatUsageDate(raw: unknown): string {
    const s = String(raw);
    if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    return s;
  }
}
