export type QuantChartConfig = {
  type: "bar" | "line";
  x: string;
  y: string;
  title?: string;
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
