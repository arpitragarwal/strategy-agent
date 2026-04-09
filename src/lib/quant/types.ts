/** Declarative ops executed in-process (Arquero for aggregates; joins in executor). Column names validated against loaded data. */

export type QuantFilterCmp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

export type QuantMeasureAgg = "sum" | "mean" | "count" | "min" | "max";

/** One or more column pairs; all must match (AND), like SQL ON a=b AND c=d. */
export type QuantJoinOn = [leftColumn: string, rightColumn: string];

export type QuantOp =
  | {
      op: "filter";
      column: string;
      cmp: QuantFilterCmp;
      value: string | number | boolean;
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
    };

export type QuantChartConfig = {
  type: "bar" | "line";
  x: string;
  y: string;
  title?: string;
};

export type QuantPlan = {
  hypothesis_under_test: string;
  /** Primary (left) table from the catalog, e.g. "crm/opportunities". Use join steps to add others. */
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
