"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { flattenLeaves } from "@/lib/outline";
import type { OutlineNode, NodeState, ProgressEntry, ReviewCheckpoint } from "@/lib/types";

type RunMode = "end_to_end" | "step_by_step";

type RunRow = {
  id: string;
  status?: string;
  reviewCheckpoint?: string | null;
  runMode?: string | null;
  prompt: string;
  companyContext?: string | null;
  discoveryOutput: string | null;
  treeReviewNotes: string | null;
  outline: unknown;
  nodeStates: unknown;
  managerNotes: string | null;
  synthesis: string | null;
  synthesisIsPartial: boolean | null;
  progressLog: unknown;
};

type ArtifactPayload = {
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
  summary: string;
  topics: string;
  runId: string | null;
};

const REVIEW_LABELS: Record<ReviewCheckpoint, string> = {
  after_discovery: "Discovery",
  after_structure: "Revised MECE structure",
  after_analysis: "Analyses",
};

const PIPELINE: readonly { id: string; title: string; subtitle: string }[] = [
  { id: "discovery", title: "Discovery", subtitle: "Frame the question & context" },
  {
    id: "structure",
    title: "MECE issue tree",
    subtitle: "Draft structure, manager review, revision",
  },
  { id: "analysis", title: "Analysis", subtitle: "Deep-dive each branch" },
  { id: "manager", title: "Manager critique", subtitle: "Pressure-test the analyses" },
  { id: "synthesis", title: "Strategy memo", subtitle: "Integrative synthesis" },
];

type PipelineStepStatus = "complete" | "active" | "upcoming";

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
        if (busy || anyLeafStarted || (hasOutline && leavesTotal > 0)) return "active";
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
  return raw.map((s, i) => {
    let status = s;
    if (status === "active") {
      if (seenActive) status = "complete";
      else seenActive = true;
    }
    const detail =
      i === 2 && leavesTotal > 0
        ? `${leavesDone}/${leavesTotal} branches`
        : i === 0 && pausedAt === "after_discovery"
          ? "Paused for your review"
          : i === 1 && pausedAt === "after_structure"
            ? "Paused for your review"
            : i === 2 && pausedAt === "after_analysis"
              ? "Paused for your review"
              : undefined;
    return { status, detail };
  });
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
      className={`group rounded-xl border p-4 shadow-sm ${cardClassName}`}
    >
      <summary className="flex cursor-pointer list-none items-start gap-2 text-left [&::-webkit-details-marker]:hidden">
        <span
          className="mt-0.5 inline-block shrink-0 text-zinc-400 transition-transform duration-200 group-open:rotate-90"
          aria-hidden
        >
          ▸
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <div className="text-sm font-semibold leading-snug text-zinc-900 [&_span]:text-inherit">
              {title}
            </div>
            {summaryEnd ? <div className="shrink-0">{summaryEnd}</div> : null}
          </div>
          {subtitle ? <div className="mt-1 text-zinc-500">{subtitle}</div> : null}
        </div>
      </summary>
      <div className="mt-3 border-t border-zinc-200/70 pt-3">{children}</div>
    </details>
  );
}

