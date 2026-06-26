import {
  GoogleGenerativeAI,
  type ChatSession,
  type FunctionCall,
  type GenerateContentResult,
  type Part,
} from "@google/generative-ai";
import { getModelId } from "../genai";
import { recordTokenUsageFromGenerateResponse } from "../tokenUsage";
import { QUANT_DATASETS, tableNameFor } from "./catalog";
import { getProvider, type QuantProvider } from "./provider";
import { guardSql, SQL_MAX_ROWS } from "./sqlGuard";
import { buildVegaLiteSpec, isRenderableSpec } from "./chart";
import { QUANT_TOOL_DECLARATIONS, TOOL_NAMES } from "./tools";
import type { QuantChartConfig, QuantResult, QuantSqlAudit } from "./types";

const MAX_ITERATIONS = 6;
const MAX_RUN_SQL_CALLS = 8;
const SAMPLE_ROWS_LIMIT = 20;
const MAX_CHARTS = 3;

type FinalizePayload = {
  narrative: string;
  charts?: QuantChartConfig[];
};

type LastRunSqlResult = {
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  truncatedTo: number;
  totalRows: number;
};

function getApiKey(): string {
  const key = process.env.GOOGLE_AI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Missing GOOGLE_AI_API_KEY. Add it to .env (see https://aistudio.google.com/apikey).",
    );
  }
  return key;
}

function systemInstruction(dialect: string): string {
  const tableLines = QUANT_DATASETS.map(
    (d) => `- ${tableNameFor(d.id)} (${d.id}) — ${d.description}`,
  ).join("\n");
  return `You are a SQL data-analyst agent. You answer ONE hypothesis using read-only ${dialect} SQL against the warehouse below.

Tables (SQL name first; catalog id in parens):
${tableLines}

Tools (call in this order most of the time):
1. list_tables — only if you don't already know which table to use.
2. describe_table — fetch columns + enum values for any table you'll query.
3. sample_rows — preview at most ${SAMPLE_ROWS_LIMIT} rows to validate a draft query.
4. run_sql — execute the query whose result will support your conclusion. Call this only when you're confident; you have at most ${MAX_RUN_SQL_CALLS} run_sql attempts and ${MAX_ITERATIONS} total turns.
5. finalize — emit the narrative (and optional chart). Call this exactly once at the end.

SQL constraints:
- One statement per call. No semicolons except optional trailing one. No DDL/DML/PRAGMA/SET — the guard rejects them.
- Use the SQL table names (e.g. crm_deal_data), not catalog ids with slashes.
- Filter strings may be case-sensitive (e.g. outcome 'lost', deal_type 'renew'). Call describe_table to see the exact literals before filtering.
- All query results are capped at ${SQL_MAX_ROWS} rows; the guard auto-injects LIMIT if you forget.

Finalize rules:
- narrative is 1–3 sentences with concrete numbers from your final result tying back to the hypothesis.
- charts is optional (use the charts array; up to 3). Emit more than one only when a trend and a breakdown each add something. x, y, and series MUST be column names on the last run_sql result. y must be numeric (unless you set aggregate).
- Pick the chart type deliberately: 'bar' to compare categories, 'line' for a trend over a time/ordered x, 'area' for cumulative/stacked trends, 'point' for the relationship between two numeric columns, 'histogram' for the distribution of one numeric column (x only), 'heatmap' for two categories with series as the colored value, 'combo' for bars (y) plus a line (series) on a second axis, and 'boxplot' for a numeric distribution across categories.
- Use series to break results out by a dimension (e.g. segment, region); add stacked:true to stack, or horizontal:true for bars with long labels. Set aggregate ('sum','mean','count'…) to let the chart aggregate instead of pre-grouping in SQL. Add refLine ({stat:'mean'} or {value:N}) to mark a benchmark, dataLabels:true to print values on bars/points, and yFormat ('currency'/'percent', percent expects 0–1 fractions).
- Keep charts readable: aim for at most ~20–30 categories on a bar chart.
- If you cannot answer (no fit, empty result, query errors you can't fix), finalize with a narrative that says so plainly. Do not invent numbers.`;
}

