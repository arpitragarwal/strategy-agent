import { AsyncLocalStorage } from "node:async_hooks";

export type PhaseTokenTotals = {
  input: number;
  output: number;
};

/** Persisted on `StrategyRun.tokenUsage` after each execution attempt. */
export type RunTokenUsageSnapshot = {
  input: number;
  output: number;
  total: number;
  calls: number;
  byPhase: Record<string, PhaseTokenTotals>;
  modelId?: string;
  recordedAt: string;
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export class RunTokenUsageAccumulator {
  byPhase: Record<string, PhaseTokenTotals> = {};
  calls = 0;
  readonly modelId?: string;

  constructor(modelId?: string) {
    this.modelId = modelId;
  }

  addFromUsageMetadata(phase: string, meta: unknown): void {
    if (!meta || typeof meta !== "object") return;
    const m = meta as Record<string, unknown>;
    let input = num(m.promptTokenCount);
    const output = num(m.candidatesTokenCount);
    let total = num(m.totalTokenCount);
    if (!input && !output && total) {
      input = Math.max(0, total - output);
    }
    if (!total && (input || output)) {
      total = input + output;
    }
    if (!input && total && output) {
      input = Math.max(0, total - output);
    }
    const bucket = this.byPhase[phase] ?? { input: 0, output: 0 };
    bucket.input += input;
    bucket.output += output;
    this.byPhase[phase] = bucket;
    this.calls += 1;
  }

  toJSON(): RunTokenUsageSnapshot {
    let input = 0;
    let output = 0;
    for (const b of Object.values(this.byPhase)) {
      input += b.input;
      output += b.output;
    }
    return {
      input,
      output,
      total: input + output,
      calls: this.calls,
      byPhase: { ...this.byPhase },
      ...(this.modelId ? { modelId: this.modelId } : {}),
      recordedAt: new Date().toISOString(),
    };
  }
}

type TrackingCtx = {
  acc: RunTokenUsageAccumulator;
  phase: string;
};

const trackingStorage = new AsyncLocalStorage<TrackingCtx>();

export function runTokenTrackingContext<T>(
  acc: RunTokenUsageAccumulator,
  fn: () => Promise<T>,
): Promise<T> {
  return trackingStorage.run({ acc, phase: "other" }, fn);
}

/** Set phase for subsequent successful `generateContent` calls (supports nesting). */
export async function withTokenPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  const ctx = trackingStorage.getStore();
  if (!ctx) return fn();
  const prev = ctx.phase;
  ctx.phase = phase;
  try {
    return await fn();
  } finally {
    ctx.phase = prev;
  }
}

export function recordTokenUsageFromGenerateResponse(response: {
  usageMetadata?: unknown;
}): void {
  const ctx = trackingStorage.getStore();
  if (!ctx?.acc) return;
  ctx.acc.addFromUsageMetadata(ctx.phase, response.usageMetadata);
}

function numField(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Sum a new execution slice into a previously stored snapshot (step-by-step resumes). */
export function mergeTokenUsageIntoStored(
  existing: unknown,
  delta: RunTokenUsageSnapshot,
): RunTokenUsageSnapshot {
  if (!existing || typeof existing !== "object") {
    return {
      ...delta,
      total: delta.input + delta.output,
    };
  }
  const e = existing as Partial<RunTokenUsageSnapshot>;
  const byPhase: Record<string, PhaseTokenTotals> = {};
  const ePh =
    e.byPhase && typeof e.byPhase === "object" ?
      (e.byPhase as Record<string, PhaseTokenTotals>)
    : {};
  const dPh = delta.byPhase;
  const keys = new Set([...Object.keys(ePh), ...Object.keys(dPh)]);
  for (const k of keys) {
    const a = ePh[k] ?? { input: 0, output: 0 };
    const b = dPh[k] ?? { input: 0, output: 0 };
    byPhase[k] = { input: a.input + b.input, output: a.output + b.output };
  }
  const input = numField(e.input) + delta.input;
  const output = numField(e.output) + delta.output;
  return {
    input,
    output,
    total: input + output,
    calls: numField(e.calls) + delta.calls,
    byPhase,
    ...(delta.modelId ? { modelId: delta.modelId }
    : typeof e.modelId === "string" && e.modelId ? { modelId: e.modelId }
    : {}),
    recordedAt: delta.recordedAt,
  };
}
