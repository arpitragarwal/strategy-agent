export type QuantChartType =
  | "bar"
  | "line"
  | "area"
  | "point"
  | "histogram"
  | "heatmap"
  | "combo"
  | "boxplot";

export type QuantChartConfig = {
  type: QuantChartType;
  x: string;
  y: string;
  /**
   * Meaning depends on type:
   * - bar/line/area/point: column that splits data into colored series.
   * - heatmap: the numeric column shown as the cell color (x and y are the two categories).
   * - combo: the second metric drawn as a line on the right axis (y is the bars).
   */
  series?: string;
  /** Bars only: render horizontally (better for long category labels). */
  horizontal?: boolean;
  /** Bar/area with a series: stack instead of grouping/overlaying. */
  stacked?: boolean;
  /** Aggregate applied to the value field so SQL needn't pre-group (count needs no y). */
  aggregate?: "sum" | "mean" | "median" | "min" | "max" | "count";
  /** Optional reference line on the value axis (a fixed value, or mean/median of the data). */
  refLine?: { value?: number; stat?: "mean" | "median"; label?: string };
  /** Draw the numeric value on each mark (best for bar/point with few categories). */
  dataLabels?: boolean;
  /** Hint for how to format the value axis; auto-detected from the column name when omitted. */
  yFormat?: "number" | "currency" | "percent";
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
