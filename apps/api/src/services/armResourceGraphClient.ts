import type { FetchLike, TokenProvider } from "./armHostPoolClient";

/**
 * Real ARM REST client over Azure Resource Graph's `resources` query API
 * (Microsoft.ResourceGraph, NOT a resource-provider-specific API) — the
 * primary inventory source for the Cost Optimization platform's Phase 1,
 * per Adam's plan (message.txt § 4.1): "Azure Resource Graph should be
 * the primary inventory source because it can query Azure resources
 * across many subscriptions efficiently."
 *
 * Uses the POST /providers/Microsoft.ResourceGraph/resources endpoint
 * with a KQL query, scoped to the given subscription ids — this is a
 * single real ARM call, not per-resource-type calls, matching the plan's
 * stated efficiency rationale for Resource Graph over enumerating each
 * resource provider's own list API individually.
 */
const ARM_BASE = "https://management.azure.com";
const RESOURCE_GRAPH_API_VERSION = "2021-03-01";

export interface ResourceGraphRow {
  id: string;
  name: string;
  type: string;
  resourceGroup: string;
  location: string;
  subscriptionId: string;
  sku: unknown;
  tags: Record<string, string>;
  properties: unknown;
}

export interface ResourceGraphQueryResult {
  rows: ResourceGraphRow[];
  totalRecords: number;
  skipToken: string | null;
}

export class ArmResourceGraphClient {
  constructor(
    private readonly entraTenantId: string,
    private readonly tokenProvider: TokenProvider,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  /** Runs a Resource Graph KQL query scoped to the given subscription ids.
   * Pass a custom `query` to filter by resource type/etc — defaults to a
   * broad "everything" projection matching the plan's § 4.1 field list
   * (id, name, type, resourceGroup, location, subscriptionId, sku, tags,
   * properties). Paginates via skipToken until Resource Graph reports no
   * more pages or `maxPages` is reached (default 20 — Resource Graph
   * pages are up to 1000 rows each, so 20 pages covers up to 20,000
   * resources before a caller needs to explicitly ask for more). */
  async queryResources(
    subscriptionIds: string[],
    opts?: { query?: string; maxPages?: number }
  ): Promise<ResourceGraphRow[]> {
    const query =
      opts?.query ??
      "Resources | project id, name, type, resourceGroup, location, subscriptionId, sku, tags, properties";
    const maxPages = opts?.maxPages ?? 20;

    const token = await this.tokenProvider.getArmToken(this.entraTenantId);
    const url = `${ARM_BASE}/providers/Microsoft.ResourceGraph/resources?api-version=${RESOURCE_GRAPH_API_VERSION}`;

    const rows: ResourceGraphRow[] = [];
    let skipToken: string | undefined;
    let pages = 0;

    do {
      const body: Record<string, unknown> = {
        subscriptions: subscriptionIds,
        query,
      };
      if (skipToken) body.options = { $skipToken: skipToken };

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
      const pageRows: any[] = data.data ?? [];
      for (const r of pageRows) {
        rows.push({
          id: r.id,
          name: r.name,
          type: r.type,
          resourceGroup: r.resourceGroup,
          location: r.location,
          subscriptionId: r.subscriptionId,
          sku: r.sku ?? null,
          tags: r.tags ?? {},
          properties: r.properties ?? {},
        });
      }
      skipToken = data.$skipToken;
      pages++;
    } while (skipToken && pages < maxPages);

    return rows;
  }
}
