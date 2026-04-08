import { prisma } from "./db";
import {
  analysisPrompt,
  discoveryPrompt,
  managerPrompt,
  partialManagerPrompt,
  partialSynthesisPrompt,
  structurePrompt,
  synthesisPrompt,
} from "./agents/prompts";
import { generateJson, generateText } from "./genai";
import { flattenLeaves, initNodeStates, pathToNode } from "./outline";
import type { OutlineNode, NodeState, ProgressEntry, StreamEvent } from "./types";

type OutlineDoc = { roots: OutlineNode[] };

type AnalysisJson = {
  summary: string;
  analysis: string;
  hypothesis: string | null;
  evidence_needed: string[];
  confidence: string;
};

export type StreamSender = (event: StreamEvent) => void;

async function appendProgress(runId: string, stage: string, message: string) {
  const run = await prisma.strategyRun.findUniqueOrThrow({ where: { id: runId } });
  const raw = run.progressLog;
  const log: ProgressEntry[] = Array.isArray(raw)
    ? (raw as unknown as ProgressEntry[])
    : [];
  const entry: ProgressEntry = {
    at: new Date().toISOString(),
    stage,
    message,
  };
  log.push(entry);
  await prisma.strategyRun.update({
    where: { id: runId },
    data: { progressLog: log },
  });
  return entry;
}

/** Read and clear a pending user control (pause / redirect request). */
async function consumeControl(
  runId: string,
): Promise<{ action: string; note: string | null } | null> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.strategyRun.findUnique({ where: { id: runId } });
    if (!run?.controlAction) return null;
    const payload = { action: run.controlAction, note: run.controlNote };
    await tx.strategyRun.update({
      where: { id: runId },
      data: { controlAction: null, controlNote: null },
    });
    return payload;
  });
}

async function recordRedirect(runId: string, note: string, send: StreamSender) {
  const run = await prisma.strategyRun.findUniqueOrThrow({ where: { id: runId } });
  const stamp = new Date().toISOString();
  const block = `\n### User redirect (${stamp})\n${note}`;
  const merged = ((run.redirectContext || "") + block).slice(-20000);
  await prisma.strategyRun.update({
    where: { id: runId },
    data: { redirectContext: merged },
  });
  send({ type: "redirect_ack", note });
  const entry = await appendProgress(
    runId,
    "redirect",
    `Steering: ${note.slice(0, 100)}${note.length > 100 ? "…" : ""}`,
  );
  send({ type: "progress", entry });
}

async function priorAnalysesBlock(): Promise<string> {
  const artifacts = await prisma.memoryArtifact.findMany({
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { title: true, summary: true, topics: true },
  });
  if (!artifacts.length) return "";
  return artifacts
    .map(
      (a) =>
        `#### ${a.title}\nTopics: ${a.topics || "—"}\n${a.summary}`,
    )
    .join("\n\n");
}

function analysesMarkdown(
  roots: OutlineNode[],
  states: Record<string, NodeState>,
): string {
  if (!roots.length) return "(No MECE outline yet — discovery only.)";
  const leaves = flattenLeaves(roots);
  return leaves
    .map((leaf) => {
      const st = states[leaf.id];
      const path = pathToNode(roots, leaf.id).join(" > ");
      return `### ${path}\nQuestion: ${leaf.question ?? leaf.title}\n\n${st?.analysis ?? "(pending)"}`;
    })
    .join("\n\n---\n\n");
}

