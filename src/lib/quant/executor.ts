import { loadCsvAsObjects } from "./loadCsv";
import { QUANT_ENUMS_BY_DATASET } from "./catalog";
import { validateQuantPlan } from "./validatePlan";
import type {
  QuantChartConfig,
  QuantComputeExpr,
  QuantFilterScalar,
  QuantOp,
  QuantPlan,
  QuantResult,
} from "./types";

const AGG_EXPR_RE = /^\s*(sum|avg|mean|count|count_distinct|min|max)\s*\(/i;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Equal by loose semantics — matches the existing `==` behaviour while tolerating number/string confusion. */
function eqLoose(a: unknown, b: unknown): boolean {
  // eslint-disable-next-line eqeqeq
  return a == b;
}

/**
 * Case-insensitive enum coercion: if the filter column is a known enum on `datasetId`
 * and the user value matches one of its literals case-insensitively, rewrite it to
 * the canonical casing (prevents silent "0 rows" on `"Lost"` vs `"lost"`).
 */
function coerceEnumFilterValue(
  value: QuantFilterScalar,
  column: string,
  datasetId: string,
): QuantFilterScalar {
  if (typeof value !== "string") return value;
  const enums = QUANT_ENUMS_BY_DATASET[datasetId];
  const allowed = enums?.[column];
  if (!allowed || allowed.length === 0) return value;
  const canonical = allowed.find(
    (v) => v.toLocaleLowerCase() === value.toLocaleLowerCase(),
  );
  return canonical ?? value;
}

function applyFilter(
  rows: Record<string, unknown>[],
  s: Extract<QuantOp, { op: "filter" }>,
  datasetId: string,
): Record<string, unknown>[] {
  const col = s.column;
  const coerceScalar = (t: QuantFilterScalar | undefined) =>
    t == null ? t : coerceEnumFilterValue(t, col, datasetId);
  const target = s.value != null ? coerceScalar(s.value) : undefined;
  const targets = Array.isArray(s.values)
    ? s.values.map((v) => coerceScalar(v))
    : undefined;

  return rows.filter((r) => {
    const v = r[col];
    switch (s.cmp) {
      case "eq":
        return eqLoose(v, target);
      case "neq":
        return !eqLoose(v, target);
      case "gt":
        return num(v) > num(target);
      case "gte":
        return num(v) >= num(target);
      case "lt":
        return num(v) < num(target);
      case "lte":
        return num(v) <= num(target);
      case "in":
        return Array.isArray(targets) && targets.some((t) => eqLoose(v, t));
      case "not_in":
        return Array.isArray(targets) && !targets.some((t) => eqLoose(v, t));
      default:
        return true;
    }
  });
}

function aggregateMeasure(
  agg: Extract<QuantOp, { op: "groupby" }>["measures"][number]["agg"],
  values: unknown[],
  groupRowCount: number,
): unknown {
  switch (agg) {
    case "count":
      return groupRowCount;
    case "count_distinct": {
      const seen = new Set<unknown>();
      for (const v of values) {
        if (v == null || v === "") continue;
        seen.add(v);
      }
      return seen.size;
    }
    case "sum": {
      let s = 0;
      let any = false;
      for (const v of values) {
        const n = Number(v);
        if (Number.isFinite(n)) {
          s += n;
          any = true;
        }
      }
      return any ? s : 0;
    }
    case "mean": {
      let s = 0;
      let c = 0;
      for (const v of values) {
        const n = Number(v);
        if (Number.isFinite(n)) {
          s += n;
          c += 1;
        }
      }
      return c > 0 ? s / c : null;
    }
    case "min": {
      let best: number | null = null;
      for (const v of values) {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        if (best === null || n < best) best = n;
      }
      return best;
    }
    case "max": {
      let best: number | null = null;
      for (const v of values) {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        if (best === null || n > best) best = n;
      }
      return best;
    }
    default:
      return groupRowCount;
  }
}

function applyGroupby(
  rows: Record<string, unknown>[],
  s: Extract<QuantOp, { op: "groupby" }>,
): Record<string, unknown>[] {
  if (!rows.length) return [];
  const buckets = new Map<
    string,
    { keyRow: Record<string, unknown>; values: Map<string, unknown[]>; count: number }
  >();
  for (const r of rows) {
    const key = compositeKey(r, s.by);
    let bucket = buckets.get(key);
    if (!bucket) {
      const keyRow: Record<string, unknown> = {};
      for (const k of s.by) keyRow[k] = r[k];
      bucket = { keyRow, values: new Map(), count: 0 };
      for (const m of s.measures) {
        if (!bucket.values.has(m.column)) bucket.values.set(m.column, []);
      }
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    for (const m of s.measures) {
      bucket.values.get(m.column)!.push(r[m.column]);
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const bucket of buckets.values()) {
    const row: Record<string, unknown> = { ...bucket.keyRow };
    for (const m of s.measures) {
      row[m.alias] = aggregateMeasure(
        m.agg,
        bucket.values.get(m.column) ?? [],
        bucket.count,
      );
    }
    out.push(row);
  }
  return out;
}

function evalComputeExpr(
  row: Record<string, unknown>,
  expr: QuantComputeExpr,
): unknown {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "equals":
      return eqLoose(row[expr.column], expr.value) ? 1 : 0;
    case "not_equals":
      return eqLoose(row[expr.column], expr.value) ? 0 : 1;
    case "in":
      return Array.isArray(expr.values) &&
        expr.values.some((v) => eqLoose(row[expr.column], v))
        ? 1
        : 0;
    case "divide": {
      const n = num(row[expr.numerator]);
      const d = num(row[expr.denominator]);
      if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
      return n / d;
    }
    case "coalesce": {
      for (const c of expr.columns) {
        const v = row[c];
        if (v != null && v !== "") return v;
      }
      return expr.fallback ?? null;
    }
    case "bucket": {
      const n = num(row[expr.column]);
      if (!Number.isFinite(n)) return expr.labels[expr.labels.length - 1] ?? null;
      for (let i = 0; i < expr.breaks.length; i++) {
        if (n <= expr.breaks[i]!) return expr.labels[i] ?? null;
      }
      return expr.labels[expr.labels.length - 1] ?? null;
    }
    default: {
      const never: never = expr;
      return never;
    }
  }
}

function collectComputeInputColumns(
  cols: Array<{ alias: string; expr: QuantComputeExpr }>,
): string[] {
  const need = new Set<string>();
  for (const c of cols) {
    const e = c.expr;
    switch (e.kind) {
      case "equals":
      case "not_equals":
      case "in":
        need.add(e.column);
        break;
      case "divide":
        need.add(e.numerator);
        need.add(e.denominator);
        break;
      case "coalesce":
        for (const x of e.columns) need.add(x);
        break;
      case "bucket":
        need.add(e.column);
        break;
      case "literal":
      default:
        break;
    }
  }
  return [...need];
}

function applyCompute(
  rows: Record<string, unknown>[],
  step: Extract<QuantOp, { op: "compute" }>,
  stepIdx: number,
): Record<string, unknown>[] {
  if (!rows.length) return [];
  if (!Array.isArray(step.columns) || step.columns.length === 0) return rows;
  const inputs = collectComputeInputColumns(step.columns);
  // divide / coalesce / bucket may reference aggregate aliases that exist on the first row; others must exist upstream.
  const haveCols = new Set(Object.keys(rows[0]!));
  const missing = inputs.filter((c) => !haveCols.has(c));
  if (missing.length > 0) {
    throw new Error(
      `Step ${stepIdx} compute: input column(s) ${missing.map((m) => `"${m}"`).join(", ")} not in data. Available: ${[...haveCols].join(", ")}`,
    );
  }
  return rows.map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const { alias, expr } of step.columns) {
      out[alias] = evalComputeExpr(r, expr);
    }
    return out;
  });
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
    if (typeof c !== "string" || !c.trim()) {
      throw new Error(
        `${ctx}: column name must be a non-empty string (got ${JSON.stringify(c)}). Check JSON for missing "column", "x", or "y".`,
      );
    }
    if (!have.has(c)) {
      throw new Error(`${ctx}: column "${c}" not in data. Available: ${[...have].join(", ")}`);
    }
  }
}

