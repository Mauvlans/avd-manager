import type { RetailPriceItem } from "@avd-manager/shared";
import type { FetchLike } from "./armHostPoolClient";

const RETAIL_PRICES_BASE = "https://prices.azure.com/api/retail/prices";

/**
 * Client for the public, UNAUTHENTICATED Azure Retail Prices API. This one
 * is safe to call live (no credentials needed) and IS exercised live in
 * development/CI to validate the integration end-to-end.
 */
export class RetailPricesClient {
  constructor(private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {}

  async getVmHourlyPrice(armSkuName: string, armRegionName: string): Promise<RetailPriceItem | null> {
    const filter = encodeURIComponent(
      `armSkuName eq '${armSkuName}' and armRegionName eq '${armRegionName}' and priceType eq 'Consumption'`
    );
    const url = `${RETAIL_PRICES_BASE}?$filter=${filter}`;
    const res = await this.fetchImpl(url, { method: "GET" });
    if (!res.ok) {
      throw new Error(`Retail Prices API request failed: ${res.status}`);
    }
    const data = await res.json();
    const items: any[] = data.Items ?? data.items ?? [];
    if (items.length === 0) return null;
    // Prefer Windows, non-spot, per-hour items when multiple SKUs match.
    const best =
      items.find((i) => i.productName?.includes("Windows") && i.unitOfMeasure === "1 Hour") ?? items[0];
    return {
      armSkuName: best.armSkuName,
      armRegionName: best.armRegionName,
      retailPrice: best.retailPrice,
      unitOfMeasure: best.unitOfMeasure,
      currencyCode: best.currencyCode,
      productName: best.productName,
      meterName: best.meterName,
    };
  }
}

/**
 * Pure cost math layered on top of RetailPricesClient — kept separate so the
 * arithmetic is unit-testable without any network access.
 */
export class CostEstimator {
  estimateHourlyCost(pricePerHour: number, hostCount: number): number {
    return Math.round(pricePerHour * hostCount * 100) / 100;
  }

  estimateCostDelta(pricePerHour: number, hostsAdded: number, hostsRemoved: number): number {
    return Math.round(pricePerHour * (hostsAdded - hostsRemoved) * 100) / 100;
  }

  estimateMonthlyCost(pricePerHour: number, hostCount: number, avgHoursRunningPerDay = 24): number {
    const daysInMonth = 30;
    return Math.round(pricePerHour * hostCount * avgHoursRunningPerDay * daysInMonth * 100) / 100;
  }
}
