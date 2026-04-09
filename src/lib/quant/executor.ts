import * as aq from "arquero";
import { loadCsvAsObjects } from "./loadCsv";
import type { QuantChartConfig, QuantOp, QuantPlan, QuantResult } from "./types";

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function applyFilter(
  rows: Record<string, unknown>[],
  s: Extract<QuantOp, { op: "filter" }>,
): Record<string, unknown>[] {
  return rows.filter((r) => {
    const v = r[s.column];
    const t = s.value;
    switch (s.cmp) {
      case "eq":
        return v == t;
      case "neq":
        return v != t;
      case "gt":
        return num(v) > num(t);
      case "gte":
        return num(v) >= num(t);
      case "lt":
        return num(v) < num(t);
      case "lte":
        return num(v) <= num(t);
      default:
        return true;
    }
  });
}

function applyGroupby(
  rows: Record<string, unknown>[],
  s: Extract<QuantOp, { op: "groupby" }>,
): Record<string, unknown>[] {
  if (!rows.length) return [];
  const tb = aq.from(rows);
  const rollup: Record<string, unknown> = {};
  for (const m of s.measures) {
    switch (m.agg) {
      case "sum":
        rollup[m.alias] = aq.op.sum(m.column);
        break;
      case "mean":
        rollup[m.alias] = aq.op.mean(m.column);
        break;
      case "count":
        rollup[m.alias] = aq.op.count();
        break;
      case "min":
        rollup[m.alias] = aq.op.min(m.column);
        break;
      case "max":
        rollup[m.alias] = aq.op.max(m.column);
        break;
      default:
        rollup[m.alias] = aq.op.count();
    }
  }
  // Arquero's rollup typing is narrower than runtime (aq.op.* expr objects).
  const out = tb.groupby(...s.by).rollup(rollup as Parameters<ReturnType<typeof aq.from>["rollup"]>[0]);
  return out.objects() as Record<string, unknown>[];
}

function applySort(
  rows: Record<string, unknown>[],
  s: Extract<QuantOp, { op: "sort" }>,
): Record<string, unknown>[] {
  const dir = s.dir === "desc" ? -1 : 1;
  const col = s.by;
  return [...rows].sort((a, b) => {
    const va = a[col];
    const vb = b[col];
    if (va == vb) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") {
      return va < vb ? -1 * dir : 1 * dir;
    }
    return String(va).localeCompare(String(vb)) * dir;
  });
}

function validateColumns(rows: Record<string, unknown>[], cols: string[], ctx: string) {
  if (!rows.length) return;
  const have = new Set(Object.keys(rows[0]!));
  for (const c of cols) {
    if (!have.has(c)) {
      throw new Error(`${ctx}: column "${c}" not in data. Available: ${[...have].join(", ")}`);
    }
  }
}

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

function buildVegaLiteSpec(
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
    mark: chart.type === "line" ? { type: "line", point: true } : { type: "bar", tooltip: true },
    encoding: {
      x: { field: chart.x, type: xType === "temporal" ? "temporal" : xType, title: chart.x },
      y: { field: chart.y, type: yType === "quantitative" ? "quantitative" : "nominal", title: chart.y },
    },
  };
}

export function executeQuantPlan(plan: QuantPlan): QuantResult {
  const executedAt = new Date().toISOString();
  const safe: QuantResult = {
    hypothesis_under_test: plan.hypothesis_under_test,
    datasetId: plan.datasetId,
    tables: [],
    vegaLiteSpecs: [],
    executedAt,
  };

  try {
    let rows = loadCsvAsObjects(plan.datasetId);
    if (!rows.length) {
      safe.narrative = "Dataset is empty — add rows to the CSV under data/dummy or pick another datasetId.";
      safe.tables.push({ name: "result", columns: [], rows: [] });
      return safe;
    }

    let stepIdx = 0;
    for (const step of plan.steps) {
      stepIdx += 1;
      if (step.op === "filter") {
        validateColumns(rows, [step.column], `Step ${stepIdx} filter`);
        rows = applyFilter(rows, step);
      } else if (step.op === "groupby") {
        const cols = [...step.by, ...step.measures.map((m) => m.column)];
        validateColumns(rows, cols, `Step ${stepIdx} groupby`);
        rows = applyGroupby(rows, step);
      } else if (step.op === "sort") {
        validateColumns(rows, [step.by], `Step ${stepIdx} sort`);
        rows = applySort(rows, step);
      } else if (step.op === "limit") {
        rows = rows.slice(0, Math.max(0, Math.min(step.n, 10_000)));
      }
    }

    const cols = Object.keys(rows[0] ?? {});
    safe.tables.push({ name: "result", columns: cols, rows });

    if (plan.chart && rows.length) {
      validateColumns(rows, [plan.chart.x, plan.chart.y], "Chart");
      const spec = buildVegaLiteSpec(plan.chart, rows);
      safe.vegaLiteSpecs.push({
        title: plan.chart.title ?? `${plan.chart.y} by ${plan.chart.x}`,
        spec,
      });
    }

    if (rows.length === 1 && cols.length <= 6) {
      safe.narrative = cols.map((c) => `${c}: ${rows[0]![c]}`).join("; ");
    } else {
      safe.narrative = `${rows.length} row(s) after pipeline.`;
    }

    return safe;
  } catch (e) {
    safe.error = e instanceof Error ? e.message : String(e);
    return safe;
  }
}
