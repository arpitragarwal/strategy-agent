import type { QuantChartConfig } from "./types";

/** Max distinct categories to show on a categorical bar chart before we cap to the top-N by value. */
const MAX_BAR_CATEGORIES = 40;
/** Show value labels on marks only when categories stay readable. */
const MAX_DATA_LABEL_CATEGORIES = 12;

/** Brand-aligned categorical palette (emerald lead, matching the app accent). */
const PALETTE = [
  "#10b981",
  "#6366f1",
  "#f59e0b",
  "#ef4444",
  "#0ea5e9",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#64748b",
];

const FONT =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Shared Vega-Lite config so every chart picks up the app's typography and a clean, low-chartjunk look. */
const THEME_CONFIG = {
  font: FONT,
  background: "transparent",
  view: { stroke: "transparent" },
  axis: {
    labelColor: "#52525b",
    titleColor: "#3f3f46",
    labelFontSize: 11,
    titleFontSize: 12,
    titleFontWeight: 600,
    titlePadding: 8,
    gridColor: "#e4e4e7",
    gridOpacity: 0.7,
    domainColor: "#d4d4d8",
    tickColor: "#d4d4d8",
    labelOverlap: true,
  },
  legend: {
    labelColor: "#52525b",
    titleColor: "#3f3f46",
    labelFontSize: 11,
    titleFontSize: 12,
    titleFontWeight: 600,
    symbolType: "circle",
  },
  title: {
    color: "#18181b",
    fontSize: 13,
    fontWeight: 600,
    anchor: "start",
    dy: -4,
  },
  range: { category: PALETTE },
  bar: { color: PALETTE[0], cornerRadiusEnd: 2 },
  line: { color: PALETTE[0], strokeWidth: 2 },
  point: { color: PALETTE[0], filled: true, size: 60 },
  area: { color: PALETTE[0], line: true },
};

type VegaType = "quantitative" | "nominal" | "temporal";
type Channel = "x" | "y";

function isDateLike(s: string): boolean {
  // YYYY-MM, YYYY-MM-DD, or ISO timestamps.
  return /^\d{4}-\d{2}(-\d{2})?([ T]\d{2}:\d{2})?/.test(s);
}

/** Parse a value that may be a number or numeric string ("1,234" → 1234); null when not numeric. */
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[,$\s%]/g, "");
  if (cleaned === "" || Number.isNaN(Number(cleaned))) return null;
  return Number(cleaned);
}

/** Scan all rows (not just the first) and pick the dominant type for a column. */
function inferVegaType(rows: Record<string, unknown>[], field: string): VegaType {
  let numeric = 0;
  let temporal = 0;
  let total = 0;
  for (const r of rows) {
    const v = r[field];
    if (v == null || v === "") continue;
    total += 1;
    if (typeof v === "number" && Number.isFinite(v)) {
      numeric += 1;
      continue;
    }
    if (v instanceof Date) {
      temporal += 1;
      continue;
    }
    const s = String(v);
    if (isDateLike(s)) {
      temporal += 1;
      continue;
    }
    if (toNumber(s) != null) numeric += 1;
  }
  if (total === 0) return "nominal";
  if (temporal / total > 0.6) return "temporal";
  if (numeric / total > 0.6) return "quantitative";
  return "nominal";
}

/** Turn "acv_usd" → "Acv usd"-ish readable label. */
function prettify(field: string): string {
  const spaced = field.replace(/[_]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

type ValueFormat = "number" | "currency" | "percent";

/** Guess a value-axis format from the column name when the model didn't say. */
function inferValueFormat(field: string): ValueFormat {
  const f = field.toLowerCase();
  if (/(usd|revenue|acv|arr|mrr|amount|price|cost|spend|gmv|\$)/.test(f)) return "currency";
  if (/(rate|pct|percent|ratio|share|churn|margin)/.test(f)) return "percent";
  return "number";
}

/** d3-format string for the value axis. */
function formatStringFor(fmt: ValueFormat): string {
  if (fmt === "currency") return "$.3~s"; // $1.2M
  if (fmt === "percent") return ".1%"; // assumes 0–1 fractions
  return ".3~s"; // 1.2M / 12K
}

/** Coerce numeric-string cells to numbers so quantitative encodings render. */
function coerceRows(
  rows: Record<string, unknown>[],
  numericFields: string[],
): Record<string, unknown>[] {
  if (numericFields.length === 0) return rows;
  return rows.map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const f of numericFields) {
      const n = toNumber(r[f]);
      if (n != null) out[f] = n;
    }
    return out;
  });
}

