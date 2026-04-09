/** Declarative ops executed in-process (Arquero). Column names validated against loaded data. */

export type QuantFilterCmp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

export type QuantMeasureAgg = "sum" | "mean" | "count" | "min" | "max";

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
  | { op: "limit"; n: number };

export type QuantChartConfig = {
  type: "bar" | "line";
  x: string;
  y: string;
  title?: string;
};

export type QuantPlan = {
  hypothesis_under_test: string;
  /** Key from data catalog, e.g. "crm/opportunities" */
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
  tables: QuantTable[];
  /** Vega-Lite v5 specs (render client-side) */
  vegaLiteSpecs: Array<{ title: string; spec: Record<string, unknown> }>;
  /** Short numeric takeaway for the narrative */
  narrative?: string;
  error?: string;
  executedAt: string;
};
