import { withTenant } from "../db/pool";
import { writeAuditLog } from "../lib/auditLog";
import { ArmMonitorMetricsClient, VM_METRIC_NAMES } from "./armMonitorMetricsClient";
import { ArmHostPoolClient } from "./armHostPoolClient";
import { resolveArmAuth } from "./armAuthResolver";

/**
 * Cost Optimization platform, Phase 3: AVD telemetry collection. Per
 * Adam's plan (§ 4.7/§ 4.2): pulls real Azure Monitor VM metrics for
 * every session-host VM discovered by Phase 1's Resource Graph
 * inventory, and real session-host counts per host pool via the
 * existing ArmHostPoolClient (already used elsewhere in this app for
 * the Host Pools UI — reused here rather than re-implemented).
 *
 * Does NOT attempt Log Analytics/WVDConnections collection (plan § 4.8)
 * in this pass — that requires the customer to have diagnostic settings
 * already configured sending AVD logs to a Log Analytics workspace,
 * which is real infrastructure this product doesn't provision on the
 * customer's behalf yet. Documented as a follow-up, not silently
 * skipped: session/concurrency facts here are approximated from the
 * AVD REST API's live session-host state (session counts, running
 * status) rather than historical Log Analytics query results.
 */
export async function runTelemetryCollection(
  tenantId: string,
  subscriptionIds: string[]
): Promise<{ collectionRunId: string; vmsCollected: number; hostPoolsCollected: number; metricPointsIngested: number; errors: string[] }> {
  const collectionRunId = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO collection_runs (tenant_id, collector_type, status) VALUES ($1, 'avd_telemetry', 'running') RETURNING id`,
      [tenantId]
    );
    return rows[0].id;
  });

  const errors: string[] = [];
  let vmsCollected = 0;
  let hostPoolsCollected = 0;
  let metricPointsIngested = 0;

  try {
    const { entraTenantId, tokenProvider } = await resolveArmAuth(tenantId);
    const metricsClient = new ArmMonitorMetricsClient(entraTenantId, tokenProvider);
    const hostPoolClient = new ArmHostPoolClient(entraTenantId, tokenProvider);

    // VM metrics: pull for every microsoft.compute/virtualmachines
    // resource already discovered by Phase 1's inventory collection,
    // scoped to the subscriptions this run cares about.
    const vmResources = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT azure_resource_id, subscription_id FROM resources
         WHERE tenant_id = $1 AND resource_type = 'microsoft.compute/virtualmachines'
           AND subscription_id = ANY($2) AND deleted_at IS NULL`,
        [tenantId, subscriptionIds]
      );
      return rows;
    });

    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000); // last 24h for this pass

    for (const vm of vmResources) {
      try {
        const series = await metricsClient.getVmMetrics(
          vm.azure_resource_id,
          startTime.toISOString(),
          endTime.toISOString(),
          "PT1H",
          VM_METRIC_NAMES
        );
        metricPointsIngested += await upsertMetricSeries(tenantId, vm.azure_resource_id, series);
        vmsCollected++;
      } catch (err) {
        errors.push(`VM ${vm.azure_resource_id}: ${(err as Error).message}`);
      }
    }

    // Host pool session/scaling facts: pull real session-host state for
    // every discovered host pool, via the same ArmHostPoolClient the
    // Host Pools UI already uses.
    const hostPoolResources = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT azure_resource_id, subscription_id, resource_group, resource_name FROM resources
         WHERE tenant_id = $1 AND resource_type = 'microsoft.desktopvirtualization/hostpools'
           AND subscription_id = ANY($2) AND deleted_at IS NULL`,
        [tenantId, subscriptionIds]
      );
      return rows;
    });

    for (const pool of hostPoolResources) {
      try {
        const hosts = await hostPoolClient.listSessionHosts(pool.subscription_id, pool.resource_group, pool.resource_name);
        const runningCount = hosts.filter((h) => h.status?.toLowerCase() === "available").length;
        const activeCount = hosts.filter((h) => h.sessions > 0).length;
        const totalSessions = hosts.reduce((sum, h) => sum + (h.sessions ?? 0), 0);

        await withTenant(tenantId, async (client) => {
          await client.query(
            `INSERT INTO avd_session_hourly (tenant_id, host_pool_azure_resource_id, bucket_start, running_session_host_count, active_session_host_count, total_sessions)
             VALUES ($1, $2, date_trunc('hour', now()), $3, $4, $5)
             ON CONFLICT (tenant_id, host_pool_azure_resource_id, bucket_start)
             DO UPDATE SET running_session_host_count = $3, active_session_host_count = $4, total_sessions = $5, ingested_at = now()`,
            [tenantId, pool.azure_resource_id, runningCount, activeCount, totalSessions]
          );
        });
        hostPoolsCollected++;
      } catch (err) {
        errors.push(`Host pool ${pool.azure_resource_id}: ${(err as Error).message}`);
      }
    }

    await withTenant(tenantId, async (dbClient) => {
      await writeAuditLog(dbClient, {
        tenantId,
        actor: "system:avd-telemetry-collector",
        action: "telemetry_collected",
        resourceType: "collection_runs",
        resourceId: collectionRunId,
        beforeState: null,
        afterState: { vmsCollected, hostPoolsCollected, metricPointsIngested, errorCount: errors.length },
      });
      await dbClient.query(
        `UPDATE collection_runs SET status = $2, completed_at = now(), record_count = $3, error_details = $4::jsonb WHERE id = $1`,
        [
          collectionRunId,
          errors.length > 0 && vmsCollected === 0 && hostPoolsCollected === 0 ? "failed" : "succeeded",
          metricPointsIngested,
          errors.length > 0 ? JSON.stringify({ errors }) : null,
        ]
      );
    });

    return { collectionRunId, vmsCollected, hostPoolsCollected, metricPointsIngested, errors };
  } catch (err) {
    await withTenant(tenantId, async (dbClient) => {
      await dbClient.query(
        `UPDATE collection_runs SET status = 'failed', completed_at = now(), error_details = $2::jsonb WHERE id = $1`,
        [collectionRunId, JSON.stringify({ message: (err as Error).message })]
      );
    });
    throw err;
  }
}

async function upsertMetricSeries(
  tenantId: string,
  azureResourceId: string,
  series: { metricName: string; unit: string; dataPoints: { timeStamp: string; average: number | null; maximum: number | null; minimum: number | null }[] }[]
): Promise<number> {
  return withTenant(tenantId, async (client) => {
    let count = 0;
    for (const s of series) {
      for (const point of s.dataPoints) {
        if (point.average === null && point.maximum === null && point.minimum === null) continue;
        await client.query(
          `INSERT INTO metric_hourly (tenant_id, azure_resource_id, metric_time, metric_name, average_value, maximum_value, minimum_value, unit)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (tenant_id, azure_resource_id, metric_time, metric_name)
           DO UPDATE SET average_value = $5, maximum_value = $6, minimum_value = $7, unit = $8, ingested_at = now()`,
          [tenantId, azureResourceId.toLowerCase(), point.timeStamp, s.metricName, point.average, point.maximum, point.minimum, s.unit]
        );
        count++;
      }
    }
    return count;
  });
}