const SHELL = {
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  width: "container",
  autosize: { type: "fit-x", contains: "padding" },
  config: THEME_CONFIG,
} as const;

/** A quantitative value encoding, honoring an optional aggregate. */
function valueEncoding(
  field: string,
  fmt: ValueFormat,
  aggregate?: QuantChartConfig["aggregate"],
): Record<string, unknown> {
  const enc: Record<string, unknown> = {
    type: "quantitative",
    title: aggregate && aggregate !== "count" ? `${prettify(aggregate)} ${prettify(field)}` : prettify(field),
    axis: { format: formatStringFor(fmt) },
  };
  if (aggregate === "count") {
    enc.aggregate = "count";
    enc.title = "Count";
  } else if (aggregate) {
    enc.aggregate = aggregate;
    enc.field = field;
  } else {
    enc.field = field;
  }
  return enc;
}

/** Dashed rule (and optional label) marking a fixed value or the mean/median of the data. */
function refLineLayers(
  valueField: string,
  channel: Channel,
  refLine: NonNullable<QuantChartConfig["refLine"]>,
): Record<string, unknown>[] {
  const enc: Record<string, unknown> = {};
  if (refLine.stat) {
    enc[channel] = { aggregate: refLine.stat, field: valueField, type: "quantitative" };
  } else if (typeof refLine.value === "number") {
    enc[channel] = { datum: refLine.value };
  } else {
    return [];
  }
  const layers: Record<string, unknown>[] = [
    { mark: { type: "rule", color: "#ef4444", strokeDash: [4, 4], strokeWidth: 1.5 }, encoding: enc },
  ];
  if (refLine.label) {
    layers.push({
      mark: {
        type: "text",
        color: "#ef4444",
        align: channel === "y" ? "left" : "center",
        baseline: channel === "y" ? "bottom" : "top",
        dx: channel === "y" ? 4 : 0,
        dy: channel === "y" ? -3 : 10,
        fontSize: 10,
      },
      encoding: { ...enc, text: { value: refLine.label } },
    });
  }
  return layers;
}

/** Value labels drawn on each mark. */
function dataLabelLayer(
  valueField: string,
  channel: Channel,
  fmt: ValueFormat,
  aggregate: QuantChartConfig["aggregate"],
): Record<string, unknown> {
  const valueEnc = valueEncoding(valueField, fmt, aggregate);
  return {
    mark: {
      type: "text",
      color: "#3f3f46",
      fontSize: 10,
      dy: channel === "y" ? -8 : 0,
      dx: channel === "x" ? 10 : 0,
      align: channel === "x" ? "left" : "center",
    },
    encoding: {
      [channel]: valueEnc,
      text: { ...valueEnc, axis: undefined, format: formatStringFor(fmt) },
    },
  };
}

