import { Router } from "express";
import { RetailPricesClient, CostEstimator } from "../services/costEstimator";

/**
 * Cost estimation routes, split out of the now-retired scalingPolicies.ts.
 *
 * Why this file exists on its own: cost estimation (public Azure Retail
 * Prices lookups) has nothing to do with the custom scaling-policy engine
 * that used to live in scalingPolicies.ts — it just happened to share a
 * file with it. When the custom scaling engine was retired in favor of
 * thin ARM wrappers around Azure's native AVD Scaling Plans (Adam's
 * decision — no need to duplicate Azure's own scheduling logic), the cost
 * estimator had to move somewhere that survives the deletion. This route
 * is unauthenticated on purpose: it only proxies the public Azure Retail
 * Prices API and never touches tenant data.
 */
export const costRouter = Router();

const retailPricesClient = new RetailPricesClient();
const costEstimator = new CostEstimator();

costRouter.get("/estimate", async (req, res) => {
  const armSkuName = (req.query.armSkuName as string) || "Standard_D2s_v5";
  const armRegionName = (req.query.armRegionName as string) || "eastus";
  const hostCount = Number(req.query.hostCount ?? 1);

  try {
    const price = await retailPricesClient.getVmHourlyPrice(armSkuName, armRegionName);
    if (!price) {
      return res.status(404).json({ error: `no retail price found for ${armSkuName} in ${armRegionName}` });
    }
    res.json({
      price,
      hourlyCost: costEstimator.estimateHourlyCost(price.retailPrice, hostCount),
      monthlyCost: costEstimator.estimateMonthlyCost(price.retailPrice, hostCount),
    });
  } catch (err) {
    res.status(502).json({ error: `retail prices API call failed: ${(err as Error).message}` });
  }
});
