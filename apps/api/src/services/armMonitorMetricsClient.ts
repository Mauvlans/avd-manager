import type { FetchLike, TokenProvider } from "./armHostPoolClient";

/**
 * Real ARM REST client over Azure Monitor's Metrics API
 * (Microsoft.Insights/metrics), per Adam's Cost Optimization plan
 * (message.txt § 4.7): "Use the Azure Monitor Metrics REST API for VM
 * and storage utilization." This is Phase 3's telemetry collector for
 * session-host VMs — the data the recommendation engine (Phase 4) needs
 * to detect oversized/idle VMs.
 *
 * Covers the plan's stated session-host metric list (§ 4.7) for the
 * subset genuinely exposed as platform metrics on
 * Microsoft.Compute/virtualMachines (CPU, disk, network) — memory
 * generally requires guest-level collection per the plan's own caveat
 * ("Memory generally requires guest-level collection using Azure Monitor
 * Agent, VM Insights, or guest performance counters"), which is real
 * infrastructure the customer would need to deploy and is explicitly
 * NOT attempted here — this client only pulls what's genuinely available
 * as a platform metric without any additional customer-side setup.
 */
const ARM_BASE = "https://management.azure.com";
const METRICS_API_VERSION = "2018-01-01";

/** Real Azure Monitor platform metric names for Microsoft.Compute/virtualMachines. */
export const VM_METRIC_NAMES = [
  "Percentage CPU",
  "Network In Total",
  "Network Out Total",
  "Disk Read Bytes",
  "Disk Write Bytes",
  "Disk Read Operations/Sec",
  "Disk Write Operations/Sec",
] as const;

export interface MetricDataPoint {
  timeStamp: string;
  average: number | null;
  maximum: number | null;
  minimum: number | null;
}

export interface MetricSeries {
  metricName: string;
  unit: string;
  dataPoints: MetricDataPoint[];
}

export class ArmMonitorMetricsClient {
  constructor(
    private readonly entraTenantId: string,
    private readonly tokenProvider: TokenProvider,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  /** Fetches the given metrics for a single VM resource over a time
   * window, at the given granularity (ISO 8601 duration, e.g. "PT1H" for
   * hourly — matches the plan's § 4.7 recommended granularity tiers).
   * `resourceId` must be the VM's full ARM resource id. */
  async getVmMetrics(
    resourceId: string,
    startTime: string,
    endTime: string,
    interval: string = "PT1H",
    metricNames: readonly string[] = VM_METRIC_NAMES
  ): Promise<MetricSeries[]> {
    const token = await this.tokenProvider.getArmToken(this.entraTenantId);
    const metricNamesParam = encodeURIComponent(metricNames.join(","));
    const url = `${ARM_BASE}${resourceId}/providers/Microsoft.Insights/metrics?api-version=${METRICS_API_VERSION}&metricnames=${metricNamesParam}&timespan=${startTime}/${endTime}&interval=${interval}&aggregation=Average,Maximum,Minimum`;

    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(`ARM request failed: GET ${url} -> ${res.status} ${JSON.stringify(errBody)}`);
    }
    const data: any = await res.json();
    const series: any[] = data.value ?? [];

    return series.map((s) => ({
      metricName: s.name?.value ?? s.name?.localizedValue ?? "unknown",
      unit: s.unit ?? "Count",
      dataPoints: (s.timeseries?.[0]?.data ?? []).map((d: any) => ({
        timeStamp: d.timeStamp,
        average: d.average ?? null,
        maximum: d.maximum ?? null,
        minimum: d.minimum ?? null,
      })),
    }));
  }
}