/** Early stop: partial manager + synthesis, memory, complete. */
async function finalizePartialSynthesis(
  runId: string,
  send: StreamSender,
  userNote: string | null,
) {
  const run = await prisma.strategyRun.findUniqueOrThrow({ where: { id: runId } });
  const discoveryText = run.discoveryOutput ?? "";
  const outline = run.outline as OutlineDoc | null;
  const roots = outline?.roots ?? [];
  const states = { ...((run.nodeStates as Record<string, NodeState> | null) ?? {}) };

  if (roots.length) {
    const leaves = flattenLeaves(roots);
    for (const leaf of leaves) {
      const st = states[leaf.id];
      if (!st || st.status !== "done") {
        states[leaf.id] = {
          id: leaf.id,
          status: "skipped",
          summary: "Not analyzed (user requested early synthesis)",
        };
      }
    }
    await prisma.strategyRun.update({
      where: { id: runId },
      data: { nodeStates: states as object },
    });
    for (const st of Object.values(states)) {
      send({ type: "node", state: st });
    }
  }

  const entryStart = await appendProgress(
    runId,
    "pause",
    "Generating partial synthesis from work so far…",
  );
  send({ type: "progress", entry: entryStart });

  const analysesMd = analysesMarkdown(roots, states);
  const managerNotes = await generateText(
    partialManagerPrompt({
      userGoal: run.prompt,
      discovery: discoveryText,
      analysesMarkdown: analysesMd,
    }),
  );
  await prisma.strategyRun.update({
    where: { id: runId },
    data: { managerNotes },
  });
  send({ type: "manager", notes: managerNotes });

  const synthesis = await generateText(
    partialSynthesisPrompt({
      userGoal: run.prompt,
      discovery: discoveryText,
      managerNotes,
      analysesMarkdown: analysesMd,
      userInstruction: userNote ?? undefined,
    }),
  );
  await prisma.strategyRun.update({
    where: { id: runId },
    data: {
      synthesis,
      synthesisIsPartial: true,
      status: "complete",
    },
  });
  send({ type: "synthesis", text: synthesis, partial: true });

  const entryDone = await appendProgress(runId, "complete", "Partial run finished");
  send({ type: "progress", entry: entryDone });

  const topics = roots.length
    ? roots
        .map((r) => r.title)
        .slice(0, 8)
        .join(", ")
    : "partial";
  await prisma.memoryArtifact.create({
    data: {
      title: `${run.prompt.slice(0, 180)}${run.prompt.length > 180 ? "…" : ""} (partial)`,
      summary: synthesis.slice(0, 4000),
      topics,
      payload: {
        runId,
        outline,
        nodeStates: states,
        discovery: discoveryText,
        managerNotes,
        synthesis,
        synthesisIsPartial: true,
      },
      runId,
    },
  });

  send({ type: "complete", runId });
}

async function replayCompleted(runId: string, send: StreamSender) {
  const run = await prisma.strategyRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.discoveryOutput) {
    send({ type: "discovery", text: run.discoveryOutput });
  }
  const outline = run.outline as OutlineDoc | null;
  if (outline?.roots) {
    send({ type: "outline", roots: outline.roots });
  }
  const states = (run.nodeStates as Record<string, NodeState> | null) ?? {};
  for (const st of Object.values(states)) {
    send({ type: "node", state: st });
  }
  if (run.managerNotes) {
    send({ type: "manager", notes: run.managerNotes });
  }
  if (run.synthesis) {
    send({
      type: "synthesis",
      text: run.synthesis,
      partial: run.synthesisIsPartial,
    });
  }
  send({ type: "complete", runId });
}

