import { getDatasetMeta, quantPlanReferencesValidDatasets } from "./catalog";
import { peekColumns } from "./loadCsv";
import type { QuantComputeExpr, QuantOp, QuantPlan } from "./types";

/**
 * Deterministic, pre-execution validation of a `QuantPlan`.
 *
 * Symbolically tracks the set of columns present after each step, so we can
 * tell the planner — before any data is touched — when a later step (or the
 * chart) references a column that no prior step produces. This catches the
 * common class of bug where the chart's `y` is an aggregate expression like
 * `sum(acv_usd)` but the plan never adds a `groupby` measure aliased to that
 * name.
 *
 * The executor still performs its own row-level checks; this validator is a
 * strict superset focused on chart wiring and plan-level invariants.
 */

const AGG_EXPR_RE = /^\s*(sum|avg|mean|count|count_distinct|min|max)\s*\(/i;

type Issue = { stepIdx: number | null; message: string };

type ValidateResult = {
  ok: boolean;
  errors: string[];
  // Symbolic columns on the final result rows (may be empty if we bailed early).
  finalColumns: string[];
};

function looksLikeAggregateExpression(name: string): boolean {
  return AGG_EXPR_RE.test(name);
}

function computeInputColumns(expr: QuantComputeExpr): string[] {
  switch (expr.kind) {
    case "equals":
    case "not_equals":
    case "in":
    case "bucket":
      return [expr.column];
    case "divide":
      return [expr.numerator, expr.denominator];
    case "coalesce":
      return [...expr.columns];
    case "literal":
    default:
      return [];
  }
}

function applyJoinColumns(
  current: Set<string>,
  step: Extract<QuantOp, { op: "join" }>,
  issues: Issue[],
  stepIdx: number,
): Set<string> {
  const out = new Set(current);
  let rightCols: string[] = [];
  try {
    rightCols = peekColumns(step.rightDatasetId);
  } catch (e) {
    issues.push({
      stepIdx,
      message: `join: cannot read right dataset "${step.rightDatasetId}" (${e instanceof Error ? e.message : String(e)}).`,
    });
    return out;
  }
  const prefix = step.rightPrefix ?? "r_";
  const onPairs = Array.isArray(step.on) ? step.on : [];
  const sameNamePairs = new Set(
    onPairs.filter(([l, r]) => l === r).map(([l]) => l),
  );
  for (const col of rightCols) {
    if (sameNamePairs.has(col)) continue;
    out.add(`${prefix}${col}`);
  }
  return out;
}

function trackColumns(
  plan: QuantPlan,
  initial: Set<string>,
  issues: Issue[],
): Set<string> {
  let current = new Set(initial);
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    const n = i + 1;
    if (step.op === "filter") {
      if (!current.has(step.column)) {
        issues.push({
          stepIdx: n,
          message: `filter: column "${step.column}" not in rows at this point. Available: ${[...current].sort().join(", ")}.`,
        });
      }
    } else if (step.op === "sort") {
      if (!current.has(step.by)) {
        issues.push({
          stepIdx: n,
          message: `sort: column "${step.by}" not in rows at this point. Available: ${[...current].sort().join(", ")}.`,
        });
      }
    } else if (step.op === "limit") {
      // no schema change
    } else if (step.op === "groupby") {
      for (const b of step.by) {
        if (!current.has(b)) {
          issues.push({
            stepIdx: n,
            message: `groupby: "by" column "${b}" not in rows. Available: ${[...current].sort().join(", ")}.`,
          });
        }
      }
      for (const m of step.measures) {
        if (m.agg !== "count" && !current.has(m.column)) {
          issues.push({
            stepIdx: n,
            message: `groupby: measure column "${m.column}" (alias "${m.alias}") not in rows. Available: ${[...current].sort().join(", ")}.`,
          });
        }
      }
      const next = new Set<string>(step.by);
      for (const m of step.measures) next.add(m.alias);
      current = next;
    } else if (step.op === "project") {
      const next = new Set<string>();
      for (const c of step.columns) {
        if (!current.has(c)) {
          issues.push({
            stepIdx: n,
            message: `project: column "${c}" not in rows. Available: ${[...current].sort().join(", ")}.`,
          });
        } else {
          next.add(c);
        }
      }
      current = next;
    } else if (step.op === "compute") {
      for (const c of step.columns) {
        for (const input of computeInputColumns(c.expr)) {
          if (!current.has(input)) {
            issues.push({
              stepIdx: n,
              message: `compute (alias "${c.alias}"): input column "${input}" not in rows. Available: ${[...current].sort().join(", ")}.`,
            });
          }
        }
      }
      for (const c of step.columns) current.add(c.alias);
    } else if (step.op === "join") {
      current = applyJoinColumns(current, step, issues, n);
    }
  }
  return current;
}