function parseSqlForDatasetIds(sql: string): string[] {
  const ids = new Set<string>();
  const lower = sql.toLowerCase();
  for (const d of QUANT_DATASETS) {
    const name = tableNameFor(d.id).toLowerCase();
    // Match the table name as a whole word — `\w` boundary because table
    // names contain underscores (default `\b` works for that too).
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(lower)) ids.add(d.id);
  }
  return [...ids];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

const CHART_TYPES = ["bar", "line", "area", "point", "histogram", "heatmap", "combo", "boxplot"];
const AGGREGATES = ["sum", "mean", "median", "min", "max", "count"];

function coerceRefLine(raw: unknown): QuantChartConfig["refLine"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const value = typeof o.value === "number" && Number.isFinite(o.value) ? o.value : undefined;
  const statRaw = asString(o.stat).toLowerCase();
  const stat = statRaw === "mean" || statRaw === "median" ? (statRaw as "mean" | "median") : undefined;
  if (value === undefined && !stat) return undefined;
  const label = asString(o.label).trim() || undefined;
  return { ...(value !== undefined ? { value } : {}), ...(stat ? { stat } : {}), ...(label ? { label } : {}) };
}

function coerceChartConfig(raw: unknown): QuantChartConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const type = asString(o.type).toLowerCase();
  const x = asString(o.x).trim();
  const y = asString(o.y).trim();
  if (!CHART_TYPES.includes(type) || !x || !y) return null;
  const title = typeof o.title === "string" && o.title.trim() ? o.title.trim() : undefined;
  const series = asString(o.series).trim() || undefined;
  const yFormatRaw = asString(o.yFormat).toLowerCase();
  const yFormat =
    yFormatRaw === "currency" || yFormatRaw === "percent" || yFormatRaw === "number"
      ? (yFormatRaw as "currency" | "percent" | "number")
      : undefined;
  const aggRaw = asString(o.aggregate).toLowerCase();
  const aggregate = AGGREGATES.includes(aggRaw)
    ? (aggRaw as NonNullable<QuantChartConfig["aggregate"]>)
    : undefined;
  const refLine = coerceRefLine(o.refLine);
  return {
    type: type as QuantChartConfig["type"],
    x,
    y,
    ...(series ? { series } : {}),
    ...(o.horizontal === true ? { horizontal: true } : {}),
    ...(o.stacked === true ? { stacked: true } : {}),
    ...(aggregate ? { aggregate } : {}),
    ...(refLine ? { refLine } : {}),
    ...(o.dataLabels === true ? { dataLabels: true } : {}),
    ...(yFormat ? { yFormat } : {}),
    ...(title ? { title } : {}),
  };
}

/** Gather chart configs from finalize args: `charts` array and/or the legacy single `chart`. */
function coerceCharts(args: Record<string, unknown>): QuantChartConfig[] {
  const out: QuantChartConfig[] = [];
  if (Array.isArray(args.charts)) {
    for (const c of args.charts) {
      const cfg = coerceChartConfig(c);
      if (cfg) out.push(cfg);
    }
  }
  const single = coerceChartConfig(args.chart);
  if (single) out.push(single);
  return out.slice(0, MAX_CHARTS);
}