/** Column names referenced after `projectIndex` (exclusive): needed so project does not drop them. */
function collectFutureReferencedColumns(
  allSteps: QuantOp[],
  projectStepIndex: number,
  chart: QuantPlan["chart"],
): string[] {
  const need = new Set<string>();
  for (let j = projectStepIndex + 1; j < allSteps.length; j++) {
    const st = allSteps[j]!;
    if (st.op === "filter") need.add(st.column);
    else if (st.op === "groupby") {
      for (const b of st.by) need.add(b);
      for (const m of st.measures) {
        if (m.agg !== "count") need.add(m.column);
      }
    } else if (st.op === "sort") need.add(st.by);
    else if (st.op === "join") {
      for (const [l] of st.on) need.add(l);
    } else if (st.op === "project") {
      for (const c of st.columns) need.add(c);
    } else if (st.op === "compute") {
      for (const c of collectComputeInputColumns(st.columns)) need.add(c);
    }
  }
  if (chart && typeof chart === "object") {
    if (typeof chart.x === "string" && chart.x.trim()) need.add(chart.x.trim());
    if (typeof chart.y === "string" && chart.y.trim()) need.add(chart.y.trim());
  }
  return [...need];
}

function compositeKey(row: Record<string, unknown>, cols: string[]): string {
  return cols.map((c) => String(row[c] ?? "")).join("\u0001");
}

