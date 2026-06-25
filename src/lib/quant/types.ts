export type QuantChartConfig = {
  type: "bar" | "line";
  x: string;
  y: string;
  title?: string;
};

/**
 * Where a catalog dataset physically lives. The public prototype only ships
 * `csv`; a private deployment adds backends (e.g. `clickhouse`) without
 * touching this union being open-ended enough to carry their config.
 */
export type DatasetSource =
  | { kind: "csv"; path: string }
  | { kind: "clickhouse"; database?: string; table: string }
  | { kind: string; [key: string]: unknown };

/** One dataset in the loaded catalog (see config/catalog.*.json). */
export type DatasetMeta = {
  id: string;
  /** SQL identifier the agent queries against (e.g. "crm_accounts"). */
  table: string;
  /** Grouping label for the catalog markdown (e.g. "crm", "finance"). */
  domain: string;
  description: string;
  source: DatasetSource;
};

/** Result of a single read-only SELECT against the active provider. */
export type SelectResult = {
  columns: string[];
  rows: Record<string, unknown>[];
};

/** One row of the agent's `list_tables` tool. */
export type TableSummary = {
  datasetId: string;
  table: string;
  domain: string;
  description: string;
};

export type ColumnInfo = {
  name: string;
  type: string;
  /** Up to ~30 distinct values for low-cardinality string columns; null otherwise. */
  exampleValues: string[] | null;
};

export type TableInfo = {
  datasetId: string;
  table: string;
  domain: string;
  description: string;
  rowCount: number;
  columns: ColumnInfo[];
};

export type QuantTable = {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
};

/** Audit entry for a single SQL statement the agent ran during a quant call. */
export type QuantSqlAudit = {
  sql: string;
  rowCount: number;
  durationMs: number;
  /** Present when the statement errored — error message from DuckDB or the guard. */
  error?: string;
};

export type QuantResult = {
  hypothesis_under_test: string;
  /** Catalog ids referenced via SQL (best-effort: any table mentioned in a successful run_sql call). */
  datasetId?: string;
  datasetIdsUsed?: string[];
  tables: QuantTable[];
  /** Vega-Lite v5 specs (render client-side). */
  vegaLiteSpecs: Array<{ title: string; spec: Record<string, unknown> }>;
  /** Short numeric takeaway for the narrative. */
  narrative?: string;
  error?: string;
  executedAt: string;
  /** All SQL statements the agent executed (for debugging / display). */
  sqlAudit?: QuantSqlAudit[];
};