function PipelineTimeline({
  steps,
}: {
  steps: { meta: (typeof PIPELINE)[number]; status: PipelineStepStatus; detail?: string }[];
}) {
  return (
    <ol className="select-none pl-0 font-mono text-[11px] leading-tight list-none">
      {steps.map(({ meta, status, detail }, i) => {
        const isLast = i === steps.length - 1;
        const prev = i > 0 ? steps[i - 1].status : null;
        const nodeClass =
          status === "complete"
            ? "bg-emerald-500 border-emerald-700 shadow-[0_0_0_2px_rgba(16,185,129,0.2)]"
            : status === "active"
              ? "bg-amber-400 border-amber-700 ring-2 ring-amber-200/90 animate-pulse"
              : "bg-zinc-50 border-zinc-300";

        return (
          <li key={meta.id} className="flex gap-3">
            <div className="flex w-6 shrink-0 flex-col items-center pt-0.5">
              {i > 0 && prev ? (
                <div
                  className={`h-4 w-[3px] shrink-0 rounded-full ${
                    prev === "complete"
                      ? "bg-emerald-400"
                      : prev === "active"
                        ? "bg-gradient-to-b from-amber-400 to-amber-300"
                        : "bg-zinc-200"
                  }`}
                  aria-hidden
                />
              ) : null}
              <span
                className={`relative z-[1] h-2.5 w-2.5 shrink-0 rounded-full border-2 ${nodeClass}`}
                title={status}
              />
              {!isLast ? (
                <div
                  className={`mt-0 min-h-[14px] w-[3px] flex-1 rounded-full ${status === "complete" ? "bg-emerald-400" : status === "active" ? "bg-gradient-to-b from-amber-400 to-zinc-200" : "bg-zinc-200"}`}
                  aria-hidden
                />
              ) : null}
            </div>
            <div className={`min-w-0 flex-1 ${isLast ? "pb-0" : "pb-3"}`}>
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
                {status === "complete" ? (
                  <span className="ml-2 text-emerald-600" aria-hidden>
                    ✓
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

function OutlineBranch({
  node,
  states,
}: {
  node: OutlineNode;
  states: Record<string, NodeState>;
}) {
  const hasKids = Boolean(node.children?.length);
  const state = states[node.id];

  return (
    <li className="py-1">
      <div className="flex items-start gap-2 text-sm">
        {!hasKids && state ? <StatusDot status={state.status} /> : <span className="w-2" />}
        <div className="min-w-0 flex-1">
          <div className="font-medium text-zinc-900">{node.title}</div>
          {node.question ? (
            <div className="text-zinc-500 text-xs mt-0.5">{node.question}</div>
          ) : null}
          {state?.summary ? (
            <p className="text-zinc-600 text-xs mt-1 leading-relaxed">{state.summary}</p>
          ) : null}
        </div>
      </div>
      {hasKids && node.children ? (
        <ul className="ml-4 mt-1 border-l border-zinc-200 pl-3">
          {node.children.map((c) => (
            <OutlineBranch key={c.id} node={c} states={states} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function StrategyConsole() {
  const [prompt, setPrompt] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [discovery, setDiscovery] = useState("");
  const [treeReviewNotes, setTreeReviewNotes] = useState("");
  const [roots, setRoots] = useState<OutlineNode[]>([]);
  const [nodeStates, setNodeStates] = useState<Record<string, NodeState>>({});
  const [managerNotes, setManagerNotes] = useState("");
  const [synthesis, setSynthesis] = useState("");
  const [synthesisPartial, setSynthesisPartial] = useState(false);
  const [redirectNote, setRedirectNote] = useState("");
  const [controlMessage, setControlMessage] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryRow[]>([]);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [pausedAt, setPausedAt] = useState<ReviewCheckpoint | null>(null);
  const [runMode, setRunMode] = useState<RunMode>("end_to_end");
  const endedWithPauseRef = useRef(false);

  const loadMemory = useCallback(async () => {
    const res = await fetch("/api/memory");
    if (!res.ok) return;
    const data = await res.json();
    setMemory(data.items ?? []);
  }, []);

  useEffect(() => {
    void loadMemory();
  }, [loadMemory]);

  const resetOutput = () => {
    setError(null);
    setProgress([]);
    setDiscovery("");
    setTreeReviewNotes("");
    setRoots([]);
    setNodeStates({});
    setManagerNotes("");
    setSynthesis("");
    setSynthesisPartial(false);
    setControlMessage(null);
    setSelectedMemoryId(null);
    setPausedAt(null);
  };

  function hydrateFromRun(run: RunRow) {
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
      const leaves = flattenLeaves(nextRoots);
      setNodeStates(() => {
        const next = { ...stored };
        for (const leaf of leaves) {
          if (!next[leaf.id]) next[leaf.id] = { id: leaf.id, status: "pending" };
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
    setError(null);
    setControlMessage(null);
    setRedirectNote("");
    if (run.status === "awaiting_review" && run.reviewCheckpoint) {
      setPausedAt(run.reviewCheckpoint as ReviewCheckpoint);
    } else {
      setPausedAt(null);
    }
    if (run.runMode === "end_to_end" || run.runMode === "step_by_step") {
      setRunMode(run.runMode);
    }
  }

  function hydrateFromArtifact(art: {
    id: string;
    title: string;
    runId: string | null;
    payload: unknown;
  }) {
    const p = art.payload as ArtifactPayload | null;
    const title = art.title.replace(/\s*\(partial\)\s*$/i, "").trim();
    setPrompt(title);
    setDiscovery(p?.discovery ?? "");
    setTreeReviewNotes(p?.treeReviewNotes ?? "");
    const nextRoots = p?.outline?.roots ?? [];
    setRoots(nextRoots);
    const stored = p?.nodeStates ?? {};
    if (nextRoots.length) {
      const leaves = flattenLeaves(nextRoots);
      setNodeStates(() => {
        const next = { ...stored };
        for (const leaf of leaves) {
          if (!next[leaf.id]) next[leaf.id] = { id: leaf.id, status: "pending" };
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
    setRedirectNote("");
    setPausedAt(null);
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
    setError("Could not load this saved analysis.");
  };

  const attachRunStream = useCallback(
    (id: string) => {
      endedWithPauseRef.current = false;
      setBusy(true);
      setPausedAt(null);
      setError(null);

      const src = new EventSource(`/api/runs/${id}/stream`);
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
            partial?: boolean;
            checkpoint?: ReviewCheckpoint;
          };
          switch (msg.type) {
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
            case "outline":
              if (msg.roots) {
                setRoots(msg.roots);
                const leaves = flattenLeaves(msg.roots);
                setNodeStates((prev) => {
                  const next = { ...prev };
                  for (const leaf of leaves) {
                    if (!next[leaf.id]) {
                      next[leaf.id] = { id: leaf.id, status: "pending" };
                    }
                  }
                  return next;
                });
              }
              break;
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
            case "redirect_ack":
              if (msg.note) {
                setControlMessage(`Redirect recorded — next leaves will follow your note.`);
              }
              break;
            case "awaiting_review":
              endedWithPauseRef.current = true;
              if (msg.checkpoint) {
                setPausedAt(msg.checkpoint);
              }
              setBusy(false);
              setControlMessage(null);
              src.close();
              break;
            case "complete":
              src.close();
              setBusy(false);
              setPausedAt(null);
              setControlMessage(null);
              void loadMemory();
              break;
            case "error":
              src.close();
              setError(msg.message ?? "Unknown error");
              setBusy(false);
              break;
            default:
              break;
          }
        } catch {
          setError("Failed to parse stream event");
        }
      };
      src.onerror = () => {
        src.close();
        setBusy(false);
        if (endedWithPauseRef.current) {
          endedWithPauseRef.current = false;
          return;
        }
        setError((prev) => prev ?? "Stream connection lost");
      };
    },
    [loadMemory],
  );

  const startRun = async (mode: RunMode) => {
    if (!prompt.trim() || busy || pausedAt) return;
    setRunMode(mode);
    resetOutput();
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          mode,
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
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const continueRun = () => {
    if (!runId || busy) return;
    attachRunStream(runId);
  };

  const leavesTotal = useMemo(() => {
    if (roots.length) return flattenLeaves(roots).length;
    return Object.keys(nodeStates).length;
  }, [roots, nodeStates]);

  const leavesDone = useMemo(
    () => Object.values(nodeStates).filter((v) => v.status === "done").length,
    [nodeStates],
  );

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
  ]);

  const sendControl = async (action: "synthesize_now" | "redirect", note?: string) => {
    if (!runId || (!busy && !pausedAt)) return;
    setControlMessage(null);
    const res = await fetch(`/api/runs/${runId}/control`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, note: note ?? "" }),
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
    if (action === "redirect") {
      setRedirectNote("");
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8">
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            Strategy Team AI Agents: Prototype
          </h1>
          <p className="text-zinc-600 text-sm mt-1">
            An AI powered strategy consulting team
          </p>
          {selectedMemoryId && !busy ? (
            <p className="text-emerald-800 text-xs mt-2 font-medium">
              Viewing a saved run from Memory — edit the goal and run again to start a new pipeline.
            </p>
          ) : null}
        </header>

        <section className="rounded-xl border border-zinc-200 bg-white shadow-sm p-4 space-y-3">
          <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
            Goal, question & context
          </label>
          <textarea
            className="w-full min-h-[160px] rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
            placeholder="Put everything here: the strategic question, constraints, metrics, and any internal notes the agents should use."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={busy}
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-3 pt-1">
            <button
              type="button"
              onClick={() => void startRun("step_by_step")}
              disabled={busy || Boolean(pausedAt) || !prompt.trim()}
              title="Runs discovery, then MECE build & revision, then analysis — pausing after each major phase so you can review before continuing."
              className="flex-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white text-sm font-medium px-4 py-2.5 transition-colors"
            >
              {busy && runMode === "step_by_step" ? "Running…" : "Run step-by-step"}
            </button>
            <button
              type="button"
              onClick={() => void startRun("end_to_end")}
              disabled={busy || Boolean(pausedAt) || !prompt.trim()}
              title="Runs the full pipeline in one go: discovery, MECE, analysis, manager critique, and synthesis — no mandatory review pauses (you can still steer during analysis)."
              className="flex-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white text-sm font-medium px-4 py-2.5 transition-colors"
            >
              {busy && runMode === "end_to_end" ? "Running…" : "Run full pipeline"}
            </button>
          </div>
          <p className="text-xs text-zinc-500">
            <strong className="font-medium text-zinc-700">Run step-by-step</strong> pauses after discovery,
            revised MECE, and analyses for your review.
            <span className="mx-1.5 text-zinc-300">·</span>
            <strong className="font-medium text-zinc-700">Run full pipeline</strong> continues through manager
            critique and synthesis without those pauses.
          </p>
          {runId ? (
            <p className="text-xs text-zinc-500 font-mono break-all">run {runId}</p>
          ) : null}

          {pausedAt && runId && !busy ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50/90 p-3 space-y-3">
              <p className="text-xs font-medium text-amber-950 uppercase tracking-wide">
                Human review
              </p>
              <p className="text-sm text-amber-950/90">
                Review: <strong>{REVIEW_LABELS[pausedAt]}</strong>. When you are ready, continue the
                pipeline or synthesize from work so far.
              </p>
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
              {pausedAt === "after_structure" ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end pt-1 border-t border-amber-200/80">
                  <label className="flex-1 block text-xs text-amber-950/85">
                    Redirect / steering (applied when analysis runs)
                    <textarea
                      className="mt-1 w-full min-h-[64px] rounded-md border border-amber-200 bg-white px-2 py-1.5 text-sm text-zinc-900"
                      placeholder="e.g. Focus on enterprise segment…"
                      value={redirectNote}
                      onChange={(e) => setRedirectNote(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const n = redirectNote.trim();
                      if (!n) return;
                      void sendControl("redirect", n);
                    }}
                    disabled={!redirectNote.trim()}
                    className="rounded-md bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white text-xs font-medium px-3 py-1.5 sm:mb-0.5"
                  >
                    Save redirect
                  </button>
                </div>
              ) : null}
              {controlMessage ? (
                <p className="text-xs text-amber-900">{controlMessage}</p>
              ) : null}
            </div>
          ) : null}

          {busy && runId ? (
            <div className="rounded-lg border border-sky-200 bg-sky-50/80 p-3 space-y-2">
              <p className="text-xs font-medium text-sky-900 uppercase tracking-wide">
                Steer while running
              </p>
              <p className="text-xs text-sky-800/90">
                Between major steps the run pauses for your review. While a step is running, the
                in-flight model call finishes first; synthesize / redirect are applied at the next
                checkpoint (between leaves during analysis).
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
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="flex-1 block text-xs text-sky-900/80">
                  Redirect / steering note (applied to remaining leaves)
                  <textarea
                    className="mt-1 w-full min-h-[64px] rounded-md border border-sky-200 bg-white px-2 py-1.5 text-sm text-zinc-900"
                    placeholder="e.g. Ignore consumer; focus on enterprise ACVs and churn…"
                    value={redirectNote}
                    onChange={(e) => setRedirectNote(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const n = redirectNote.trim();
                    if (!n) return;
                    void sendControl("redirect", n);
                  }}
                  disabled={!redirectNote.trim()}
                  className="rounded-md bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white text-xs font-medium px-3 py-1.5 sm:mb-0.5"
                >
                  Apply redirect
                </button>
              </div>
              {controlMessage ? (
                <p className="text-xs text-amber-900">{controlMessage}</p>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p className="text-sm text-rose-800 border border-rose-200 rounded-lg px-3 py-2 bg-rose-50">
              {error}
            </p>
          ) : null}
        </section>

        <OutputPanel
          key={runId ? `pipeline-${runId}` : "pipeline-idle"}
          defaultExpanded
          title="Pipeline"
          subtitle={
            <p className="text-[10px] font-mono text-zinc-500">
              Linear run — like a branch timeline; dim steps are still ahead.
            </p>
          }
          cardClassName="border-zinc-200 bg-zinc-50/80"
          summaryEnd={
            leavesTotal > 0 ? (
              <span className="text-xs font-mono text-zinc-500">
                leaves {leavesDone}/{leavesTotal}
              </span>
            ) : null
          }
        >
          <div className="rounded-lg border border-zinc-200/80 bg-white/90 px-3 py-3">
            <PipelineTimeline steps={pipelineSteps} />
          </div>
          <details className="mt-3 group/log">
            <summary className="cursor-pointer text-[10px] font-mono text-zinc-500 hover:text-zinc-700 list-none flex items-center gap-1.5 [&::-webkit-details-marker]:hidden">
              <span className="text-zinc-400 group-open/log:rotate-90 transition-transform inline-block">
                ▸
              </span>
              Activity log ({progress.length})
            </summary>
            <ul className="mt-2 max-h-36 overflow-y-auto space-y-1 text-[10px] text-zinc-600 font-mono border-t border-zinc-200/80 pt-2">
              {progress.map((p, i) => (
                <li key={`${p.at}-${i}`}>
                  <span className="text-zinc-400">{p.stage}</span> — {p.message}
                </li>
              ))}
              {!progress.length ? (
                <li className="text-zinc-400">No events yet — start a run or continue from a pause.</li>
              ) : null}
            </ul>
          </details>
        </OutputPanel>

        {discovery ? (
          <OutputPanel title="Discovery" cardClassName="border-zinc-200 bg-white">
            <div className="max-h-64 overflow-y-auto">
              <MarkdownBody content={discovery} />
            </div>
          </OutputPanel>
        ) : null}

        {treeReviewNotes ? (
          <OutputPanel
            title={<span className="text-blue-950">Manager MECE review</span>}
            subtitle={
              <p className="text-xs text-blue-900/75">
                Review of the draft issue tree before per-branch analysis. The MECE outline below reflects the
                revised tree.
              </p>
            }
            cardClassName="border-blue-200 bg-blue-50/90"
          >
            <MarkdownBody content={treeReviewNotes} />
          </OutputPanel>
        ) : null}

        {roots.length ? (
          <OutputPanel title="MECE outline & analysis" cardClassName="border-zinc-200 bg-white">
            <ul className="space-y-1">
              {roots.map((r) => (
                <OutlineBranch key={r.id} node={r} states={nodeStates} />
              ))}
            </ul>
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
            <MarkdownBody content={synthesis} />
          </OutputPanel>
        ) : null}
      </div>

      <aside className="space-y-4">
        <OutputPanel
          title="Memory"
          subtitle={
            <p className="text-xs text-zinc-600">
              Click an entry to load the full discovery, outline, and synthesis in the main panel. Summaries
              are also fed into the next discovery pass.
            </p>
          }
          cardClassName="border-zinc-200 bg-zinc-50/80"
        >
          <ul className="space-y-3 max-h-[70vh] overflow-y-auto">
            {memory.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void openMemoryEntry(m)}
                  className={`w-full text-left text-xs border rounded-lg p-2 transition-colors ${
                    selectedMemoryId === m.id
                      ? "border-emerald-500 bg-emerald-50/90 ring-1 ring-emerald-200"
                      : "border-zinc-200 bg-white hover:bg-zinc-50 hover:border-zinc-300"
                  } ${busy ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  <div className="font-medium text-zinc-900 line-clamp-2">{m.title}</div>
                  {m.topics ? (
                    <div className="text-zinc-500 mt-1 text-[10px] uppercase tracking-wide">
                      {m.topics}
                    </div>
                  ) : null}
                  <p className="text-zinc-600 mt-1 line-clamp-4">{m.summary}</p>
                  <span className="sr-only">Open saved run</span>
                </button>
              </li>
            ))}
            {!memory.length ? (
              <li className="text-zinc-500 text-xs">No saved analyses yet.</li>
            ) : null}
          </ul>
        </OutputPanel>
      </aside>
    </div>
  );
}