function applyJoin(
  leftRows: Record<string, unknown>[],
  step: Extract<QuantOp, { op: "join" }>,
  stepIdx: number,
): Record<string, unknown>[] {
  if (!step.on?.length) {
    throw new Error(
      `Step ${stepIdx} join: "on" must be a non-empty array of [leftCol, rightCol] pairs`,
    );
  }
  const rightRows = loadCsvAsObjects(step.rightDatasetId);
  const how = step.how ?? "left";
  const prefix = step.rightPrefix ?? "r_";

  const leftKeyCols = step.on.map(([l]) => l);
  const rightKeyCols = step.on.map(([, r]) => r);

  if (!leftRows.length) {
    return how === "inner" ? [] : [];
  }
  validateColumns(leftRows, leftKeyCols, `Step ${stepIdx} join (left)`);
  if (!rightRows.length) {
    if (how === "inner") return [];
    return leftRows.map((r) => ({ ...r }));
  }
  validateColumns(rightRows, rightKeyCols, `Step ${stepIdx} join (right)`);

  const rightColNames = new Set<string>();
  for (const r of rightRows) {
    for (const col of Object.keys(r)) rightColNames.add(col);
  }

  const index = new Map<string, Record<string, unknown>[]>();
  for (const r of rightRows) {
    const k = compositeKey(r, rightKeyCols);
    if (!index.has(k)) index.set(k, []);
    index.get(k)!.push(r);
  }

  const stripDuplicateJoinKeys = (
    merged: Record<string, unknown>,
  ): Record<string, unknown> => {
    for (const [lc, rc] of step.on) {
      if (lc === rc) {
        delete merged[`${prefix}${rc}`];
      }
    }
    return merged;
  };

  const out: Record<string, unknown>[] = [];
  for (const l of leftRows) {
    const k = compositeKey(l, leftKeyCols);
    const matches = index.get(k) ?? [];
    if (matches.length === 0) {
      if (how === "left") {
        // Keep a stable schema: SQL-style LEFT JOIN still exposes right columns as NULL.
        const merged: Record<string, unknown> = { ...l };
        for (const col of rightColNames) {
          merged[`${prefix}${col}`] = null;
        }
        out.push(stripDuplicateJoinKeys(merged));
      }
      continue;
    }
    for (const r of matches) {
      const merged: Record<string, unknown> = { ...l };
      for (const [col, val] of Object.entries(r)) {
        merged[`${prefix}${col}`] = val;
      }
      out.push(stripDuplicateJoinKeys(merged));
    }
  }
  return out;
}