export async function executeRun(runId: string, send: StreamSender) {
  const run = await prisma.strategyRun.findUnique({ where: { id: runId } });
  if (!run) {
    send({ type: "error", message: "Run not found" });
    return;
  }

  if (run.status === "complete") {
    await replayCompleted(runId, send);
    return;
  }

  if (run.status === "running") {
    send({
      type: "error",
      message:
        "This run is already executing (another connection may be active). Open a new run or wait.",
    });
    return;
  }

  const lock = await prisma.strategyRun.updateMany({
    where: { id: runId, status: "pending" },
    data: { status: "running", error: null, synthesisIsPartial: false },
  });

  if (lock.count === 0) {
    send({ type: "error", message: "Run could not be started." });
    return;
  }

  const emit = async (stage: string, message: string) => {
    const entry = await appendProgress(runId, stage, message);
    send({ type: "progress", entry });
  };

  try {
    await emit("manager", "Starting pipeline — discovery phase");

    const prior = await priorAnalysesBlock();
    const discoveryInput = discoveryPrompt({
      userGoal: run.prompt,
      companyContext: run.companyContext,
      priorAnalyses: prior,
    });
    const discoveryText = await generateText(discoveryInput);
    await prisma.strategyRun.update({
      where: { id: runId },
      data: { discoveryOutput: discoveryText },
    });
    send({ type: "discovery", text: discoveryText });
    await emit("discovery", "Discovery draft saved");

    let ctrl = await consumeControl(runId);
    if (ctrl?.action === "synthesize_now") {
      await finalizePartialSynthesis(runId, send, ctrl.note);
      return;
    }
    if (ctrl?.action === "redirect" && ctrl.note?.trim()) {
      await recordRedirect(runId, ctrl.note.trim(), send);
    }

    await emit("structure", "Building MECE outline");
    const structureOut = await generateJson<OutlineDoc>(
      structurePrompt({
        userGoal: run.prompt,
        discovery: discoveryText,
      }),
      {
        repairHint:
          'One object with key "roots" (array). Each node: "id" (string), "title", "question", "children" (array; use [] on leaves). Internal nodes must have non-empty children.',
      },
    );
    if (!structureOut?.roots?.length) {
      throw new Error("Structure agent returned no roots");
    }
    const roots = structureOut.roots;
    const states: Record<string, NodeState> = initNodeStates(roots) as Record<
      string,
      NodeState
    >;
    await prisma.strategyRun.update({
      where: { id: runId },
      data: {
        outline: structureOut as object,
        nodeStates: states as object,
      },
    });
    send({ type: "outline", roots });
    await emit("structure", `Outline ready (${flattenLeaves(roots).length} leaves)`);

    ctrl = await consumeControl(runId);
    if (ctrl?.action === "synthesize_now") {
      await finalizePartialSynthesis(runId, send, ctrl.note);
      return;
    }
    if (ctrl?.action === "redirect" && ctrl.note?.trim()) {
      await recordRedirect(runId, ctrl.note.trim(), send);
    }

    const leaves = flattenLeaves(roots);
    for (const leaf of leaves) {
      ctrl = await consumeControl(runId);
      if (ctrl?.action === "synthesize_now") {
        await finalizePartialSynthesis(runId, send, ctrl.note);
        return;
      }
      if (ctrl?.action === "redirect" && ctrl.note?.trim()) {
        await recordRedirect(runId, ctrl.note.trim(), send);
      }

      const redirectRow = await prisma.strategyRun.findUniqueOrThrow({
        where: { id: runId },
        select: { redirectContext: true },
      });

      states[leaf.id] = { ...states[leaf.id], status: "running" };
      await prisma.strategyRun.update({
        where: { id: runId },
        data: { nodeStates: states as object },
      });
      send({ type: "node", state: states[leaf.id] });
      await emit("analysis", `Analyzing: ${leaf.title}`);

      const pathTitles = pathToNode(roots, leaf.id).join(" > ");
      const parsed = await generateJson<AnalysisJson>(
        analysisPrompt({
          userGoal: run.prompt,
          discovery: discoveryText,
          pathTitles,
          leafQuestion: leaf.question ?? leaf.title,
          redirectContext: redirectRow.redirectContext || undefined,
        }),
        {
          repairHint:
            'Exactly these keys: "summary" (string), "analysis" (string), "hypothesis" (string or null), "evidence_needed" (array of strings), "confidence" (string: low, medium, or high).',
        },
      );
      const block = [
        parsed.analysis,
        parsed.hypothesis ? `\n\nHypothesis: ${parsed.hypothesis}` : "",
        `\n\nConfidence: ${parsed.confidence}`,
        parsed.evidence_needed?.length
          ? `\nEvidence needed: ${parsed.evidence_needed.join("; ")}`
          : "",
      ].join("");

      states[leaf.id] = {
        id: leaf.id,
        status: "done",
        summary: parsed.summary,
        analysis: block.trim(),
      };
      await prisma.strategyRun.update({
        where: { id: runId },
        data: { nodeStates: states as object },
      });
      send({ type: "node", state: states[leaf.id] });
    }

    await emit("manager", "Pressure-testing analysis");
    const analysesMd = analysesMarkdown(roots, states);
    const managerNotes = await generateText(
      managerPrompt({
        userGoal: run.prompt,
        discovery: discoveryText,
        analysesMarkdown: analysesMd,
      }),
    );
    await prisma.strategyRun.update({
      where: { id: runId },
      data: { managerNotes },
    });
    send({ type: "manager", notes: managerNotes });

    await emit("synthesis", "Writing final memo");
    const synthesis = await generateText(
      synthesisPrompt({
        userGoal: run.prompt,
        discovery: discoveryText,
        managerNotes,
        analysesMarkdown: analysesMd,
      }),
    );
    await prisma.strategyRun.update({
      where: { id: runId },
      data: { synthesis, status: "complete", synthesisIsPartial: false },
    });
    send({ type: "synthesis", text: synthesis, partial: false });
    await emit("complete", "Run finished");

    const topics = roots
      .map((r) => r.title)
      .slice(0, 8)
      .join(", ");
    await prisma.memoryArtifact.create({
      data: {
        title: run.prompt.slice(0, 200),
        summary: synthesis.slice(0, 4000),
        topics,
        payload: {
          runId,
          outline: structureOut,
          nodeStates: states,
          discovery: discoveryText,
          managerNotes,
          synthesis,
          synthesisIsPartial: false,
        },
        runId,
      },
    });

    send({ type: "complete", runId });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.strategyRun.update({
      where: { id: runId },
      data: { status: "failed", error: message },
    });
    send({ type: "error", message });
    await appendProgress(runId, "error", message);
  }
}
