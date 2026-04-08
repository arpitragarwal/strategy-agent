"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { flattenLeaves } from "@/lib/outline";
import type { OutlineNode, NodeState, ProgressEntry } from "@/lib/types";

type RunRow = {
  id: string;
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

  const startRun = async () => {
    if (!prompt.trim() || busy) return;
    resetOutput();
    setBusy(true);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? res.statusText);
      }
      const { id } = await res.json();
      setRunId(id);

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
            case "complete":
              src.close();
              setBusy(false);
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
        setError((prev) => prev ?? "Stream connection lost");
      };
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const leavesTotal = useMemo(() => {
    if (roots.length) return flattenLeaves(roots).length;
    return Object.keys(nodeStates).length;
  }, [roots, nodeStates]);

  const leavesDone = useMemo(
    () => Object.values(nodeStates).filter((v) => v.status === "done").length,
    [nodeStates],
  );

  const sendControl = async (action: "synthesize_now" | "redirect", note?: string) => {
    if (!runId || !busy) return;
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
      setControlMessage("Stopping after current step — partial synthesis will stream next.");
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
            Strategy team prototype
          </h1>
          <p className="text-zinc-600 text-sm mt-1">
            Manager, discovery, structure, analysis, synthesis — streamed into a live outline.
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
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void startRun()}
              disabled={busy || !prompt.trim()}
              className="rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white text-sm font-medium px-4 py-2 transition-colors"
            >
              {busy ? "Running…" : "Run strategy pipeline"}
            </button>
            {runId ? (
              <span className="text-xs text-zinc-500 font-mono break-all">run {runId}</span>
            ) : null}
          </div>

          {busy && runId ? (
            <div className="rounded-lg border border-sky-200 bg-sky-50/80 p-3 space-y-2">
              <p className="text-xs font-medium text-sky-900 uppercase tracking-wide">
                Steer while running
              </p>
              <p className="text-xs text-sky-800/90">
                Pause is checked between steps (and before each leaf). The in-flight model call always
                finishes first.
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

        <section className="rounded-xl border border-zinc-200 bg-zinc-50/80 p-4 shadow-sm">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-semibold text-zinc-900">Live progress</h2>
            {leavesTotal > 0 ? (
              <span className="text-xs text-zinc-500">
                Leaves {leavesDone}/{leavesTotal}
              </span>
            ) : null}
          </div>
          <ul className="max-h-40 overflow-y-auto space-y-1 text-xs text-zinc-600 font-mono">
            {progress.map((p, i) => (
              <li key={`${p.at}-${i}`}>
                <span className="text-zinc-500">{p.stage}</span> — {p.message}
              </li>
            ))}
            {!progress.length ? <li className="text-zinc-500">Waiting to start…</li> : null}
          </ul>
        </section>

        {discovery ? (
          <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-zinc-900 mb-2">Discovery</h2>
            <div className="max-h-64 overflow-y-auto">
              <MarkdownBody content={discovery} />
            </div>
          </section>
        ) : null}

        {treeReviewNotes ? (
          <section className="rounded-xl border border-blue-200 bg-blue-50/90 p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-blue-950 mb-1">Manager MECE review</h2>
            <p className="text-xs text-blue-900/75 mb-3">
              Review of the draft issue tree before leaf-level analysis. The MECE outline below reflects the
              revised tree.
            </p>
            <MarkdownBody content={treeReviewNotes} />
          </section>
        ) : null}

        {roots.length ? (
          <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-zinc-900 mb-3">MECE outline & analysis</h2>
            <ul className="space-y-1">
              {roots.map((r) => (
                <OutlineBranch key={r.id} node={r} states={nodeStates} />
              ))}
            </ul>
          </section>
        ) : null}

        {managerNotes ? (
          <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <h2 className="text-sm font-semibold text-amber-900 mb-2">Manager critique (analyses)</h2>
            <MarkdownBody content={managerNotes} />
          </section>
        ) : null}

        {synthesis ? (
          <section className="rounded-xl border border-emerald-200 bg-emerald-50/80 p-4">
            <h2 className="text-sm font-semibold text-emerald-900 mb-2">
              Synthesis
              {synthesisPartial ? (
                <span className="ml-2 text-xs font-normal text-amber-800">(partial — stopped early)</span>
              ) : null}
            </h2>
            <MarkdownBody content={synthesis} />
          </section>
        ) : null}
      </div>

      <aside className="space-y-4">
        <div className="rounded-xl border border-zinc-200 bg-zinc-50/80 p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-zinc-900 mb-2">Memory</h2>
          <p className="text-xs text-zinc-600 mb-3">
            Click an entry to load the full discovery, outline, and synthesis in the main panel.
            Summaries are also fed into the next discovery pass.
          </p>
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
        </div>
      </aside>
    </div>
  );
}