function applyProject(
  rows: Record<string, unknown>[],
  step: Extract<QuantOp, { op: "project" }>,
  stepIdx: number,
  allSteps: QuantOp[],
  stepIndex: number,
  chart: QuantPlan["chart"],
): Record<string, unknown>[] {
  if (!rows.length) return [];
  const have = new Set(Object.keys(rows[0]!));
  const future = collectFutureReferencedColumns(allSteps, stepIndex, chart);
  const merged: string[] = [...step.columns];
  for (const c of future) {
    if (have.has(c) && !merged.includes(c)) merged.push(c);
  }
  validateColumns(rows, merged, `Step ${stepIdx} project`);
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const c of merged) {
      o[c] = r[c];
    }
    return o;
  });
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
  const datasetIdsUsed = new Set<string>([plan.datasetId]);
  const safe: QuantResult = {
    hypothesis_under_test: plan.hypothesis_under_test,
    datasetId: plan.datasetId,
    datasetIdsUsed: [plan.datasetId],
    tables: [],
    vegaLiteSpecs: [],
    executedAt,
  };

  try {
    // Deterministic pre-execution check: catches chart wiring bugs and
    // column-referenced-before-produced errors in a single pass, so we fail
    // fast with an actionable message instead of running a 2000-row pipeline
    // and then silently skipping the chart.
    const validation = validateQuantPlan(plan);
    if (!validation.ok) {
      safe.error = `Plan validation failed: ${validation.errors.join(" | ")}`;
      safe.narrative = safe.error;
      return safe;
    }

    let rows = loadCsvAsObjects(plan.datasetId);
    if (!rows.length) {
      safe.narrative = "Dataset is empty — add rows to the CSV under data/dummy_data or pick another datasetId.";
      safe.tables.push({ name: "result", columns: [], rows: [] });
      return safe;
    }

    let stepIdx = 0;
    for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex++) {
      const step = plan.steps[stepIndex]!;
      stepIdx += 1;
      if (step.op === "filter") {
        validateColumns(rows, [step.column], `Step ${stepIdx} filter`);
        rows = applyFilter(rows, step, plan.datasetId);
      } else if (step.op === "groupby") {
        const cols = [
          ...step.by,
          // `count` ignores its `column`; every other agg reads values from it.
          ...step.measures.filter((m) => m.agg !== "count").map((m) => m.column),
        ];
        validateColumns(rows, cols, `Step ${stepIdx} groupby`);
        rows = applyGroupby(rows, step);
      } else if (step.op === "sort") {
        validateColumns(rows, [step.by], `Step ${stepIdx} sort`);
        rows = applySort(rows, step);
      } else if (step.op === "limit") {
        rows = rows.slice(0, Math.max(0, Math.min(step.n, 10_000)));
      } else if (step.op === "join") {
        if (typeof step.rightDatasetId === "string" && step.rightDatasetId.trim()) {
          datasetIdsUsed.add(step.rightDatasetId);
        }
        rows = applyJoin(rows, step, stepIdx);
      } else if (step.op === "project") {
        rows = applyProject(rows, step, stepIdx, plan.steps, stepIndex, plan.chart);
      } else if (step.op === "compute") {
        rows = applyCompute(rows, step, stepIdx);
      }
    }

    safe.datasetIdsUsed = [...datasetIdsUsed];

    const cols = Object.keys(rows[0] ?? {});
    safe.tables.push({ name: "result", columns: cols, rows });

    const chartNotes: string[] = [];
    if (plan.chart && rows.length) {
      const cx = plan.chart.x;
      const cy = plan.chart.y;
      const cxOk = typeof cx === "string" && cx.trim().length > 0;
      const cyOk = typeof cy === "string" && cy.trim().length > 0;
      if (!cxOk || !cyOk) {
        chartNotes.push(
          `Chart skipped — "x" and "y" must be non-empty column names on the result rows (got x=${JSON.stringify(cx)}, y=${JSON.stringify(cy)}).`,
        );
      } else {
        const available = new Set(Object.keys(rows[0]!));
        const missing = [cx, cy].filter((c) => !available.has(c as string));
        if (missing.length > 0) {
          const aggHints = missing
            .filter((m) => AGG_EXPR_RE.test(m as string))
            .map(
              (m) =>
                ` "${m}" looks like an aggregate expression — planner bug: a groupby measure should be aliased to exactly "${m}".`,
            )
            .join("");
          chartNotes.push(
            `Chart skipped — column(s) ${missing.map((m) => `"${m}"`).join(", ")} not in result rows.${aggHints} Available: ${[...available].join(", ")}.`,
          );
        } else {
          const spec = buildVegaLiteSpec(plan.chart, rows);
          safe.vegaLiteSpecs.push({
            title: plan.chart.title ?? `${plan.chart.y} by ${plan.chart.x}`,
            spec,
          });
        }
      }
    }

    const multi = datasetIdsUsed.size > 1;
    let narrative: string;
    if (rows.length === 1 && cols.length <= 6) {
      narrative = cols.map((c) => `${c}: ${rows[0]![c]}`).join("; ");
    } else {
      narrative = `${rows.length} row(s) after pipeline${multi ? ` (${[...datasetIdsUsed].join(" + ")})` : ""}.`;
    }
    if (chartNotes.length > 0) {
      narrative = [narrative, ...chartNotes].filter(Boolean).join(" ");
    }
    safe.narrative = narrative;

    return safe;
  } catch (e) {
    safe.datasetIdsUsed = [...datasetIdsUsed];
    safe.error = e instanceof Error ? e.message : String(e);
    return safe;
  }
}
