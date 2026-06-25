import type { QuantChartConfig } from "./types";

function inferVegaType(
  rows: Record<string, unknown>[],
  field: string,
): "quantitative" | "nominal" | "temporal" {
  const v = rows.find((r) => r[field] != null && r[field] !== "")?.[field];
  if (typeof v === "number" && Number.isFinite(v as number)) return "quantitative";
  if (v instanceof Date) return "temporal";
  const s = String(v ?? "");
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return "temporal";
  return "nominal";
}

export function buildVegaLiteSpec(
  chart: QuantChartConfig,
  rows: Record<string, unknown>[],
): Record<string, unknown> {
  const xType = inferVegaType(rows, chart.x);
  const yType = inferVegaType(rows, chart.y);
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: chart.title ?? undefined,
    width: "container",
    height: 240,
    data: { values: rows },
    mark:
      chart.type === "line"
        ? { type: "line", point: true }
        : { type: "bar", tooltip: true },
    encoding: {
      x: {
        field: chart.x,
        type: xType === "temporal" ? "temporal" : xType,
        title: chart.x,
      },
      y: {
        field: chart.y,
        type: yType === "quantitative" ? "quantitative" : "nominal",
        title: chart.y,
      },
    },
  };
}
