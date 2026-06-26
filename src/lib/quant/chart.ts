import type { QuantChartConfig } from "./types";

/** Max distinct categories to show on a categorical bar chart before we cap to the top-N by value. */
const MAX_BAR_CATEGORIES = 40;

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

function isDateLike(s: string): boolean {
  // YYYY-MM, YYYY-MM-DD, or ISO timestamps.
  return /^\d{4}-\d{2}(-\d{2})?([ T]\d{2}:\d{2})?/.test(s);
}

/** Parse a value that may be a number or numeric string ("1,234", "$1.2K"→ only plain numerics). */
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

export function buildVegaLiteSpec(
  chart: QuantChartConfig,
  rows: Record<string, unknown>[],
): Record<string, unknown> {
  const xType = inferVegaType(rows, chart.x);
  const yType = inferVegaType(rows, chart.y);
  // The value field is whichever axis is meant to be quantitative (y for most charts).
  const valueIsY = yType === "quantitative" || xType !== "quantitative";
  const valueField = valueIsY ? chart.y : chart.x;
  const catField = valueIsY ? chart.x : chart.y;
  const catType: VegaType = valueIsY ? xType : yType;

  const valueFormat = chart.yFormat ?? inferValueFormat(valueField);
  const series =
    chart.series && chart.series !== chart.x && chart.series !== chart.y
      ? chart.series
      : undefined;

  // Coerce numeric strings on the quantitative field(s).
  const numericFields = [valueField];
  if (xType === "quantitative" && chart.x !== valueField) numericFields.push(chart.x);
  if (yType === "quantitative" && chart.y !== valueField) numericFields.push(chart.y);
  let data = coerceRows(rows, numericFields);

  const isBar = chart.type === "bar";
  const horizontal = isBar && Boolean(chart.horizontal);

  // Cap noisy categorical bar charts to the top-N categories by value.
  if (isBar && catType === "nominal" && !series) {
    const distinct = new Set(data.map((r) => r[catField])).size;
    if (distinct > MAX_BAR_CATEGORIES) {
      data = [...data]
        .sort((a, b) => (toNumber(b[valueField]) ?? 0) - (toNumber(a[valueField]) ?? 0))
        .slice(0, MAX_BAR_CATEGORIES);
    }
  }

  const valueEnc: Record<string, unknown> = {
    field: valueField,
    type: "quantitative",
    title: prettify(valueField),
    axis: { format: formatStringFor(valueFormat) },
  };
  if (series) valueEnc.stack = chart.stacked ? "zero" : null;

  const catEnc: Record<string, unknown> = {
    field: catField,
    type: catType,
    title: prettify(catField),
  };
  // Sort categorical bars by value; rotate long vertical labels.
  if (isBar && catType === "nominal" && !series) {
    catEnc.sort = horizontal ? "-x" : "-y";
  }
  if (!horizontal && catType === "nominal") {
    catEnc.axis = { labelAngle: -35, labelLimit: 140 };
  }

  const mark = buildMark(chart, Boolean(chart.stacked));

  const encoding: Record<string, unknown> = {};
  if (horizontal) {
    encoding.y = catEnc;
    encoding.x = valueEnc;
  } else if (!valueIsY) {
    // Quantitative-x chart (e.g. scatter): keep x quantitative.
    encoding.x = valueEnc;
    encoding.y = { field: chart.y, type: yType, title: prettify(chart.y) };
  } else {
    encoding.x = catEnc;
    encoding.y = valueEnc;
  }

  if (series) {
    encoding.color = {
      field: series,
      type: inferVegaType(rows, series),
      title: prettify(series),
    };
    // Grouped (non-stacked) bars need an offset channel.
    if (isBar && !chart.stacked) {
      encoding[horizontal ? "yOffset" : "xOffset"] = { field: series };
    }
  }

  // Grow height for horizontal bars so categories don't cram.
  const catCount = new Set(data.map((r) => r[catField])).size;
  const height = horizontal ? Math.min(60 + catCount * 22, 600) : 260;

  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: chart.title ?? undefined,
    width: "container",
    height,
    autosize: { type: "fit-x", contains: "padding" },
    data: { values: data },
    mark,
    encoding,
    config: THEME_CONFIG,
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
