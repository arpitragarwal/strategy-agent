"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { flattenLeaves } from "@/lib/outline";
import type { OutlineNode, NodeState, ProgressEntry } from "@/lib/types";

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
          <div className="font-medium text-zinc-100">{node.title}</div>
          {node.question ? (
            <div className="text-zinc-500 text-xs mt-0.5">{node.question}</div>
          ) : null}
          {state?.summary ? (
            <p className="text-zinc-400 text-xs mt-1 leading-relaxed">{state.summary}</p>
          ) : null}
        </div>
      </div>
      {hasKids && node.children ? (
        <ul className="ml-4 mt-1 border-l border-zinc-800 pl-3">
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
  const [companyContext, setCompanyContext] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [discovery, setDiscovery] = useState("");
  const [roots, setRoots] = useState<OutlineNode[]>([]);
  const [nodeStates, setNodeStates] = useState<Record<string, NodeState>>({});
  const [managerNotes, setManagerNotes] = useState("");
  const [synthesis, setSynthesis] = useState("");
  const [synthesisPartial, setSynthesisPartial] = useState(false);
  const [redirectNote, setRedirectNote] = useState("");
  const [controlMessage, setControlMessage] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryRow[]>([]);

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
    setRoots([]);
    setNodeStates({});
    setManagerNotes("");
    setSynthesis("");
    setSynthesisPartial(false);
    setControlMessage(null);
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
          companyContext: companyContext.trim(),
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
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">
            Strategy team prototype
          </h1>
          <p className="text-zinc-500 text-sm mt-1">
            Manager, discovery, structure, analysis, synthesis — streamed into a live outline.
          </p>
        </header>

        <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4 space-y-3">
          <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
            Goal / question
          </label>
          <textarea
            className="w-full min-h-[88px] rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
            placeholder="e.g. Should we enter the EU market in the next 18 months?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={busy}
          />
          <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
            Company context (paste KB notes, metrics, constraints)
          </label>
          <textarea
            className="w-full min-h-[120px] rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
            placeholder="Short internal context the discovery agent should treat like a knowledge snapshot."
            value={companyContext}
            onChange={(e) => setCompanyContext(e.target.value)}
            disabled={busy}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void startRun()}
              disabled={busy || !prompt.trim()}
              className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-zinc-950 text-sm font-medium px-4 py-2 transition-colors"
            >
              {busy ? "Running…" : "Run strategy pipeline"}
            </button>
            {runId ? (
              <span className="text-xs text-zinc-500 font-mono">run {runId}</span>
            ) : null}
          </div>

          {busy && runId ? (
            <div className="rounded-lg border border-zinc-700 bg-zinc-900/60 p-3 space-y-2">
              <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
                Steer while running
              </p>
              <p className="text-xs text-zinc-500">
                Pause is checked between steps (and before each leaf). The in-flight model call always
                finishes first.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void sendControl("synthesize_now")}
                  className="rounded-md bg-sky-700 hover:bg-sky-600 text-white text-xs font-medium px-3 py-1.5"
                >
                  Synthesize so far
                </button>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="flex-1 block text-xs text-zinc-500">
                  Redirect / steering note (applied to remaining leaves)
                  <textarea
                    className="mt-1 w-full min-h-[64px] rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
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
                  className="rounded-md bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-white text-xs font-medium px-3 py-1.5 sm:mb-0.5"
                >
                  Apply redirect
                </button>
              </div>
              {controlMessage ? (
                <p className="text-xs text-amber-200/90">{controlMessage}</p>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p className="text-sm text-rose-400 border border-rose-900/50 rounded-lg px-3 py-2 bg-rose-950/20">
              {error}
            </p>
          ) : null}
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-semibold text-zinc-200">Live progress</h2>
            {leavesTotal > 0 ? (
              <span className="text-xs text-zinc-500">
                Leaves {leavesDone}/{leavesTotal}
              </span>
            ) : null}
          </div>
          <ul className="max-h-40 overflow-y-auto space-y-1 text-xs text-zinc-400 font-mono">
            {progress.map((p, i) => (
              <li key={`${p.at}-${i}`}>
                <span className="text-zinc-600">{p.stage}</span> — {p.message}
              </li>
            ))}
            {!progress.length ? <li className="text-zinc-600">Waiting to start…</li> : null}
          </ul>
        </section>

        {discovery ? (
          <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
            <h2 className="text-sm font-semibold text-zinc-200 mb-2">Discovery</h2>
            <div className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">
              {discovery}
            </div>
          </section>
        ) : null}

        {roots.length ? (
          <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
            <h2 className="text-sm font-semibold text-zinc-200 mb-3">MECE outline & analysis</h2>
            <ul className="space-y-1">
              {roots.map((r) => (
                <OutlineBranch key={r.id} node={r} states={nodeStates} />
              ))}
            </ul>
          </section>
        ) : null}

        {managerNotes ? (
          <section className="rounded-xl border border-amber-900/40 bg-amber-950/10 p-4">
            <h2 className="text-sm font-semibold text-amber-200/90 mb-2">Manager critique</h2>
            <div className="text-sm text-amber-100/80 whitespace-pre-wrap leading-relaxed">
              {managerNotes}
            </div>
          </section>
        ) : null}

        {synthesis ? (
          <section className="rounded-xl border border-emerald-900/40 bg-emerald-950/10 p-4">
            <h2 className="text-sm font-semibold text-emerald-200/90 mb-2">
              Synthesis
              {synthesisPartial ? (
                <span className="ml-2 text-xs font-normal text-amber-300/90">(partial — stopped early)</span>
              ) : null}
            </h2>
            <div className="text-sm text-emerald-50/90 whitespace-pre-wrap leading-relaxed">
              {synthesis}
            </div>
          </section>
        ) : null}
      </div>

      <aside className="space-y-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
          <h2 className="text-sm font-semibold text-zinc-200 mb-2">Memory</h2>
          <p className="text-xs text-zinc-500 mb-3">
            Recent runs are summarized here for the next discovery pass.
          </p>
          <ul className="space-y-3 max-h-[70vh] overflow-y-auto">
            {memory.map((m) => (
              <li
                key={m.id}
                className="text-xs border border-zinc-800 rounded-lg p-2 bg-zinc-900/40"
              >
                <div className="font-medium text-zinc-200 line-clamp-2">{m.title}</div>
                {m.topics ? (
                  <div className="text-zinc-600 mt-1 text-[10px] uppercase tracking-wide">
                    {m.topics}
                  </div>
                ) : null}
                <p className="text-zinc-500 mt-1 line-clamp-4">{m.summary}</p>
              </li>
            ))}
            {!memory.length ? (
              <li className="text-zinc-600 text-xs">No saved analyses yet.</li>
            ) : null}
          </ul>
        </div>
      </aside>
    </div>
  );
}
