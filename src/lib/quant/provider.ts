import type { SelectResult, TableInfo, TableSummary } from "./types";

/**
 * The data backend behind the quant agent. The agent only ever speaks SQL +
 * three introspection calls, so swapping warehouses (DuckDB-over-CSV in the
 * public prototype, ClickHouse in a private deployment) is a matter of
 * implementing this interface — no change to agent.ts, the SQL guard, or the
 * chart builder.
 *
 * A provider is selected at runtime by the QUANT_PROVIDER env var. The registry
 * dynamically imports `./providers/<name>`, so a private deployment registers
 * its backend simply by dropping a module in that folder (excluded from the
 * public publish allowlist) and setting QUANT_PROVIDER to its name.
 */
export interface QuantProvider {
  /** Stable id for logs/debugging (e.g. "duckdb-csv", "clickhouse"). */
  readonly id: string;
  /** SQL dialect the agent should target — surfaced in its system prompt. */
  readonly dialect: "duckdb" | "clickhouse" | string;
  /** Execute a single read-only SELECT/WITH (already passed through the guard). */
  runSelect(sql: string): Promise<SelectResult>;
  /** One-line summary per catalog dataset for the agent's `list_tables` tool. */
  listTables(): Promise<TableSummary[]>;
  /** Columns, types, and enum samples for one table (accepts id or table name). */
  describeTable(idOrTable: string): Promise<TableInfo>;
  /**
   * Raw dataset text for the /api/quant/file download route. Only file-backed
   * providers (CSV) implement this; the route 404s when it is absent.
   */
  getDatasetText?(datasetId: string): Promise<string>;
}

/** Friendly QUANT_PROVIDER values → module file name under ./providers. */
const ALIASES: Record<string, string> = {
  "duckdb-csv": "duckdbCsv",
  duckdb: "duckdbCsv",
};

const DEFAULT_PROVIDER = "duckdb-csv";

let cached: Promise<QuantProvider> | null = null;

/** The active provider, resolved once from QUANT_PROVIDER and memoised. */
export function getProvider(): Promise<QuantProvider> {
  return (cached ??= resolveProvider());
}

async function resolveProvider(): Promise<QuantProvider> {
  const kind = process.env.QUANT_PROVIDER?.trim() || DEFAULT_PROVIDER;
  const moduleName = ALIASES[kind] ?? kind;
  let mod: { createProvider?: () => QuantProvider | Promise<QuantProvider> };
  try {
    mod = await import(`./providers/${moduleName}`);
  } catch (e) {
    throw new Error(
      `Unknown QUANT_PROVIDER "${kind}": could not load module ./providers/${moduleName}. ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  if (typeof mod.createProvider !== "function") {
    throw new Error(
      `Provider module ./providers/${moduleName} must export createProvider(): QuantProvider.`,
    );
  }
  return mod.createProvider();
}