async function dispatchTool(
  call: FunctionCall,
  provider: QuantProvider,
  state: {
    audit: QuantSqlAudit[];
    runSqlCount: number;
    lastResult: LastRunSqlResult | null;
    datasetIdsUsed: Set<string>;
    finalize: FinalizePayload | null;
  },
): Promise<Record<string, unknown>> {
  const name = call.name;
  const args = (call.args ?? {}) as Record<string, unknown>;

  switch (name) {
    case TOOL_NAMES.listTables: {
      const tables = await provider.listTables();
      return { tables };
    }
    case TOOL_NAMES.describeTable: {
      try {
        const info = await provider.describeTable(asString(args.table));
        state.datasetIdsUsed.add(info.datasetId);
        return { table: info };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }
    case TOOL_NAMES.sampleRows: {
      const guard = guardSql(asString(args.sql));
      const startedAt = Date.now();
      if (!guard.ok) {
        state.audit.push({
          sql: asString(args.sql),
          rowCount: 0,
          durationMs: Date.now() - startedAt,
          error: `[sample_rows] ${guard.error}`,
        });
        return { error: guard.error };
      }
      try {
        const { columns, rows } = await provider.runSelect(guard.sql);
        const truncated = rows.slice(0, SAMPLE_ROWS_LIMIT);
        for (const id of parseSqlForDatasetIds(guard.sql)) state.datasetIdsUsed.add(id);
        state.audit.push({
          sql: guard.sql,
          rowCount: rows.length,
          durationMs: Date.now() - startedAt,
        });
        return {
          columns,
          rows: truncated,
          totalRows: rows.length,
          truncatedTo: truncated.length,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        state.audit.push({
          sql: guard.sql,
          rowCount: 0,
          durationMs: Date.now() - startedAt,
          error: msg,
        });
        return { error: msg };
      }
    }
    case TOOL_NAMES.runSql: {
      if (state.runSqlCount >= MAX_RUN_SQL_CALLS) {
        return {
          error: `run_sql call limit reached (${MAX_RUN_SQL_CALLS}). Finalize with what you have.`,
        };
      }
      state.runSqlCount += 1;
      const guard = guardSql(asString(args.sql));
      const startedAt = Date.now();
      if (!guard.ok) {
        state.audit.push({
          sql: asString(args.sql),
          rowCount: 0,
          durationMs: Date.now() - startedAt,
          error: `[run_sql] ${guard.error}`,
        });
        return { error: guard.error };
      }
      try {
        const { columns, rows } = await provider.runSelect(guard.sql);
        for (const id of parseSqlForDatasetIds(guard.sql)) state.datasetIdsUsed.add(id);
        state.lastResult = {
          sql: guard.sql,
          columns,
          rows,
          truncatedTo: rows.length,
          totalRows: rows.length,
        };
        state.audit.push({
          sql: guard.sql,
          rowCount: rows.length,
          durationMs: Date.now() - startedAt,
        });
        return {
          columns,
          rows: rows.slice(0, 50),
          totalRows: rows.length,
          rowsTruncatedForAgentTo: Math.min(50, rows.length),
          note: rows.length > 50
            ? `Showing first 50 rows to the agent; full ${rows.length} rows will appear in the final result table.`
            : undefined,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        state.audit.push({
          sql: guard.sql,
          rowCount: 0,
          durationMs: Date.now() - startedAt,
          error: msg,
        });
        return { error: msg };
      }
    }
    case TOOL_NAMES.finalize: {
      state.finalize = {
        narrative: asString(args.narrative).trim() || "(no narrative produced)",
        charts: coerceCharts(args),
      };
      return { ok: true };
    }
    default:
      return { error: `Unknown tool "${name}".` };
  }
}

function extractText(result: GenerateContentResult): string {
  try {
    return result.response.text().trim();
  } catch {
    return "";
  }
}

export type RunQuantAgentInput = {
  hypothesisUnderTest: string;
  /** Free-text context to ground the agent — e.g. parent path, prior analysis excerpt. Kept short. */
  context?: string;
};

export async function runQuantAgent(
  input: RunQuantAgentInput,
): Promise<QuantResult> {
  const executedAt = new Date().toISOString();
  const audit: QuantSqlAudit[] = [];
  const state = {
    audit,
    runSqlCount: 0,
    lastResult: null as LastRunSqlResult | null,
    datasetIdsUsed: new Set<string>(),
    finalize: null as FinalizePayload | null,
  };

  const safe: QuantResult = {
    hypothesis_under_test: input.hypothesisUnderTest,
    tables: [],
    vegaLiteSpecs: [],
    executedAt,
    sqlAudit: audit,
  };

  let chat: ChatSession;
  let provider: QuantProvider;
  try {
    provider = await getProvider();
    const ai = new GoogleGenerativeAI(getApiKey());
    const model = ai.getGenerativeModel({
      model: getModelId(),
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
      systemInstruction: systemInstruction(provider.dialect),
      tools: [{ functionDeclarations: QUANT_TOOL_DECLARATIONS }],
    });
    chat = model.startChat();
  } catch (e) {
    safe.error = e instanceof Error ? e.message : String(e);
    safe.narrative = safe.error;
    return safe;
  }

  const userMessage = input.context?.trim()
    ? `Hypothesis under test:\n${input.hypothesisUnderTest}\n\nContext:\n${input.context.trim()}`
    : `Hypothesis under test:\n${input.hypothesisUnderTest}`;

  let next: string | Part[] = userMessage;
  let trailingText = "";

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let result: GenerateContentResult;
    try {
      result = await chat.sendMessage(next);
    } catch (e) {
      safe.error = e instanceof Error ? e.message : String(e);
      break;
    }
    recordTokenUsageFromGenerateResponse(result.response as { usageMetadata?: unknown });

    const calls = result.response.functionCalls() ?? [];
    if (calls.length === 0) {
      trailingText = extractText(result);
      break;
    }

    const responseParts: Part[] = [];
    for (const call of calls) {
      const response = await dispatchTool(call, provider, state);
      responseParts.push({
        functionResponse: { name: call.name, response },
      });
      if (state.finalize) break;
    }
    next = responseParts;
    if (state.finalize) {
      // Let the model see the finalize ack and emit a closing turn (optional).
      // We already have everything we need; bail to keep latency down.
      break;
    }
  }

  safe.datasetIdsUsed = [...state.datasetIdsUsed];
  if (state.datasetIdsUsed.size === 1) {
    safe.datasetId = [...state.datasetIdsUsed][0];
  } else if (state.lastResult) {
    const idsForLast = parseSqlForDatasetIds(state.lastResult.sql);
    if (idsForLast.length) safe.datasetId = idsForLast[0];
  }

  if (state.lastResult) {
    safe.tables.push({
      name: "result",
      columns: state.lastResult.columns,
      rows: state.lastResult.rows,
    });
  }

  let narrative = state.finalize?.narrative?.trim() ?? "";
  if (!narrative) {
    narrative = trailingText
      ? trailingText.slice(0, 600)
      : state.lastResult
      ? `${state.lastResult.rows.length} row(s) returned from the final query, but the agent did not produce a narrative.`
      : "Quant agent did not produce a narrative or run any SQL.";
  }

  if (state.finalize?.charts?.length && state.lastResult?.rows.length) {
    const have = new Set(state.lastResult.columns);
    const rows = state.lastResult.rows;
    let skipped = 0;
    for (const raw of state.finalize.charts) {
      const chart = { ...raw };
      // Drop a series column the result doesn't actually have rather than failing.
      if (chart.series && !have.has(chart.series)) delete chart.series;
      // x is always required; y is required for everything except histogram (x-only).
      const ok = have.has(chart.x) && (chart.type === "histogram" || have.has(chart.y));
      if (!ok) {
        skipped += 1;
        continue;
      }
      const spec = buildVegaLiteSpec(chart, rows);
      // Drop specs Vega-Lite can't compile rather than shipping a blank widget.
      if (!isRenderableSpec(spec)) {
        skipped += 1;
        continue;
      }
      safe.vegaLiteSpecs.push({
        title: chart.title ?? `${chart.y} by ${chart.x}`,
        spec,
      });
    }
    if (skipped > 0) {
      narrative = `${narrative} (${skipped} chart${skipped > 1 ? "s" : ""} skipped — missing columns or unrenderable.)`;
    }
  }

  safe.narrative = narrative;
  if (!state.finalize && !safe.error && !state.lastResult) {
    safe.error = safe.error ?? "Quant agent did not call run_sql or finalize.";
  }
  return safe;
}
