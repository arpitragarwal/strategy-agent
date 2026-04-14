"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { VegaLiteEmbed } from "@/components/VegaLiteEmbed";
import { playAttentionSound, primeAttentionAudio } from "@/lib/attentionChime";
import { parseStoredRunError } from "@/lib/errors";
import { flattenLeaves, listAllNodeIds } from "@/lib/outline";
import {
  RUNNING_STREAM_RECONNECT_BASE_MS,
  RUNNING_STREAM_RECONNECT_JITTER_MS,
} from "@/lib/runStream";
import type {
  HypothesisVerdict,
  OutlineNode,
  NodeState,
  ProgressEntry,
  ReviewCheckpoint,
} from "@/lib/types";

type RunMode = "end_to_end" | "step_by_step";

type TokenUsageSnapshot = {
  input?: number;
  output?: number;
  total?: number;
  calls?: number;
  /** Sum of executeRun wall time across slices (step-by-step). */
  executionMs?: number;
  byPhase?: Record<string, { input: number; output: number }>;
  modelId?: string;
  recordedAt?: string;
};

type RunRow = {
  id: string;
  status?: string;
  error?: string | null;
  reviewCheckpoint?: string | null;
  runMode?: string | null;
  usePriorRunMemory?: boolean | null;
  prompt: string;
  companyContext?: string | null;
  discoveryOutput: string | null;
  clarificationAnswers?: string | null;
  treeReviewNotes: string | null;
  outline: unknown;
  nodeStates: unknown;
  managerNotes: string | null;
  synthesis: string | null;
  synthesisIsPartial: boolean | null;
  progressLog: unknown;
  tokenUsage?: unknown;
};

/** Nearest thousand with K suffix (e.g. 83833 → 84K). Below 1K, show the integer. */
function formatTokensRoundK(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  return `${Math.round(n / 1000)}K`;
}

function formatCountK(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  return `${Math.round(n / 1000)}K`;
}

function formatRunDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sTotal = Math.round(ms / 1000);
  if (sTotal < 60) return `${sTotal}s`;
  const m = Math.floor(sTotal / 60);
  const s = sTotal % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** One line for the pipeline panel (above activity log). */
function formatTokenUsagePipelineLine(u: TokenUsageSnapshot | null): string | null {
  if (!u) return null;
  const input = typeof u.input === "number" ? u.input : 0;
  const output = typeof u.output === "number" ? u.output : 0;
  const calls = typeof u.calls === "number" ? u.calls : 0;
  const executionMs =
    typeof u.executionMs === "number" && Number.isFinite(u.executionMs) ? u.executionMs : 0;
  const parts: string[] = [];
  if (input || output || calls) {
    parts.push(
      `Tokens ${formatTokensRoundK(input)} in`,
      `${formatTokensRoundK(output)} out`,
      `${formatCountK(calls)} calls`,
    );
  }
  if (executionMs > 0) {
    const dur = formatRunDuration(executionMs);
    if (dur) parts.push(`Run time ${dur}`);
  }
  if (!parts.length) return null;
  return parts.join(" · ");
}

type ArtifactPayload = {
  userPrompt?: string;
  outline?: { roots?: OutlineNode[] };
  nodeStates?: Record<string, NodeState>;
  discovery?: string;
  treeReviewNotes?: string;
  managerNotes?: string;
  synthesis?: string;
  synthesisIsPartial?: boolean;
};

type MemoryRow = {
  id: string;
  createdAt: string;
  title: string;
  runId: string | null;
};

type QuantCatalogDataset = {
  id: string;
  relativePath: string;
  domain: string;
  description: string;
  columns: string[];
};

const QUANT_DOMAIN_ORDER = ["crm", "cx", "finance", "support"] as const;

