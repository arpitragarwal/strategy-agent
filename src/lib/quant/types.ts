/** Declarative ops executed in-process (Arquero for aggregates; joins in executor). Column names validated against loaded data. */

export type QuantFilterCmp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in";

export type QuantMeasureAgg =
  | "sum"
  | "mean"
  | "count"
  | "count_distinct"
  | "min"
  | "max";

/** One or more column pairs; all must match (AND), like SQL ON a=b AND c=d. */
export type QuantJoinOn = [leftColumn: string, rightColumn: string];

export type QuantFilterScalar = string | number | boolean;

/** Expression kinds supported by the `compute` op — add derived columns without removing any. */
export type QuantComputeExpr =
  | { kind: "equals"; column: string; value: QuantFilterScalar }
  | { kind: "not_equals"; column: string; value: QuantFilterScalar }
  | { kind: "in"; column: string; values: QuantFilterScalar[] }
  | { kind: "divide"; numerator: string; denominator: string }
  | { kind: "coalesce"; columns: string[]; fallback?: QuantFilterScalar | null }
  | { kind: "bucket"; column: string; breaks: number[]; labels: string[] }
  | { kind: "literal"; value: QuantFilterScalar };

export type QuantOp =
  | {
      op: "filter";
      column: string;
      cmp: QuantFilterCmp;
      /** Used by eq / neq / gt / gte / lt / lte. */
      value?: QuantFilterScalar;
      /** Used by in / not_in. */
      values?: QuantFilterScalar[];
    }
  | {
      op: "groupby";
      by: string[];
      measures: Array<{ alias: string; column: string; agg: QuantMeasureAgg }>;
    }
  | { op: "sort"; by: string; dir?: "asc" | "desc" }
  | { op: "limit"; n: number }
  | {
      /** Load another CSV and merge rows by key equality. Right-side columns appear with `rightPrefix` (default r_). */
      op: "join";
      rightDatasetId: string;
      on: QuantJoinOn[];
      how?: "inner" | "left";
      rightPrefix?: string;
    }
  | {
      /** Keep only these columns (after joins, use prefixed names like r_arr_usd). */
      op: "project";
      columns: string[];
    }
  | {
      /** Add derived columns (does not drop existing ones). Use before groupby to count matches, or after groupby to compute ratios. */
      op: "compute";
      columns: Array<{ alias: string; expr: QuantComputeExpr }>;
    };

export type QuantChartConfig = {
  type: "bar" | "line";
  x: string;
  y: string;
  title?: string;
};

export type QuantPlan = {
  hypothesis_under_test: string;
  /** Primary (left) table from the catalog, e.g. "crm/deal_data". Use join steps to add others. */
  datasetId: string;
  steps: QuantOp[];
  /** If omitted or null, only tables are returned */
  chart?: QuantChartConfig | null;
};

export type QuantTable = {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
};

export type QuantResult = {
  hypothesis_under_test: string;
  datasetId?: string;
  /** datasetId plus any tables loaded via join steps (order of first use). */
  datasetIdsUsed?: string[];
  tables: QuantTable[];
  /** Vega-Lite v5 specs (render client-side) */
  vegaLiteSpecs: Array<{ title: string; spec: Record<string, unknown> }>;
  /** Short numeric takeaway for the narrative */
  narrative?: string;
  error?: string;
  executedAt: string;
};