/**
 * Validate a plan before handing it to `executeQuantPlan`.
 *
 * Returns `ok: false` with human-readable messages when the plan is
 * structurally fine but would produce a result that can't satisfy its own
 * `chart` (or references columns that won't exist at a given step). The
 * executor short-circuits on `ok: false` and surfaces the errors.
 */
export function validateQuantPlan(plan: QuantPlan): ValidateResult {
  const errors: string[] = [];
  const issues: Issue[] = [];

  if (!plan || typeof plan !== "object") {
    return { ok: false, errors: ["Plan is not an object."], finalColumns: [] };
  }
  if (typeof plan.datasetId !== "string" || !plan.datasetId.trim()) {
    return { ok: false, errors: ['Plan is missing "datasetId".'], finalColumns: [] };
  }
  if (!Array.isArray(plan.steps)) {
    return { ok: false, errors: ['Plan "steps" must be an array.'], finalColumns: [] };
  }
  if (!quantPlanReferencesValidDatasets(plan)) {
    return {
      ok: false,
      errors: [
        `Plan references a dataset not in the catalog (primary="${plan.datasetId}" or a join rightDatasetId). Use an id returned by listQuantDatasetIds().`,
      ],
      finalColumns: [],
    };
  }
  if (!getDatasetMeta(plan.datasetId)) {
    return {
      ok: false,
      errors: [`Unknown datasetId "${plan.datasetId}".`],
      finalColumns: [],
    };
  }

  let initial: Set<string>;
  try {
    initial = new Set(peekColumns(plan.datasetId));
  } catch (e) {
    return {
      ok: false,
      errors: [
        `Cannot read dataset "${plan.datasetId}": ${e instanceof Error ? e.message : String(e)}`,
      ],
      finalColumns: [],
    };
  }
  if (initial.size === 0) {
    // Empty dataset — let the executor handle it; don't pretend to validate chart wiring.
    return { ok: true, errors: [], finalColumns: [] };
  }

  const final = trackColumns(plan, initial, issues);

  if (plan.chart) {
    const { x, y } = plan.chart;
    const xOk = typeof x === "string" && x.trim().length > 0;
    const yOk = typeof y === "string" && y.trim().length > 0;
    if (!xOk || !yOk) {
      issues.push({
        stepIdx: null,
        message: `chart: "x" and "y" must be non-empty column names (got x=${JSON.stringify(x)}, y=${JSON.stringify(y)}). Either fill both or set chart to null.`,
      });
    } else {
      for (const [field, name] of [
        ["x", x] as const,
        ["y", y] as const,
      ]) {
        if (!final.has(name)) {
          const agg = looksLikeAggregateExpression(name);
          const hint = agg
            ? ` "${name}" looks like an aggregate expression — add a groupby measure aliased to exactly "${name}" (e.g. {"alias":"${name}","column":"<col>","agg":"${name.match(AGG_EXPR_RE)?.[1]?.toLowerCase() ?? "sum"}"}), or rename the measure alias and update chart.${field} to match.`
            : "";
          issues.push({
            stepIdx: null,
            message: `chart.${field} "${name}" not present on final result rows.${hint} Final columns: ${[...final].sort().join(", ")}.`,
          });
        }
      }
    }
  }

  for (const issue of issues) {
    errors.push(
      issue.stepIdx == null
        ? issue.message
        : `Step ${issue.stepIdx} ${issue.message}`,
    );
  }
  return { ok: errors.length === 0, errors, finalColumns: [...final] };
}
