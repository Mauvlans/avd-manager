import { useState } from "react";
import { getCostEstimate, CostEstimateResponse } from "../lib/api";

/** Cost dashboard: calls the public Azure Retail Prices-backed
 * /api/cost/estimate endpoint (apps/api routes/cost.ts).
 * This is the ONLY live external call in the whole system that works
 * without any tenant credentials — validated live against the real Azure
 * Retail Prices API in the previous build round. */
export default function CostDashboard() {
  const [armSkuName, setArmSkuName] = useState("Standard_D2s_v5");
  const [armRegionName, setArmRegionName] = useState("eastus");
  const [hostCount, setHostCount] = useState(1);
  const [result, setResult] = useState<CostEstimateResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleEstimate() {
    setError("");
    setBusy(true);
    try {
      setResult(await getCostEstimate(armSkuName, armRegionName, hostCount));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Cost Dashboard</h1>
      <p>
        Live estimate from the public, unauthenticated Azure Retail Prices API — no tenant
        credentials required.
      </p>
      <div className="card">
        <label>VM SKU</label>
        <input value={armSkuName} onChange={(e) => setArmSkuName(e.target.value)} />
        <label>Region</label>
        <input value={armRegionName} onChange={(e) => setArmRegionName(e.target.value)} />
        <label>Host count</label>
        <input type="number" min={1} value={hostCount} onChange={(e) => setHostCount(Number(e.target.value))} />
        <button onClick={handleEstimate} disabled={busy}>
          {busy ? "Estimating…" : "Get estimate"}
        </button>
      </div>

      {error && <p className="err">{error}</p>}

      {result && (
        <div className="card">
          <p>
            <strong>Retail price:</strong> {result.price.retailPrice} {result.price.currencyCode}/hr per host
          </p>
          <p>
            <strong>Hourly cost ({hostCount} host{hostCount === 1 ? "" : "s"}):</strong> ${result.hourlyCost.toFixed(2)}
          </p>
          <p>
            <strong>Projected monthly cost:</strong> ${result.monthlyCost.toFixed(2)}
          </p>
        </div>
      )}
    </div>
  );
}