/** bar / line / area / point — the cartesian family with sorting, series, refline, labels. */
function buildCartesian(
  chart: QuantChartConfig,
  rows: Record<string, unknown>[],
): Record<string, unknown> {
  const xType = inferVegaType(rows, chart.x);
  const yType = inferVegaType(rows, chart.y);
  const valueIsY = yType === "quantitative" || xType !== "quantitative";
  const valueField = valueIsY ? chart.y : chart.x;
  const catField = valueIsY ? chart.x : chart.y;
  const catType: VegaType = valueIsY ? xType : yType;

  const fmt = chart.yFormat ?? inferValueFormat(valueField);
  const series =
    chart.series && chart.series !== chart.x && chart.series !== chart.y ? chart.series : undefined;

  const numericFields = [valueField];
  if (xType === "quantitative" && chart.x !== valueField) numericFields.push(chart.x);
  if (yType === "quantitative" && chart.y !== valueField) numericFields.push(chart.y);
  let data = coerceRows(rows, numericFields);

  const isBar = chart.type === "bar";
  const horizontal = isBar && Boolean(chart.horizontal);
  const valueChannel: Channel = horizontal ? "x" : valueIsY ? "y" : "x";

  // Cap noisy categorical bar charts to the top-N categories by value (only without aggregation).
  if (isBar && catType === "nominal" && !series && !chart.aggregate) {
    const distinct = new Set(data.map((r) => r[catField])).size;
    if (distinct > MAX_BAR_CATEGORIES) {
      data = [...data]
        .sort((a, b) => (toNumber(b[valueField]) ?? 0) - (toNumber(a[valueField]) ?? 0))
        .slice(0, MAX_BAR_CATEGORIES);
    }
  }

  const valueEnc = valueEncoding(valueField, fmt, chart.aggregate);
  if (series) valueEnc.stack = chart.stacked ? "zero" : null;

  const catEnc: Record<string, unknown> = {
    field: catField,
    type: catType,
    title: prettify(catField),
  };
  if (isBar && catType === "nominal" && !series) {
    catEnc.sort = chart.aggregate
      ? { field: valueField, op: chart.aggregate, order: "descending" }
      : horizontal
        ? "-x"
        : "-y";
  }
  if (!horizontal && catType === "nominal") {
    catEnc.axis = { labelAngle: -35, labelLimit: 140 };
  }

  // Shared positional + color encoding; the value sits on the mark layer(s).
  const shared: Record<string, unknown> = {};
  const catChannel: Channel = horizontal ? "y" : valueIsY ? "x" : "y";
  shared[catChannel] = catEnc;
  if (series) {
    shared.color = { field: series, type: inferVegaType(rows, series), title: prettify(series) };
    if (isBar && !chart.stacked) shared[horizontal ? "yOffset" : "xOffset"] = { field: series };
  }

  const mark = buildMark(chart, Boolean(chart.stacked));

  const catCount = new Set(data.map((r) => r[catField])).size;
  const height = horizontal ? Math.min(60 + catCount * 22, 600) : 260;

  const wantLabels =
    Boolean(chart.dataLabels) &&
    !series &&
    (chart.type === "bar" || chart.type === "point") &&
    catCount <= MAX_DATA_LABEL_CATEGORIES;
  const refLines = chart.refLine ? refLineLayers(valueField, valueChannel, chart.refLine) : [];

  // Simple (single-mark) spec when no extra layers are needed.
  if (refLines.length === 0 && !wantLabels) {
    return {
      ...SHELL,
      title: chart.title ?? undefined,
      height,
      data: { values: data },
      mark,
      encoding: { ...shared, [valueChannel]: valueEnc },
    };
  }

  const layers: Record<string, unknown>[] = [
    { mark, encoding: { [valueChannel]: valueEnc } },
    ...refLines,
  ];
  if (wantLabels) layers.push(dataLabelLayer(valueField, valueChannel, fmt, chart.aggregate));

  return {
    ...SHELL,
    title: chart.title ?? undefined,
    height,
    data: { values: data },
    encoding: shared,
    layer: layers,
  };
}

function buildMark(chart: QuantChartConfig, stacked: boolean): Record<string, unknown> {
  switch (chart.type) {
    case "line":
      return { type: "line", point: true, tooltip: true };
    case "area":
      return { type: "area", line: true, tooltip: true, opacity: stacked ? 1 : 0.7 };
    case "point":
      return { type: "point", filled: true, size: 60, tooltip: true };
    case "bar":
    default:
      return { type: "bar", tooltip: true };
  }
}

/** histogram — auto-bin a single numeric column; y is the count. */
function buildHistogram(
  chart: QuantChartConfig,
  rows: Record<string, unknown>[],
): Record<string, unknown> {
  const data = coerceRows(rows, [chart.x]);
  const series =
    chart.series && chart.series !== chart.x ? chart.series : undefined;
  const encoding: Record<string, unknown> = {
    x: { field: chart.x, bin: { maxbins: 30 }, type: "quantitative", title: prettify(chart.x) },
    y: { aggregate: "count", type: "quantitative", title: "Count" },
  };
  if (series) {
    encoding.color = { field: series, type: "nominal", title: prettify(series) };
    (encoding.y as Record<string, unknown>).stack = chart.stacked ? "zero" : null;
  }
  return {
    ...SHELL,
    title: chart.title ?? undefined,
    height: 260,
    data: { values: data },
    mark: { type: "bar", tooltip: true },
    encoding,
  };
}

/** heatmap — x and y are categories; series is the numeric column shown as cell color. */
function buildHeatmap(
  chart: QuantChartConfig,
  rows: Record<string, unknown>[],
): Record<string, unknown> {
  const valueField = chart.series ?? chart.y;
  const fmt = chart.yFormat ?? inferValueFormat(valueField);
  const data = coerceRows(rows, [valueField]);
  const color = valueEncoding(valueField, fmt, chart.aggregate);
  color.scale = { scheme: "greens" };
  color.legend = { format: formatStringFor(fmt) };
  delete color.axis;
  return {
    ...SHELL,
    title: chart.title ?? undefined,
    height: 280,
    data: { values: data },
    mark: { type: "rect", tooltip: true },
    encoding: {
      x: { field: chart.x, type: "nominal", title: prettify(chart.x) },
      y: { field: chart.y, type: "nominal", title: prettify(chart.y) },
      color,
    },
  };
}