function formatMemoryTimestamp(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Older runs used ## Recommendation / ## Supporting points; strip those headings for display. */
function normalizeSynthesisDisplayMarkdown(md: string): string {
  return md
    .replace(/^##\s*Recommendation\s*$/gim, "")
    .replace(/^##\s*Supporting points\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const REVIEW_LABELS: Record<ReviewCheckpoint, string> = {
  after_discovery: "Context & clarification",
  after_structure: "Revised hypothesis tree",
  after_analysis: "Analyses",
};

const PIPELINE: readonly { id: string; title: string; subtitle: string }[] = [
  {
    id: "discovery",
    title: "Context & clarification",
    subtitle: "Specificity, data checks, optional questions",
  },
  {
    id: "structure",
    title: "Hypothesis tree",
    subtitle: "Draft tree, manager review, revision",
  },
  { id: "analysis", title: "Analysis", subtitle: "Deep-dive each branch" },
  { id: "manager", title: "Manager critique", subtitle: "Pressure-test the analyses" },
  { id: "synthesis", title: "Strategy memo", subtitle: "Integrative synthesis" },
];

type PipelineStepStatus = "complete" | "active" | "upcoming";

/** Banner + optional stack (from SSE or stored run.error). */
type AppErrorState = { message: string; stack?: string } | null;

function toAppError(message: string, stack?: string): AppErrorState {
  const m = message.trim() || "Unknown error";
  const s = stack?.trim();
  return s ? { message: m, stack: s } : { message: m };
}

/** In-app activity only (not persisted to Neon until next server progress write). */
function appendStreamClientLog(
  setProgress: Dispatch<SetStateAction<ProgressEntry[]>>,
  message: string,
) {
  setProgress((prev) => [
    ...prev,
    { at: new Date().toISOString(), stage: "stream", message },
  ]);
}

function computePipelineSteps(args: {
  busy: boolean;
  pausedAt: ReviewCheckpoint | null;
  discovery: string;
  treeReviewNotes: string;
  roots: OutlineNode[];
  nodeStates: Record<string, NodeState>;
  managerNotes: string;
  synthesis: string;
  synthesisPartial: boolean;
  errorMessage: string | null;
}): { status: PipelineStepStatus; detail?: string }[] {
  const {
    busy,
    pausedAt,
    discovery,
    treeReviewNotes,
    roots,
    nodeStates,
    managerNotes,
    synthesis,
    synthesisPartial,
  } = args;
  const hasDiscovery = Boolean(discovery.trim());
  const hasOutline = roots.length > 0;
  const leaves = hasOutline ? flattenLeaves(roots) : [];
  const leavesTotal = leaves.length;
  const leavesDone = leaves.filter((l) => nodeStates[l.id]?.status === "done").length;
  const anyLeafStarted =
    leavesDone > 0 || leaves.some((l) => nodeStates[l.id]?.status === "running");
  const allLeavesDone = leavesTotal > 0 && leavesDone === leavesTotal;
  const allNodeIds = hasOutline ? listAllNodeIds(roots) : Object.keys(nodeStates);
  const nodesTotal = allNodeIds.length;
  const nodesDone = allNodeIds.filter((id) => {
    const status = nodeStates[id]?.status;
    return status === "done" || status === "skipped";
  }).length;
  const hasManager = Boolean(managerNotes.trim());
  const hasSynthesis = Boolean(synthesis.trim());

  if (hasSynthesis) {
    return PIPELINE.map((_, i) => ({
      status: "complete" as PipelineStepStatus,
      detail:
        i === 4 && synthesisPartial ? "Partial — stopped early" : undefined,
    }));
  }

  const structureDone =
    pausedAt === "after_structure" ||
    pausedAt === "after_analysis" ||
    anyLeafStarted ||
    allLeavesDone ||
    hasManager ||
    hasSynthesis;

  const analysisDone =
    pausedAt === "after_analysis" || hasManager || hasSynthesis || allLeavesDone;

  const managerDone = hasManager || hasSynthesis;

  const raw: PipelineStepStatus[] = PIPELINE.map((_, i) => {
    if (i === 0) {
      if (!hasDiscovery) return busy ? "active" : "upcoming";
      return "complete";
    }
    if (i === 1) {
      if (!hasDiscovery) return "upcoming";
      if (!structureDone) {
        return busy || hasOutline || Boolean(treeReviewNotes.trim()) ? "active" : "upcoming";
      }
      return "complete";
    }
    if (i === 2) {
      if (!structureDone) return "upcoming";
      if (!analysisDone) {
        if (pausedAt === "after_structure") return "active";
        // Do not use "hasOutline && leaves" alone — that kept Analysis on "NOW" after stream errors while idle.
        if (busy || anyLeafStarted) return "active";
        return "upcoming";
      }
      return "complete";
    }
    if (i === 3) {
      if (!analysisDone) return "upcoming";
      if (!managerDone) return busy || pausedAt === "after_analysis" ? "active" : "upcoming";
      return "complete";
    }
    if (!managerDone) return "upcoming";
    if (!hasSynthesis) return busy ? "active" : "upcoming";
    return "complete";
  });

  let seenActive = false;
  const result = raw.map((s, i) => {
    let status = s;
    if (status === "active") {
      if (seenActive) status = "complete";
      else seenActive = true;
    }
    const detail =
      i === 2 && nodesTotal > 0
        ? `nodes ${nodesDone}/${nodesTotal}`
        : i === 0 && pausedAt === "after_discovery"
          ? "Paused for your review"
          : i === 1 && pausedAt === "after_structure"
            ? "Paused for your review"
            : i === 2 && pausedAt === "after_analysis"
              ? "Paused for your review"
              : undefined;
    return { status, detail };
  });

  if (args.errorMessage?.trim()) {
    return result.map((r) => {
      if (r.status !== "active") return r;
      const stalledDetail = r.detail
        ? `${r.detail} · Stopped (see error above)`
        : "Stopped (see error above)";
      return { status: "upcoming" as PipelineStepStatus, detail: stalledDetail };
    });
  }
  return result;
}

function DisclosureChevron({ nested }: { nested?: boolean }) {
  const rotateClass = nested ? "group-open/log:rotate-90" : "group-open:rotate-90";
  return (
    <span
      className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-300 bg-white text-zinc-700 shadow-sm"
      aria-hidden
    >
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        className={`h-5 w-5 shrink-0 transition-transform duration-200 ease-out ${rotateClass}`}
        aria-hidden
      >
        <path
          fillRule="evenodd"
          d="M8.22 5.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 010-1.06z"
          clipRule="evenodd"
        />
      </svg>
    </span>
  );
}

function OutputPanel({
  title,
  subtitle,
  cardClassName,
  summaryEnd,
  defaultExpanded = true,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  cardClassName: string;
  summaryEnd?: ReactNode;
  /** When false, panel starts collapsed (Pipeline uses true explicitly). */
  defaultExpanded?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultExpanded);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className={`group rounded-xl border p-4 shadow-sm min-w-0 max-w-full ${cardClassName}`}
    >
      <summary className="flex cursor-pointer list-none items-start gap-3 text-left [&::-webkit-details-marker]:hidden">
        <DisclosureChevron />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <div className="text-sm font-semibold leading-snug text-zinc-900 [&_span]:text-inherit">
              {title}
            </div>
            {summaryEnd ? <div className="shrink-0">{summaryEnd}</div> : null}
          </div>
          {subtitle ? <div className="mt-1 text-zinc-500">{subtitle}</div> : null}
        </div>
      </summary>
      <div className="mt-3 border-t border-zinc-200/70 pt-3 min-w-0 max-w-full">{children}</div>
    </details>
  );
}

function QuantDatasetsTreeBox() {
  const [datasets, setDatasets] = useState<QuantCatalogDataset[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/quant/catalog");
        const data = (await res.json().catch(() => ({}))) as {
          datasets?: QuantCatalogDataset[];
          error?: string;
        };
        if (!res.ok) {
          if (!cancelled) setLoadError(data.error ?? res.statusText ?? "Request failed");
          return;
        }
        if (!cancelled) setDatasets(Array.isArray(data.datasets) ? data.datasets : []);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Failed to load catalog");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const domainBlocks = useMemo(() => {
    const m = new Map<string, QuantCatalogDataset[]>();
    for (const d of QUANT_DOMAIN_ORDER) m.set(d, []);
    for (const row of datasets ?? []) {
      const list = m.get(row.domain) ?? [];
      list.push(row);
      m.set(row.domain, list);
    }
    return QUANT_DOMAIN_ORDER.map((domain) => ({
      domain,
      rows: (m.get(domain) ?? []).slice().sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    })).filter((b) => b.rows.length > 0);
  }, [datasets]);

  function fileLabel(relativePath: string, domain: string): string {
    const prefix = `${domain}/`;
    return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : relativePath;
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm overflow-hidden">
      <div className="px-2.5 py-1.5 border-b border-zinc-100 bg-zinc-50/90">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">Data files</p>
        <p className="text-[9px] text-zinc-500 mt-0.5 leading-tight">
          Click a file to open the CSV · hover for <span className="font-mono">datasetId</span>
        </p>
      </div>
      <div className="p-2 max-h-[14rem] overflow-y-auto">
        {loading ? (
          <p className="text-[10px] text-zinc-500 font-mono">…</p>
        ) : loadError ? (
          <p className="text-[10px] text-rose-700">{loadError}</p>
        ) : !domainBlocks.length ? (
          <p className="text-[10px] text-zinc-500">No datasets.</p>
        ) : (
          <div className="font-mono text-[10px] leading-snug text-zinc-800 select-none">
            <div className="text-zinc-700">data/dummy/</div>
            {domainBlocks.map((block, di) => {
              const domainLast = di === domainBlocks.length - 1;
              const domainBranch = domainLast ? "└─ " : "├─ ";
              const continuation = domainLast ? "   " : "│  ";
              return (
                <div key={block.domain}>
                  <div className="flex whitespace-pre">
                    <span className="text-zinc-400" aria-hidden>
                      {domainBranch}
                    </span>
                    <span className="text-zinc-800">{block.domain}/</span>
                  </div>
                  {block.rows.map((row, fi) => {
                    const fileLast = fi === block.rows.length - 1;
                    const branch = fileLast ? "└─ " : "├─ ";
                    const name = fileLabel(row.relativePath, block.domain);
                    const href = `/api/quant/file/${row.id}`;
                    return (
                      <div key={row.id} className="flex whitespace-pre items-baseline" title={`${row.id} — ${row.description}`}>
                        <span className="text-zinc-400" aria-hidden>
                          {continuation}
                          {branch}
                        </span>
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sky-800 hover:text-sky-950 hover:underline underline-offset-2 decoration-sky-600/50 min-w-0 break-all select-text text-left"
                        >
                          {name}
                        </a>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Step list without a vertical spine — avoids misaligned segments when row heights differ.
 * Status: numbered circle → check when done; active ring + “Now” chip.
 */
function PipelineTimeline({
  steps,
}: {
  steps: { meta: (typeof PIPELINE)[number]; status: PipelineStepStatus; detail?: string }[];
}) {
  return (
    <ol className="m-0 list-none divide-y divide-zinc-200/90 pl-0 font-mono text-[11px] leading-tight">
      {steps.map(({ meta, status, detail }, i) => {
        const n = i + 1;
        const badgeClass =
          status === "complete"
            ? "border-emerald-600 bg-emerald-600 text-white"
            : status === "active"
              ? "border-amber-500 bg-amber-50 text-amber-950 ring-2 ring-amber-200/90 animate-pulse"
              : "border-zinc-200 bg-zinc-50 text-zinc-400";

        return (
          <li key={meta.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-semibold tabular-nums ${badgeClass}`}
              title={status}
              aria-hidden
            >
              {status === "complete" ? "✓" : n}
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div
                className={
                  status === "upcoming"
                    ? "text-zinc-400"
                    : status === "active"
                      ? "text-amber-950"
                      : "text-zinc-900"
                }
              >
                <span className="font-semibold tracking-tight">{meta.title}</span>
                {status === "active" ? (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-900">
                    Now
                  </span>
                ) : null}
              </div>
              <p
                className={`mt-0.5 text-[10px] ${status === "upcoming" ? "text-zinc-400" : "text-zinc-500"}`}
              >
                {meta.subtitle}
              </p>
              {detail ? (
                <p className="mt-1 text-[10px] font-medium text-sky-800/90">{detail}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StatusDot({ status }: { status: NodeState["status"] }) {
  const color =
    status === "done"
      ? "bg-emerald-400"
      : status === "running"
        ? "bg-amber-400 animate-pulse"
        : status === "blocked"
          ? "bg-rose-400"
          : status === "skipped"
            ? "bg-slate-500"
            : "bg-zinc-500";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} title={status} />;
}

/** Branches with children: deeper than this default to collapsed until the user expands or uses “Expand all”. */
const DEFAULT_TREE_EXPAND_DEPTH = 2;

function verdictLabelUi(v: HypothesisVerdict): string {
  switch (v) {
    case "confirmed":
      return "Confirmed";
    case "refuted":
      return "Refuted";
    case "partially_supported":
      return "Partially supported";
    default:
      return "Inconclusive";
  }
}

function verdictPillClass(v: HypothesisVerdict): string {
  switch (v) {
    case "confirmed":
      return "border-emerald-200 bg-emerald-50 text-emerald-900";
    case "refuted":
      return "border-rose-200 bg-rose-50 text-rose-900";
    case "partially_supported":
      return "border-amber-200 bg-amber-50 text-amber-950";
    default:
      return "border-zinc-200 bg-zinc-100 text-zinc-800";
  }
}

function confidencePillClass(c: NonNullable<NodeState["confidence"]>): string {
  switch (c) {
    case "high":
      return "border-emerald-200/80 bg-emerald-50/80 text-emerald-900";
    case "low":
      return "border-rose-200/70 bg-rose-50/70 text-rose-900";
    default:
      return "border-amber-200/80 bg-amber-50/80 text-amber-950";
  }
}

function collectBranchIdsWithChildren(nodes: OutlineNode[]): string[] {
  const ids: string[] = [];
  function walk(n: OutlineNode) {
    if (n.children?.length) {
      ids.push(n.id);
      for (const c of n.children) walk(c);
    }
  }
  for (const n of nodes) walk(n);
  return ids;
}

function ChevronToggleIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M6.22 5.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 10 6.22 6.28a.75.75 0 010-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function OutlineBranch({
  node,
  states,
  depth,
  isBranchExpanded,
  onToggleBranch,
}: {
  node: OutlineNode;
  states: Record<string, NodeState>;
  depth: number;
  isBranchExpanded: (id: string, depth: number, hasChildren: boolean) => boolean;
  onToggleBranch: (id: string, depth: number, hasChildren: boolean) => void;
}) {
  const hasKids = Boolean(node.children?.length);
  const expanded = isBranchExpanded(node.id, depth, hasKids);
  const state = states[node.id];

  return (
    <li className="list-none m-0 p-0">
      <div className="flex items-start gap-2">
        <div className="flex w-7 shrink-0 flex-col items-center gap-1 pt-2.5">
          {hasKids ? (
            <>
              <button
                type="button"
                className="rounded p-0.5 text-zinc-500 hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-400/40"
                aria-expanded={expanded}
                aria-label={expanded ? "Collapse branch" : "Expand branch"}
                onClick={() => onToggleBranch(node.id, depth, hasKids)}
              >
                <ChevronToggleIcon expanded={expanded} />
              </button>
              {state ? <StatusDot status={state.status} /> : null}
            </>
          ) : state ? (
            <StatusDot status={state.status} />
          ) : (
            <span className="inline-block h-2 w-2 rounded-full bg-zinc-200" title="Pending" />
          )}
        </div>
        <div className="min-w-0 flex-1 rounded-xl border border-zinc-200/95 bg-white px-3 py-2.5 text-sm shadow-sm ring-1 ring-zinc-100/80">
          <div className="font-medium text-zinc-900 break-words">{node.title}</div>
          {node.question ? (
            <p className="mt-1 text-zinc-700 text-xs break-words leading-snug">
              <span className="font-semibold text-zinc-900">Hypothesis:</span>{" "}
              {node.question}
            </p>
          ) : null}
          {state?.verdict ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span
                className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${verdictPillClass(state.verdict)}`}
              >
                {verdictLabelUi(state.verdict)}
              </span>
              {state.confidence ? (
                <span
                  className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold capitalize tracking-wide ${confidencePillClass(state.confidence)}`}
                >
                  {state.confidence} confidence
                </span>
              ) : null}
            </div>
          ) : null}
          {state?.confidence &&
          state.status === "done" &&
          !state.verdict ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span
                className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold capitalize tracking-wide ${confidencePillClass(state.confidence)}`}
              >
                {state.confidence} confidence
              </span>
            </div>
          ) : null}
          {!hasKids &&
          state?.hypothesisStatement &&
          state.hypothesisStatement.trim() !== (node.question ?? "").trim() ? (
            <p className="text-[10px] text-zinc-500 mt-1.5 italic break-words">
              Refined hypothesis: {state.hypothesisStatement}
            </p>
          ) : null}
          {state?.evidenceNeeded?.length ? (
            <div className="mt-2 rounded-md border border-amber-100 bg-amber-50/60 px-2 py-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-900/90">
                Additional data needed
              </p>
              <ul className="mt-1 list-disc pl-4 text-xs text-amber-950/90 space-y-0.5">
                {state.evidenceNeeded.map((item, i) => (
                  <li key={i} className="break-words">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {state?.summary ? (
            <div className="mt-2 border-t border-zinc-100 pt-2">
              {hasKids && state.status === "done" ? (
                <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-800/90 mb-1.5">
                  Rolled up from child hypotheses
                </p>
              ) : null}
              <p className="text-zinc-700 text-xs leading-relaxed break-words font-medium">
                {state.summary}
              </p>
            </div>
          ) : null}
          {!hasKids && state?.leafManagerReview?.trim() && state.status === "done" ? (
            <details className="mt-2 group/mgr border-t border-zinc-100 pt-2">
              <summary className="cursor-pointer text-[11px] font-medium text-amber-900 hover:text-amber-950">
                Manager review (this leaf)
              </summary>
              <div className="mt-2 min-w-0 max-w-full text-xs text-zinc-700 rounded-md border border-amber-100 bg-amber-50/50 px-2 py-1.5">
                <MarkdownBody content={state.leafManagerReview} />
              </div>
            </details>
          ) : null}
          {state?.analysis?.trim() && state.status === "done" ? (
            <details className="mt-2 group/leaf border-t border-zinc-100 pt-2">
              <summary className="cursor-pointer text-[11px] font-medium text-sky-800 hover:text-sky-950">
                {hasKids ? "How child results combine" : "Full analysis (confirm / deny reasoning)"}
              </summary>
              <div className="mt-2 min-w-0 max-w-full text-xs text-zinc-700">
                <MarkdownBody content={state.analysis} />
              </div>
            </details>
          ) : null}
          {state?.quant ? (
            <div className="mt-2 rounded-lg border border-indigo-100 bg-indigo-50/60 px-2 py-2 max-w-full min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-indigo-900">Quant check</p>
              {state.quant.error ? (
                <p className="text-xs text-rose-700 mt-1">{state.quant.error}</p>
              ) : (
                <>
                  <p className="text-[10px] text-indigo-900/80 mt-0.5">{state.quant.hypothesis_under_test}</p>
                  {state.quant.narrative ? (
                    <p className="text-xs text-indigo-950 mt-1">{state.quant.narrative}</p>
                  ) : null}
                  {(state.quant.vegaLiteSpecs ?? []).map((vl, i) => (
                    <div
                      key={i}
                      className="mt-2 bg-white rounded-md border border-indigo-100 p-1 max-w-full min-w-0 overflow-x-auto"
                    >
                      <p className="text-[10px] text-zinc-600 px-1 break-words">{vl.title}</p>
                      <VegaLiteEmbed spec={vl.spec} />
                    </div>
                  ))}
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
      {hasKids && expanded && node.children ? (
        <div className="relative mt-3 ml-[0.875rem] border-l-2 border-zinc-200 pl-5">
          <ul className="m-0 list-none space-y-4 p-0">
            {node.children.map((c) => (
              <OutlineBranch
                key={c.id}
                node={c}
                states={states}
                depth={depth + 1}
                isBranchExpanded={isBranchExpanded}
                onToggleBranch={onToggleBranch}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

export function StrategyConsole() {
  const [prompt, setPrompt] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorState>(null);

  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [discovery, setDiscovery] = useState("");
  const [treeReviewNotes, setTreeReviewNotes] = useState("");
  const [roots, setRoots] = useState<OutlineNode[]>([]);
  const [nodeStates, setNodeStates] = useState<Record<string, NodeState>>({});
  const [managerNotes, setManagerNotes] = useState("");
  const [synthesis, setSynthesis] = useState("");
  const [synthesisPartial, setSynthesisPartial] = useState(false);
  const [controlMessage, setControlMessage] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryRow[]>([]);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [pausedAt, setPausedAt] = useState<ReviewCheckpoint | null>(null);
  const [clarificationDraft, setClarificationDraft] = useState("");
  const [runMode, setRunMode] = useState<RunMode>("end_to_end");
  const [usePriorRunMemory, setUsePriorRunMemory] = useState(true);
  const [tokenUsage, setTokenUsage] = useState<TokenUsageSnapshot | null>(null);
  /** True after a terminal stream event so EventSource `onerror` from close() is ignored. */
  const suppressStreamErrorRef = useRef(false);
  /** Reconnect attempts when the host drops SSE but the run is still `running` in the DB. */
  const streamRetryRef = useRef(0);
  const attachRunStreamRef = useRef<(id: string, opts?: { retry?: boolean }) => void>(() => {});
  /** At most one EventSource per tab; closed before opening another. */
  const eventSourceRef = useRef<EventSource | null>(null);
  const streamReconnectTimerRef = useRef<number | null>(null);
  /** Stable `sid` per run id for this tab (survives reconnect). */
  const streamSidByRunIdRef = useRef<Map<string, string>>(new Map());

  const [treeExpandOverrides, setTreeExpandOverrides] = useState<Record<string, boolean>>({});

  useEffect(() => {
    return () => {
      if (streamReconnectTimerRef.current !== null) {
        clearTimeout(streamReconnectTimerRef.current);
        streamReconnectTimerRef.current = null;
      }
      if (eventSourceRef.current) {
        try {
          eventSourceRef.current.close();
        } catch {
          /* ignore */
        }
        eventSourceRef.current = null;
      }
    };
  }, []);

  const loadMemory = useCallback(async () => {
    const res = await fetch("/api/memory");
    if (!res.ok) return;
    const data = await res.json();
    setMemory(data.items ?? []);
  }, []);

  useEffect(() => {
    void loadMemory();
  }, [loadMemory]);

  useEffect(() => {
    setTreeExpandOverrides({});
  }, [runId]);

  const refreshRunMeta = useCallback(async (id: string) => {
    const res = await fetch(`/api/runs/${id}`);
    if (!res.ok) return;
    const run = (await res.json()) as RunRow;
    const raw = run.tokenUsage;
    setTokenUsage(
      raw && typeof raw === "object" ? (raw as TokenUsageSnapshot) : null,
    );
  }, []);

  const isTreeBranchExpanded = useCallback(
    (id: string, depth: number, hasChildren: boolean) => {
      if (!hasChildren) return true;
      const v = treeExpandOverrides[id];
      if (v !== undefined) return v;
      return depth < DEFAULT_TREE_EXPAND_DEPTH;
    },
    [treeExpandOverrides],
  );

  const toggleTreeBranch = useCallback((id: string, depth: number, hasChildren: boolean) => {
    if (!hasChildren) return;
    setTreeExpandOverrides((prev) => {
      const cur = prev[id] !== undefined ? prev[id]! : depth < DEFAULT_TREE_EXPAND_DEPTH;
      return { ...prev, [id]: !cur };
    });
  }, []);

  const expandAllTreeBranches = useCallback(() => {
    const ids = collectBranchIdsWithChildren(roots);
    setTreeExpandOverrides(Object.fromEntries(ids.map((i) => [i, true] as const)));
  }, [roots]);

  const collapseAllTreeBranches = useCallback(() => {
    const ids = collectBranchIdsWithChildren(roots);
    setTreeExpandOverrides(Object.fromEntries(ids.map((i) => [i, false] as const)));
  }, [roots]);

  const resetOutput = () => {
    if (streamReconnectTimerRef.current !== null) {
      clearTimeout(streamReconnectTimerRef.current);
      streamReconnectTimerRef.current = null;
    }
    if (eventSourceRef.current) {
      try {
        eventSourceRef.current.close();
      } catch {
        /* ignore */
      }
      eventSourceRef.current = null;
    }
    streamSidByRunIdRef.current.clear();
    setError(null);
    setProgress([]);
    setDiscovery("");
    setTreeReviewNotes("");
    setRoots([]);
    setNodeStates({});
    setTreeExpandOverrides({});
    setManagerNotes("");
    setSynthesis("");
    setSynthesisPartial(false);
    setControlMessage(null);
    setSelectedMemoryId(null);
    setPausedAt(null);
    setClarificationDraft("");
    setTokenUsage(null);
  };

  const hydrateFromRun = useCallback((run: RunRow, opts?: { preserveError?: boolean }) => {
    const legacy = run.companyContext?.trim();
    setPrompt(
      legacy ? `${run.prompt}${run.prompt.trim() ? "\n\n" : ""}${legacy}` : run.prompt,
    );
    setDiscovery(run.discoveryOutput ?? "");
    setTreeReviewNotes(run.treeReviewNotes ?? "");
    const outline = run.outline as { roots?: OutlineNode[] } | null | undefined;
    const nextRoots = outline?.roots ?? [];
    setRoots(nextRoots);
    const stored = (run.nodeStates as Record<string, NodeState> | null) ?? {};
    if (nextRoots.length) {
      const leafIds = new Set(flattenLeaves(nextRoots).map((l) => l.id));
      const assumeIncomplete = run.status !== "complete";
      setNodeStates(() => {
        const next = { ...stored };
        for (const id of listAllNodeIds(nextRoots)) {
          if (!next[id] && (leafIds.has(id) || assumeIncomplete)) {
            next[id] = { id, status: "pending" };
          }
        }
        return next;
      });
    } else {
      setNodeStates(stored);
    }
    setManagerNotes(run.managerNotes ?? "");
    setSynthesis(run.synthesis ?? "");
    setSynthesisPartial(Boolean(run.synthesisIsPartial));
    const log = run.progressLog;
    setProgress(Array.isArray(log) ? (log as ProgressEntry[]) : []);
    setRunId(run.id);
    if (!opts?.preserveError) {
      if (run.status === "failed" && run.error) {
        const parts = parseStoredRunError(run.error);
        setError(toAppError(parts.message, parts.stack));
      } else {
        setError(null);
      }
    }
    setControlMessage(null);
    if (run.status === "awaiting_review" && run.reviewCheckpoint) {
      setPausedAt(run.reviewCheckpoint as ReviewCheckpoint);
    } else {
      setPausedAt(null);
    }
    setClarificationDraft(run.clarificationAnswers ?? "");
    if (run.runMode === "end_to_end" || run.runMode === "step_by_step") {
      setRunMode(run.runMode);
    }
    setUsePriorRunMemory(
      typeof run.usePriorRunMemory === "boolean" ? run.usePriorRunMemory : true,
    );
    const tu = run.tokenUsage;
    setTokenUsage(tu && typeof tu === "object" ? (tu as TokenUsageSnapshot) : null);
  }, []);

  function hydrateFromArtifact(art: {
    id: string;
    title: string;
    runId: string | null;
    payload: unknown;
  }) {
    const p = art.payload as ArtifactPayload | null;
    const fallbackTitle = art.title.replace(/\s*\(partial\)\s*$/i, "").trim();
    setPrompt(p?.userPrompt?.trim() || fallbackTitle);
    setDiscovery(p?.discovery ?? "");
    setTreeReviewNotes(p?.treeReviewNotes ?? "");
    const nextRoots = p?.outline?.roots ?? [];
    setRoots(nextRoots);
    const stored = p?.nodeStates ?? {};
    if (nextRoots.length) {
      const leafIds = new Set(flattenLeaves(nextRoots).map((l) => l.id));
      const assumeIncomplete = !p?.synthesis?.trim();
      setNodeStates(() => {
        const next = { ...stored };
        for (const id of listAllNodeIds(nextRoots)) {
          if (!next[id] && (leafIds.has(id) || assumeIncomplete)) {
            next[id] = { id, status: "pending" };
          }
        }
        return next;
      });
    } else {
      setNodeStates(stored);
    }
    setManagerNotes(p?.managerNotes ?? "");
    setSynthesis(p?.synthesis ?? "");
    setSynthesisPartial(Boolean(p?.synthesisIsPartial));
    setProgress([]);
    setRunId(art.runId);
    setError(null);
    setControlMessage(null);
    setPausedAt(null);
    setClarificationDraft("");
  }

  const openMemoryEntry = async (m: MemoryRow) => {
    if (busy) return;
    setError(null);
    if (m.runId) {
      const res = await fetch(`/api/runs/${m.runId}`);
      if (res.ok) {
        const run = (await res.json()) as RunRow;
        hydrateFromRun(run);
        setSelectedMemoryId(m.id);
        return;
      }
    }
    const res = await fetch(`/api/memory/${m.id}`);
    if (res.ok) {
      const art = (await res.json()) as {
        id: string;
        title: string;
        runId: string | null;
        payload: unknown;
      };
      hydrateFromArtifact(art);
      setSelectedMemoryId(m.id);
      return;
    }
    setError(toAppError("Could not load this saved analysis."));
  };

  const getOrCreateStreamSid = useCallback((runIdForSid: string) => {
    const m = streamSidByRunIdRef.current;
    let sid = m.get(runIdForSid);
    if (!sid) {
      sid =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      m.set(runIdForSid, sid);
    }
    return sid;
  }, []);

  const attachRunStream = useCallback(
    (id: string, opts?: { retry?: boolean }) => {
      if (!opts?.retry) streamRetryRef.current = 0;
      suppressStreamErrorRef.current = false;
      setBusy(true);
      setPausedAt(null);
      setError(null);

      if (streamReconnectTimerRef.current !== null) {
        clearTimeout(streamReconnectTimerRef.current);
        streamReconnectTimerRef.current = null;
      }
      const prev = eventSourceRef.current;
      if (prev) {
        try {
          prev.close();
        } catch {
          /* ignore */
        }
        eventSourceRef.current = null;
      }

      const sid = encodeURIComponent(getOrCreateStreamSid(id));
      const src = new EventSource(`/api/runs/${id}/stream?sid=${sid}`);
      eventSourceRef.current = src;
      src.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as {
            type: string;
            entry?: ProgressEntry;
            text?: string;
            roots?: OutlineNode[];
            state?: NodeState;
            notes?: string;
            note?: string;
            runId?: string;
            message?: string;
            stack?: string;
            errorName?: string;
            partial?: boolean;
            checkpoint?: ReviewCheckpoint;
            replay?: boolean;
          };
          switch (msg.type) {
            case "keepalive":
              break;
            case "tree_review":
              if (msg.notes) setTreeReviewNotes(msg.notes);
              break;
            case "progress":
              if (msg.entry) {
                setProgress((p) => [...p, msg.entry!]);
              }
              break;
            case "discovery":
              if (msg.text) setDiscovery(msg.text);
              break;
            case "outline": {
              const nextRoots = msg.roots;
              if (nextRoots?.length) {
                setRoots(nextRoots);
                setNodeStates((prev) => {
                  const next = { ...prev };
                  for (const id of listAllNodeIds(nextRoots)) {
                    if (!next[id]) next[id] = { id, status: "pending" };
                  }
                  return next;
                });
              }
              break;
            }
            case "node":
              if (msg.state) {
                setNodeStates((s) => ({ ...s, [msg.state!.id]: msg.state! }));
              }
              break;
            case "manager":
              if (msg.notes) setManagerNotes(msg.notes);
              break;
            case "synthesis":
              if (msg.text) {
                setSynthesis(msg.text);
                setSynthesisPartial(Boolean(msg.partial));
              }
              break;
            case "awaiting_review":
              streamRetryRef.current = 0;
              if (msg.checkpoint) {
                setPausedAt(msg.checkpoint);
              }
              setBusy(false);
              setControlMessage(null);
              suppressStreamErrorRef.current = true;
              src.close();
              if (eventSourceRef.current === src) eventSourceRef.current = null;
              void playAttentionSound("step_complete");
              void refreshRunMeta(id);
              break;
            case "complete":
              streamRetryRef.current = 0;
              suppressStreamErrorRef.current = true;
              src.close();
              if (eventSourceRef.current === src) eventSourceRef.current = null;
              setBusy(false);
              setPausedAt(null);
              setControlMessage(null);
              if (!msg.replay) void playAttentionSound("run_complete");
              void loadMemory();
              void refreshRunMeta(id);
              break;
            case "error":
              streamRetryRef.current = 0;
              suppressStreamErrorRef.current = true;
              src.close();
              if (eventSourceRef.current === src) eventSourceRef.current = null;
              setError(
                toAppError(msg.message ?? "Unknown error", msg.stack),
              );
              setBusy(false);
              void (async () => {
                const res = await fetch(`/api/runs/${id}`);
                if (res.ok) {
                  hydrateFromRun((await res.json()) as RunRow, { preserveError: true });
                } else {
                  void refreshRunMeta(id);
                }
              })();
              break;
            default:
              break;
          }
        } catch {
          setError(toAppError("Failed to parse stream event"));
        }
      };
      src.onerror = () => {
        const ignore = suppressStreamErrorRef.current;
        suppressStreamErrorRef.current = false;
        src.close();
        if (eventSourceRef.current === src) eventSourceRef.current = null;
        setBusy(false);
        if (ignore) return;
        void (async () => {
          try {
            const res = await fetch(`/api/runs/${id}`);
            if (res.ok) {
              const run = (await res.json()) as RunRow;
              if (run.status === "complete" || run.status === "awaiting_review") {
                hydrateFromRun(run);
                if (run.status === "complete") void loadMemory();
                return;
              }
              if (run.status === "failed") {
                streamRetryRef.current = 0;
                hydrateFromRun(run);
                if (run.error) {
                  const parts = parseStoredRunError(run.error);
                  setError(toAppError(parts.message, parts.stack));
                }
                return;
              }
              if (run.status === "running") {
                streamRetryRef.current += 1;
                const n = streamRetryRef.current;
                if (n <= 15) {
                  const delayMs =
                    RUNNING_STREAM_RECONNECT_BASE_MS +
                    Math.floor(Math.random() * RUNNING_STREAM_RECONNECT_JITTER_MS);
                  const delaySec = Math.round(delayMs / 1000);
                  const reconnectMsg = `Stream disconnected — reconnecting in ~${delaySec}s (attempt ${n}/15) so the server can accept the stream again…`;
                  appendStreamClientLog(setProgress, reconnectMsg);
                  setError(toAppError(reconnectMsg));
                  streamReconnectTimerRef.current = window.setTimeout(() => {
                    streamReconnectTimerRef.current = null;
                    setError(null);
                    attachRunStreamRef.current(id, { retry: true });
                  }, delayMs);
                  return;
                }
                const exhaustedMsg =
                  "Stream disconnected while the run was still active. Wait a bit, refresh the page, or start a new run.";
                appendStreamClientLog(setProgress, exhaustedMsg);
                setError(toAppError(exhaustedMsg));
                return;
              }
            }
          } catch {
            /* ignore — show generic message below */
          }
          const lostMsg = "Stream connection lost";
          appendStreamClientLog(setProgress, lostMsg);
          setError((prev) => prev ?? toAppError(lostMsg));
        })();
      };
    },
    [loadMemory, refreshRunMeta, hydrateFromRun, getOrCreateStreamSid, setProgress],
  );

  attachRunStreamRef.current = attachRunStream;

  const startRun = async (mode: RunMode) => {
    if (!prompt.trim() || busy || pausedAt) return;
    void primeAttentionAudio();
    setRunMode(mode);
    resetOutput();
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          mode,
          usePriorRunMemory,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? res.statusText);
      }
      const { id } = await res.json();
      setRunId(id);
      attachRunStream(id);
    } catch (e) {
      setBusy(false);
      setError(
        toAppError(
          e instanceof Error ? e.message : String(e),
          e instanceof Error ? e.stack : undefined,
        ),
      );
    }
  };

  const continueRun = async () => {
    if (!runId || busy) return;
    void primeAttentionAudio();
    if (pausedAt === "after_discovery") {
      const res = await fetch(`/api/runs/${runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clarificationAnswers: clarificationDraft }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(
          toAppError((data as { error?: string }).error ?? res.statusText),
        );
        return;
      }
    }
    attachRunStream(runId);
  };

  const tokenUsagePipelineLine = useMemo(
    () => (runId ? formatTokenUsagePipelineLine(tokenUsage) : null),
    [runId, tokenUsage],
  );

  const nodesTotal = useMemo(() => {
    if (roots.length) return listAllNodeIds(roots).length;
    return Object.keys(nodeStates).length;
  }, [roots, nodeStates]);

  const nodesDone = useMemo(() => {
    if (roots.length) {
      return listAllNodeIds(roots).filter((id) => {
        const status = nodeStates[id]?.status;
        return status === "done" || status === "skipped";
      }).length;
    }
    return Object.values(nodeStates).filter((v) => v.status === "done" || v.status === "skipped").length;
  }, [roots, nodeStates]);

  const pipelineSteps = useMemo(() => {
    const computed = computePipelineSteps({
      busy,
      pausedAt,
      discovery,
      treeReviewNotes,
      roots,
      nodeStates,
      managerNotes,
      synthesis,
      synthesisPartial,
      errorMessage: error?.message ?? null,
    });
    return PIPELINE.map((meta, i) => ({
      meta,
      status: computed[i]!.status,
      detail: computed[i]!.detail,
    }));
  }, [
    busy,
    pausedAt,
    discovery,
    treeReviewNotes,
    roots,
    nodeStates,
    managerNotes,
    synthesis,
    synthesisPartial,
    error,
  ]);

  const sendControl = async (action: "synthesize_now") => {
    if (!runId || (!busy && !pausedAt)) return;
    setControlMessage(null);
    const res = await fetch(`/api/runs/${runId}/control`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, note: "" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setControlMessage(data.error ?? res.statusText);
      return;
    }
    if (action === "synthesize_now") {
      setControlMessage(
        pausedAt
          ? "Queued. Click Continue pipeline to stream partial synthesis."
          : "Stopping after current step — partial synthesis will stream next.",
      );
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <header className="sticky top-0 z-30 -mx-4 px-4 bg-white pb-4 border-b border-zinc-100 mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          Strategy Team AI Agents: Prototype
        </h1>
        <p className="text-zinc-600 text-sm mt-1">
          An AI powered strategy consulting team · Built by{" "}
          <a
            href="https://www.linkedin.com/in/arpit-agarwal/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-800/90 hover:text-emerald-700 underline-offset-2 hover:underline"
          >
            Arpit Agarwal
          </a>
        </p>
        {selectedMemoryId && !busy ? (
          <p className="text-emerald-800 text-xs mt-2 font-medium">
            Viewing a saved run from Memory — edit the goal and run again to start a new pipeline.
          </p>
        ) : null}
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8 items-start">
        <div className="space-y-6 min-w-0">
        <section className="rounded-xl border border-zinc-200 bg-white shadow-sm p-4 space-y-3">
          <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
            Goal, question & context
          </label>
          <textarea
            className="w-full min-h-[80px] rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
            placeholder="Put everything here: the strategic question, constraints, metrics, and any internal notes the agents should use."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={busy}
          />
          <label className="flex items-start gap-2.5 cursor-pointer select-none pt-0.5">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500/40"
              checked={usePriorRunMemory}
              onChange={(e) => setUsePriorRunMemory(e.target.checked)}
              disabled={busy}
            />
            <span className="text-sm text-zinc-700 leading-snug">
              <span className="font-medium text-zinc-900">Use prior run memory</span>
              <span className="text-zinc-500">
                {" "}
                — search saved analysis from earlier runs.
              </span>
            </span>
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-3 pt-1">
            <button
              type="button"
              onClick={() => void startRun("step_by_step")}
              disabled={busy || Boolean(pausedAt) || !prompt.trim()}
              title="Run step-by-step pauses after context & clarification, revised hypothesis tree, and analyses for your review."
              className="flex-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white text-sm font-medium px-4 py-2.5 transition-colors"
            >
              {busy && runMode === "step_by_step" ? "Running…" : "Run step-by-step"}
            </button>
            <button
              type="button"
              onClick={() => void startRun("end_to_end")}
              disabled={busy || Boolean(pausedAt) || !prompt.trim()}
              title="Run full pipeline continues through manager critique and synthesis without those pauses."
              className="flex-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white text-sm font-medium px-4 py-2.5 transition-colors"
            >
              {busy && runMode === "end_to_end" ? "Running…" : "Run full pipeline"}
            </button>
          </div>

          {pausedAt && runId && !busy ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50/90 p-3 space-y-3">
              <p className="text-xs font-medium text-amber-950 uppercase tracking-wide">
                Human review
              </p>
              <p className="text-sm text-amber-950/90">
                Review: <strong>{REVIEW_LABELS[pausedAt]}</strong>. When you are ready, continue the
                pipeline or synthesize from work so far.
              </p>
              {pausedAt === "after_discovery" ? (
                <label className="block text-xs text-amber-950/85">
                  Your answers (optional — merged into the brief before the hypothesis tree step)
                  <textarea
                    className="mt-1 w-full min-h-[72px] rounded-md border border-amber-200 bg-white px-2 py-1.5 text-sm text-zinc-900"
                    placeholder="Reply to any “Questions for you” above, or add missing detail…"
                    value={clarificationDraft}
                    onChange={(e) => setClarificationDraft(e.target.value)}
                  />
                </label>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void continueRun()}
                  className="rounded-md bg-amber-700 hover:bg-amber-800 text-white text-xs font-medium px-3 py-1.5"
                >
                  Continue pipeline
                </button>
                <button
                  type="button"
                  onClick={() => void sendControl("synthesize_now")}
                  className="rounded-md bg-zinc-700 hover:bg-zinc-800 text-white text-xs font-medium px-3 py-1.5"
                >
                  Synthesize so far
                </button>
              </div>
              {controlMessage ? (
                <p className="text-xs text-amber-900">{controlMessage}</p>
              ) : null}
            </div>
          ) : null}

          {busy && runId ? (
            <div className="rounded-lg border border-sky-200 bg-sky-50/80 p-3 space-y-2">
              <p className="text-xs font-medium text-sky-900 uppercase tracking-wide">
                While running
              </p>
              <p className="text-xs text-sky-800/90">
                The in-flight model call finishes first. Partial synthesis is applied at the next
                checkpoint between leaf batches during analysis.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void sendControl("synthesize_now")}
                  className="rounded-md bg-sky-600 hover:bg-sky-700 text-white text-xs font-medium px-3 py-1.5"
                >
                  Synthesize so far
                </button>
              </div>
              {controlMessage ? (
                <p className="text-xs text-amber-900">{controlMessage}</p>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <div className="text-sm text-rose-800 border border-rose-200 rounded-lg px-3 py-2 bg-rose-50 space-y-2">
              <p className="whitespace-pre-wrap break-words">{error.message}</p>
              {error.stack ? (
                <details className="text-xs font-mono text-rose-900/90">
                  <summary className="cursor-pointer text-rose-800 hover:text-rose-950 select-none">
                    Stack trace
                  </summary>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-rose-200/80 bg-rose-50/80 p-2 text-[11px] leading-snug">
                    {error.stack}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : null}
        </section>

        <OutputPanel
          key={runId ? `pipeline-${runId}` : "pipeline-idle"}
          defaultExpanded
          title="Pipeline"
          cardClassName="border-zinc-200 bg-zinc-50/80"
          summaryEnd={
            nodesTotal > 0 ? (
              <span className="text-xs font-mono text-zinc-500">
                nodes {nodesDone}/{nodesTotal}
              </span>
            ) : null
          }
        >
          <div className="rounded-lg border border-zinc-200/80 bg-white/90 px-3 py-3">
            <PipelineTimeline steps={pipelineSteps} />
          </div>
          {tokenUsagePipelineLine ? (
            <p className="mt-2 text-[10px] font-mono text-zinc-600 tabular-nums">
              {tokenUsagePipelineLine}
            </p>
          ) : null}
          <details className="mt-3 group/log">
            <summary className="cursor-pointer list-none flex items-start gap-3 text-left text-[10px] font-mono text-zinc-600 hover:text-zinc-800 [&::-webkit-details-marker]:hidden">
              <DisclosureChevron nested />
              <span className="pt-1.5">
                Activity log ({progress.length})
                {runId ? <span className="text-zinc-400"> · run {runId}</span> : null}
              </span>
            </summary>
            <ul className="mt-2 max-h-36 overflow-y-auto space-y-1.5 text-[10px] text-zinc-600 font-mono border-t border-zinc-200/80 pt-2">
              {progress.map((p, i) => (
                <li key={`${p.at}-${i}`} className="flex flex-col gap-1 min-w-0">
                  <div className="flex flex-wrap gap-x-2 gap-y-0.5 items-baseline">
                    <time
                      dateTime={p.at}
                      className="shrink-0 text-zinc-400 tabular-nums"
                      title={p.at}
                    >
                      {formatMemoryTimestamp(p.at)}
                    </time>
                    <span className="min-w-0">
                      <span className="text-zinc-500">{p.stage}</span> —{" "}
                      <span className="whitespace-pre-wrap break-words">{p.message}</span>
                      {p.errorName ? (
                        <span className="text-zinc-400"> ({p.errorName})</span>
                      ) : null}
                    </span>
                  </div>
                  {p.stack ? (
                    <details className="ml-0 pl-0 text-[10px] text-rose-900/85 font-mono">
                      <summary className="cursor-pointer select-none text-rose-800/90 hover:text-rose-950">
                        Trace
                      </summary>
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded border border-rose-200/70 bg-rose-50/60 p-1.5">
                        {p.stack}
                      </pre>
                    </details>
                  ) : null}
                </li>
              ))}
              {!progress.length ? (
                <li className="text-zinc-400">No events yet — start a run or continue from a pause.</li>
              ) : null}
            </ul>
          </details>
        </OutputPanel>

        {discovery ? (
          <OutputPanel title="Context & clarification" cardClassName="border-zinc-200 bg-white">
            <div className="max-h-64 overflow-y-auto">
              <MarkdownBody content={discovery} />
            </div>
          </OutputPanel>
        ) : null}

        {treeReviewNotes ? (
          <OutputPanel
            title={<span className="text-blue-950">Manager review (hypothesis tree)</span>}
            subtitle={
              <p className="text-xs text-blue-900/75">
                Review of the draft hypothesis tree before leaf analyses. The tree below reflects the revised
                structure.
              </p>
            }
            cardClassName="border-blue-200 bg-blue-50/90"
          >
            <div className="min-w-0 max-w-full max-h-[min(70vh,28rem)] overflow-y-auto overflow-x-auto overscroll-contain">
              <MarkdownBody content={treeReviewNotes} />
            </div>
          </OutputPanel>
        ) : null}

        {roots.length ? (
          <OutputPanel title="Hypothesis tree & analysis" cardClassName="border-zinc-200 bg-white">
            <div className="min-w-0 max-w-full space-y-4 overflow-x-auto overscroll-contain">
              {prompt.trim() ? (
                <div className="rounded-xl border-2 border-emerald-200/90 bg-gradient-to-b from-emerald-50/90 to-white px-4 py-3 shadow-sm ring-1 ring-emerald-100/50">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-900/75">
                    Strategy question
                  </p>
                  <p className="text-sm text-zinc-900 mt-1.5 whitespace-pre-wrap break-words leading-snug">
                    {prompt}
                  </p>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={expandAllTreeBranches}
                  className="rounded-md border border-emerald-200/80 bg-emerald-50/60 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-50 hover:text-emerald-950"
                >
                  Expand all
                </button>
                <button
                  type="button"
                  onClick={collapseAllTreeBranches}
                  className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                >
                  Collapse all
                </button>
              </div>
              <ul className="m-0 min-w-0 list-none space-y-4 p-0">
                {roots.map((r) => (
                  <OutlineBranch
                    key={r.id}
                    node={r}
                    states={nodeStates}
                    depth={0}
                    isBranchExpanded={isTreeBranchExpanded}
                    onToggleBranch={toggleTreeBranch}
                  />
                ))}
              </ul>
            </div>
          </OutputPanel>
        ) : null}

        {managerNotes ? (
          <OutputPanel
            title="Manager critique (analyses)"
            cardClassName="border-amber-200 bg-amber-50"
          >
            <MarkdownBody content={managerNotes} />
          </OutputPanel>
        ) : null}

        {synthesis ? (
          <OutputPanel
            title={
              <span className="text-emerald-900">
                Synthesis
                {synthesisPartial ? (
                  <span className="ml-2 text-xs font-normal text-amber-800">(partial — stopped early)</span>
                ) : null}
              </span>
            }
            cardClassName="border-emerald-200 bg-emerald-50/80"
          >
            <MarkdownBody content={normalizeSynthesisDisplayMarkdown(synthesis)} />
          </OutputPanel>
        ) : null}
        </div>

        <aside className="space-y-4 min-w-0 lg:sticky lg:top-32 lg:self-start">
          <QuantDatasetsTreeBox />
          <OutputPanel title="Memory" cardClassName="border-zinc-200 bg-zinc-50/80">
            <ul className="space-y-1 max-h-[min(40vh,18rem)] overflow-y-auto">
              {memory.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void openMemoryEntry(m)}
                    className={`w-full text-left text-[11px] leading-snug border rounded-md px-2 py-1 transition-colors ${
                      selectedMemoryId === m.id
                        ? "border-emerald-500 bg-emerald-50/90 ring-1 ring-emerald-200"
                        : "border-zinc-200 bg-white hover:bg-zinc-50 hover:border-zinc-300"
                    } ${busy ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                  >
                    <div className="font-medium text-zinc-900 line-clamp-1">{m.title}</div>
                    <p className="text-[9px] text-zinc-400 mt-0.5 font-mono tabular-nums truncate">
                      {formatMemoryTimestamp(m.createdAt)}
                    </p>
                    <span className="sr-only">Open saved run</span>
                  </button>
                </li>
              ))}
              {!memory.length ? (
                <li className="text-zinc-500 text-[10px]">None yet.</li>
              ) : null}
            </ul>
          </OutputPanel>
        </aside>
      </div>
    </div>
  );
}