/** combo — bars (y, left axis) plus a line for a second metric (series, right axis). */
function buildCombo(
  chart: QuantChartConfig,
  rows: Record<string, unknown>[],
): Record<string, unknown> {
  const xType = inferVegaType(rows, chart.x);
  const barField = chart.y;
  const lineField = chart.series ?? chart.y;
  const barFmt = inferValueFormat(barField);
  const lineFmt = inferValueFormat(lineField);
  const data = coerceRows(rows, [barField, lineField]);
  const x = { field: chart.x, type: xType, title: prettify(chart.x) };
  return {
    ...SHELL,
    title: chart.title ?? undefined,
    height: 280,
    data: { values: data },
    encoding: { x },
    layer: [
      {
        mark: { type: "bar", tooltip: true, color: PALETTE[0] },
        encoding: { y: valueEncoding(barField, barFmt) },
      },
      {
        mark: { type: "line", point: true, tooltip: true, color: PALETTE[1] },
        encoding: {
          y: { ...valueEncoding(lineField, lineFmt), axis: { format: formatStringFor(lineFmt), titleColor: PALETTE[1] } },
        },
      },
    ],
    resolve: { scale: { y: "independent" } },
  };
}

/** boxplot — distribution of a numeric column across categories. */
function buildBoxplot(
  chart: QuantChartConfig,
  rows: Record<string, unknown>[],
): Record<string, unknown> {
  const fmt = chart.yFormat ?? inferValueFormat(chart.y);
  const data = coerceRows(rows, [chart.y]);
  const encoding: Record<string, unknown> = {
    x: { field: chart.x, type: "nominal", title: prettify(chart.x), axis: { labelAngle: -35, labelLimit: 140 } },
    y: { field: chart.y, type: "quantitative", title: prettify(chart.y), axis: { format: formatStringFor(fmt) } },
  };
  if (chart.series && chart.series !== chart.x && chart.series !== chart.y) {
    encoding.color = { field: chart.series, type: "nominal", title: prettify(chart.series) };
  }
  return {
    ...SHELL,
    title: chart.title ?? undefined,
    height: 280,
    data: { values: data },
    mark: { type: "boxplot", extent: "min-max" },
    encoding,
  };
}

export function buildVegaLiteSpec(
  chart: QuantChartConfig,
  rows: Record<string, unknown>[],
): Record<string, unknown> {
  switch (chart.type) {
    case "histogram":
      return buildHistogram(chart, rows);
    case "heatmap":
      return buildHeatmap(chart, rows);
    case "combo":
      return buildCombo(chart, rows);
    case "boxplot":
      return buildBoxplot(chart, rows);
    default:
      return buildCartesian(chart, rows);
  }
}

/** Recursively collect the `field` names referenced by an encoding/layer tree. */
function collectFields(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) collectFields(n, out);
    return;
  }
  const o = node as Record<string, unknown>;
  if (typeof o.field === "string") out.add(o.field);
  for (const v of Object.values(o)) collectFields(v, out);
}

/**
 * Lightweight structural check that drops obviously-broken specs before they
 * reach the client (we build the specs ourselves, so a full Vega-Lite compile —
 * which drags the vega runtime into the server bundle — is unnecessary).
 *
 * Verifies the spec has data rows, a mark or layer, and that every referenced
 * field actually exists in the data.
 */
export function isRenderableSpec(spec: Record<string, unknown>): boolean {
  const data = spec.data as { values?: unknown } | undefined;
  const values = data?.values;
  if (!Array.isArray(values) || values.length === 0) return false;
  if (!spec.mark && !Array.isArray(spec.layer)) return false;

  const present = new Set<string>();
  for (const row of values.slice(0, 50)) {
    if (row && typeof row === "object") {
      for (const k of Object.keys(row as Record<string, unknown>)) present.add(k);
    }
  }
  const referenced = new Set<string>();
  collectFields(spec.encoding, referenced);
  collectFields(spec.layer, referenced);
  for (const f of referenced) {
    if (!present.has(f)) return false;
  }
  return true;
}
