import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import {
  analysisPrompt,
  discoveryPrompt,
  managerMeceReviewPrompt,
  managerPrompt,
  partialManagerPrompt,
  partialSynthesisPrompt,
  STRUCTURE_RETRY_SUFFIX,
  STRUCTURE_REVISION_RETRY_SUFFIX,
  structurePrompt,
  structureRevisionPrompt,
  synthesisPrompt,
} from "./agents/prompts";
import { generateJson, generateText } from "./genai";
import {
  type OutlineDoc,
  flattenLeaves,
  initNodeStates,
  normalizeOutlineDoc,
  pathToNode,
} from "./outline";
import { buildDataCatalogMarkdown, executeQuantPlan } from "./quant";
import type { QuantPlan } from "./quant/types";
import type {
  OutlineNode,
  NodeState,
  ProgressEntry,
  ReviewCheckpoint,
  StreamEvent,
} from "./types";

const DATA_CATALOG_MARKDOWN = buildDataCatalogMarkdown();

type AnalysisJson = {
  summary: string;
  analysis: string;
  hypothesis: string | null;
  evidence_needed: string[];
  confidence: string;
  quant?: QuantPlan | null;
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

function isPayloadRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

const MAX_PRIOR_BLOCK_CHARS = 14_000;

/** Text for discovery only: synthesis, manager critique, leaf analyses — never old user prompts or titles. */
function memoryArtifactToDiscoveryBlock(payload: unknown, summaryFallback: string): string {
  const parts: string[] = [];
  const p = isPayloadRecord(payload) ? payload : null;

  const synthesis = typeof p?.synthesis === "string" ? p.synthesis.trim() : "";
  if (synthesis) {
    parts.push(
      `**Strategy memo (excerpt)**\n${synthesis.slice(0, 3200)}${synthesis.length > 3200 ? "…" : ""}`,
    );
  } else if (summaryFallback.trim()) {
    parts.push(`**Strategy memo (excerpt)**\n${summaryFallback.trim()}`);
  }

  const managerNotes = typeof p?.managerNotes === "string" ? p.managerNotes.trim() : "";
  if (managerNotes) {
    parts.push(
      `**Manager critique (post-analysis)**\n${managerNotes.slice(0, 2200)}${managerNotes.length > 2200 ? "…" : ""}`,
    );
  }

  const outlineDoc = normalizeOutlineDoc(p?.outline);
  const statesRaw = p?.nodeStates;
  if (outlineDoc?.roots && isPayloadRecord(statesRaw)) {
    const leaves = flattenLeaves(outlineDoc.roots);
    const leafBits: string[] = [];
    for (const leaf of leaves) {
      const raw = statesRaw[leaf.id];
      if (!isPayloadRecord(raw)) continue;
      const analysis = typeof raw.analysis === "string" ? raw.analysis.trim() : "";
      if (!analysis) continue;
      const path = pathToNode(outlineDoc.roots, leaf.id).join(" > ");
      leafBits.push(
        `*${path}*\n${analysis.slice(0, 1200)}${analysis.length > 1200 ? "…" : ""}`,
      );
    }
    if (leafBits.length) {
      parts.push(`**Branch analyses (write-ups only)**\n${leafBits.join("\n\n")}`);
    }
  }

  return parts.join("\n\n");
}

function memoryArtifactLabel(runId: string, createdAt: Date, partial: boolean): string {
  const d = createdAt.toISOString().slice(0, 10);
  const tail = runId.length >= 6 ? runId.slice(-6) : runId;
  return partial ? `Saved analysis (partial) · ${d} · ${tail}` : `Saved analysis · ${d} · ${tail}`;
}

async function priorAnalysesBlock(): Promise<string> {
  const artifacts = await prisma.memoryArtifact.findMany({
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { summary: true, payload: true, runId: true, createdAt: true },
  });
  if (!artifacts.length) return "";

  const blocks: string[] = [];
  for (let i = 0; i < artifacts.length; i++) {
    const a = artifacts[i]!;
    const body = memoryArtifactToDiscoveryBlock(a.payload, a.summary);
    if (!body.trim()) continue;
    const partial =
      isPayloadRecord(a.payload) && a.payload.synthesisIsPartial === true;
    const label =
      a.runId ?
        memoryArtifactLabel(a.runId, a.createdAt, partial)
      : `Saved output ${i + 1} · ${a.createdAt.toISOString().slice(0, 10)}`;
    blocks.push(`---\n_${label}_\n\n${body}`);
  }

  const merged = blocks.join("\n\n");
  if (merged.length <= MAX_PRIOR_BLOCK_CHARS) return merged;
  return `${merged.slice(0, MAX_PRIOR_BLOCK_CHARS)}\n\n_(older memory truncated)_`;
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
      let q = "";
      if (st?.quant) {
        if (st.quant.error) {
          q = `\n\n_Quant error: ${st.quant.error}_`;
        } else if (st.quant.narrative) {
          q = `\n\n_Quant (${st.quant.datasetId ?? "dataset"}): ${st.quant.narrative}_`;
        }
      }
      return `### ${path}\nQuestion: ${leaf.question ?? leaf.title}\n\n${st?.analysis ?? "(pending)"}${q}`;
    })
    .join("\n\n---\n\n");
}

async function pauseForHumanReview(
  runId: string,
  send: StreamSender,
  checkpoint: ReviewCheckpoint,
) {
  const run = await prisma.strategyRun.findUnique({
    where: { id: runId },
    select: { runMode: true },
  });
  if (run?.runMode === "end_to_end") {
    return;
  }

  const title =
    checkpoint === "after_discovery"
      ? "Discovery"
      : checkpoint === "after_structure"
        ? "revised MECE structure"
        : "analyses";
  const entry = await appendProgress(
    runId,
    "pause",
    `Paused — review ${title}. Click Continue when ready.`,
  );
  send({ type: "progress", entry });
  await prisma.strategyRun.update({
    where: { id: runId },
    data: {
      status: "awaiting_review",
      reviewCheckpoint: checkpoint,
    },
  });
  send({ type: "awaiting_review", checkpoint });
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
      reviewCheckpoint: null,
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
      title: memoryArtifactLabel(runId, run.createdAt, true),
      summary: synthesis.slice(0, 4000),
      topics,
      runStartedAt: run.createdAt,
      payload: {
        runId,
        userPrompt: run.prompt,
        outline,
        treeReviewNotes: run.treeReviewNotes,
        nodeStates: states,
        discovery: discoveryText,
        managerNotes,
        synthesis,
        synthesisIsPartial: true,
        runStartedAt: run.createdAt.toISOString(),
      } as Prisma.InputJsonValue,
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
  if (run.treeReviewNotes) {
    send({ type: "tree_review", notes: run.treeReviewNotes });
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

async function runDiscoveryPhase(
  runId: string,
  send: StreamSender,
  emit: (stage: string, message: string) => Promise<void>,
) {
  const run = await prisma.strategyRun.findUniqueOrThrow({ where: { id: runId } });
  await emit("manager", "Starting pipeline — discovery phase");
  const prior = await priorAnalysesBlock();
  const discoveryInput = discoveryPrompt({
    prompt: run.prompt,
    priorAnalyses: prior,
  });
  const discoveryText = await generateText(discoveryInput);
  await prisma.strategyRun.update({
    where: { id: runId },
    data: { discoveryOutput: discoveryText },
  });
  send({ type: "discovery", text: discoveryText });
  await emit("discovery", "Discovery draft saved");
  await pauseForHumanReview(runId, send, "after_discovery");
}

async function runStructureRevisionPhase(
  runId: string,
  send: StreamSender,
  emit: (stage: string, message: string) => Promise<void>,
) {
  const run = await prisma.strategyRun.findUniqueOrThrow({ where: { id: runId } });
  const discoveryText = run.discoveryOutput ?? "";
  if (!discoveryText) {
    throw new Error("Discovery output missing — cannot build structure.");
  }

  await emit("structure", "Building initial MECE outline");
  const structureRepairHint =
    'One object with key "roots" (array). Each node: "id" (string), "title", "question", "children" (array; use [] on leaves). Internal nodes must have non-empty children.';

  const raw1 = await generateJson<OutlineDoc>(
    structurePrompt({
      userGoal: run.prompt,
      discovery: discoveryText,
    }),
    { repairHint: structureRepairHint },
  );
  let outlineDoc = normalizeOutlineDoc(raw1);
  const leafCount = (doc: OutlineDoc | null) =>
    doc ? flattenLeaves(doc.roots).length : 0;

  if (!outlineDoc?.roots?.length || leafCount(outlineDoc) === 0) {
    await emit("structure", "Retrying — model returned empty or unusable roots");
    const raw2 = await generateJson<OutlineDoc>(
      structurePrompt({
        userGoal: run.prompt,
        discovery: discoveryText,
      }) + STRUCTURE_RETRY_SUFFIX,
      { repairHint: structureRepairHint },
    );
    outlineDoc = normalizeOutlineDoc(raw2);
  }

  if (!outlineDoc?.roots?.length || leafCount(outlineDoc) === 0) {
    throw new Error(
      "Structure agent returned no usable MECE tree (no roots or no leaf nodes). Try again or shorten the goal.",
    );
  }

  const firstOutline = outlineDoc;
  let roots = firstOutline.roots;
  let states: Record<string, NodeState> = initNodeStates(roots) as Record<
    string,
    NodeState
  >;
  await prisma.strategyRun.update({
    where: { id: runId },
    data: {
      outline: firstOutline as object,
      nodeStates: states as object,
    },
  });
  send({ type: "outline", roots });
  await emit(
    "structure",
    `Initial outline (${flattenLeaves(roots).length} leaves) — manager MECE review`,
  );

  const treeReviewNotes = await generateText(
    managerMeceReviewPrompt({
      userGoal: run.prompt,
      discovery: discoveryText,
      outlineJson: JSON.stringify(firstOutline, null, 2),
    }),
  );
  await prisma.strategyRun.update({
    where: { id: runId },
    data: { treeReviewNotes },
  });
  send({ type: "tree_review", notes: treeReviewNotes });
  await emit("structure", "Revising MECE tree from manager feedback");

  const revisionRaw = await generateJson<OutlineDoc>(
    structureRevisionPrompt({
      userGoal: run.prompt,
      discovery: discoveryText,
      priorOutlineJson: JSON.stringify(firstOutline, null, 2),
      managerTreeFeedback: treeReviewNotes,
    }),
    { repairHint: structureRepairHint },
  );
  let revisedOutline = normalizeOutlineDoc(revisionRaw);
  if (!revisedOutline?.roots?.length || leafCount(revisedOutline) === 0) {
    await emit("structure", "Retrying tree revision JSON…");
    const revisionRaw2 = await generateJson<OutlineDoc>(
      structureRevisionPrompt({
        userGoal: run.prompt,
        discovery: discoveryText,
        priorOutlineJson: JSON.stringify(firstOutline, null, 2),
        managerTreeFeedback: treeReviewNotes,
      }) + STRUCTURE_REVISION_RETRY_SUFFIX,
      { repairHint: structureRepairHint },
    );
    revisedOutline = normalizeOutlineDoc(revisionRaw2);
  }

  let structureOut: OutlineDoc;
  if (!revisedOutline?.roots?.length || leafCount(revisedOutline) === 0) {
    const entry = await appendProgress(
      runId,
      "structure",
      "Revision did not produce a valid tree — keeping initial outline for analysis.",
    );
    send({ type: "progress", entry });
    structureOut = firstOutline;
  } else {
    structureOut = revisedOutline;
  }

  roots = structureOut.roots;
  states = initNodeStates(roots) as Record<string, NodeState>;
  await prisma.strategyRun.update({
    where: { id: runId },
    data: {
      outline: structureOut as object,
      nodeStates: states as object,
    },
  });
  send({ type: "outline", roots });
  const modeRow = await prisma.strategyRun.findUnique({
    where: { id: runId },
    select: { runMode: true },
  });
  const endToEnd = modeRow?.runMode === "end_to_end";
  await emit(
    "structure",
    endToEnd
      ? `Revised outline ready (${flattenLeaves(roots).length} leaves) — continuing`
      : `Revised outline ready (${flattenLeaves(roots).length} leaves) — awaiting your review`,
  );

  await pauseForHumanReview(runId, send, "after_structure");
}

async function runLeafAnalysisPhase(
  runId: string,
  send: StreamSender,
  emit: (stage: string, message: string) => Promise<void>,
) {
  const run = await prisma.strategyRun.findUniqueOrThrow({ where: { id: runId } });
  const discoveryText = run.discoveryOutput ?? "";
  const outline = run.outline as OutlineDoc | null;
  const roots = outline?.roots ?? [];
  if (!roots.length) {
    throw new Error("MECE outline missing — cannot analyze leaves.");
  }

  const states = { ...((run.nodeStates as Record<string, NodeState> | null) ?? {}) };
  const leaves = flattenLeaves(roots);

  for (const leaf of leaves) {
    const ctrl = await consumeControl(runId);
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
        dataCatalogMarkdown: DATA_CATALOG_MARKDOWN,
      }),
      {
        repairHint:
          'Keys: "summary" (string), "analysis" (string), "hypothesis" (string or null), "evidence_needed" (string array), "confidence" ("low"|"medium"|"high"), "quant" (null OR object with "hypothesis_under_test", "datasetId" from catalog, "steps" array of filter/groupby/sort/limit ops, optional "chart" null or {type bar|line, x, y}).',
      },
    );
    let quantResult = undefined;
    if (
      parsed.quant &&
      typeof parsed.quant === "object" &&
      typeof (parsed.quant as QuantPlan).datasetId === "string" &&
      Array.isArray((parsed.quant as QuantPlan).steps)
    ) {
      quantResult = executeQuantPlan(parsed.quant as QuantPlan);
    }

    const block = [
      parsed.analysis,
      parsed.hypothesis ? `\n\nHypothesis: ${parsed.hypothesis}` : "",
      `\n\nConfidence: ${parsed.confidence}`,
      parsed.evidence_needed?.length
        ? `\nEvidence needed: ${parsed.evidence_needed.join("; ")}`
        : "",
      quantResult?.narrative ? `\n\n**Quant:** ${quantResult.narrative}` : "",
      quantResult?.error ? `\n\n_Quant error: ${quantResult.error}_` : "",
    ].join("");

    states[leaf.id] = {
      id: leaf.id,
      status: "done",
      summary: parsed.summary,
      analysis: block.trim(),
      ...(quantResult ? { quant: quantResult } : {}),
    };
    await prisma.strategyRun.update({
      where: { id: runId },
      data: { nodeStates: states as object },
    });
    send({ type: "node", state: states[leaf.id] });
  }

  const modeRow = await prisma.strategyRun.findUnique({
    where: { id: runId },
    select: { runMode: true },
  });
  const endToEnd = modeRow?.runMode === "end_to_end";
  await emit(
    "analysis",
    endToEnd
      ? "All leaves analyzed — manager critique next"
      : "All leaves analyzed — awaiting your review",
  );
  await pauseForHumanReview(runId, send, "after_analysis");
}

async function runManagerAndSynthesisPhase(runId: string, send: StreamSender) {
  const run = await prisma.strategyRun.findUniqueOrThrow({ where: { id: runId } });
  const discoveryText = run.discoveryOutput ?? "";
  const structureOut = run.outline as OutlineDoc | null;
  const roots = structureOut?.roots ?? [];
  const states = (run.nodeStates as Record<string, NodeState> | null) ?? {};
  const treeReviewNotes = run.treeReviewNotes ?? "";

  const entry = await appendProgress(runId, "manager", "Pressure-testing analysis");
  send({ type: "progress", entry });

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

  const synEntry = await appendProgress(runId, "synthesis", "Writing final memo");
  send({ type: "progress", entry: synEntry });

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
    data: {
      synthesis,
      status: "complete",
      synthesisIsPartial: false,
      reviewCheckpoint: null,
    },
  });
  send({ type: "synthesis", text: synthesis, partial: false });
  const doneEntry = await appendProgress(runId, "complete", "Run finished");
  send({ type: "progress", entry: doneEntry });

  const topics = roots
    .map((r) => r.title)
    .slice(0, 8)
    .join(", ");
  await prisma.memoryArtifact.create({
    data: {
      title: memoryArtifactLabel(runId, run.createdAt, false),
      summary: synthesis.slice(0, 4000),
      topics,
      runStartedAt: run.createdAt,
      payload: {
        runId,
        userPrompt: run.prompt,
        outline: structureOut,
        treeReviewNotes,
        nodeStates: states,
        discovery: discoveryText,
        managerNotes,
        synthesis,
        synthesisIsPartial: false,
        runStartedAt: run.createdAt.toISOString(),
      } as Prisma.InputJsonValue,
      runId,
    },
  });

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

  if (run.status !== "pending" && run.status !== "awaiting_review") {
    send({
      type: "error",
      message: `Run cannot be executed (status: ${run.status}).`,
    });
    return;
  }

  const initialStatus = run.status;
  const initialCheckpoint = run.reviewCheckpoint;

  const lock = await prisma.strategyRun.updateMany({
    where: {
      id: runId,
      OR: [{ status: "pending" }, { status: "awaiting_review" }],
    },
    data: {
      status: "running",
      error: null,
      ...(initialStatus === "pending" ? { synthesisIsPartial: false } : {}),
    },
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
    if (initialStatus === "pending") {
      await runDiscoveryPhase(runId, send, emit);
      const afterDiscovery = await prisma.strategyRun.findUnique({
        where: { id: runId },
        select: { status: true, runMode: true },
      });
      if (afterDiscovery?.status !== "running") {
        return;
      }
      if (afterDiscovery.runMode === "end_to_end") {
        await runStructureRevisionPhase(runId, send, emit);
        const afterStructure = await prisma.strategyRun.findUnique({
          where: { id: runId },
          select: { status: true },
        });
        if (afterStructure?.status !== "running") {
          return;
        }
        await runLeafAnalysisPhase(runId, send, emit);
        const afterAnalysis = await prisma.strategyRun.findUnique({
          where: { id: runId },
          select: { status: true },
        });
        if (afterAnalysis?.status !== "running") {
          return;
        }
        await runManagerAndSynthesisPhase(runId, send);
      }
      return;
    }

    if (initialStatus === "awaiting_review" && initialCheckpoint === "after_discovery") {
      const ctrl = await consumeControl(runId);
      if (ctrl?.action === "synthesize_now") {
        await finalizePartialSynthesis(runId, send, ctrl.note);
        return;
      }
      if (ctrl?.action === "redirect" && ctrl.note?.trim()) {
        await recordRedirect(runId, ctrl.note.trim(), send);
      }
      await runStructureRevisionPhase(runId, send, emit);
      return;
    }

    if (initialStatus === "awaiting_review" && initialCheckpoint === "after_structure") {
      const ctrl = await consumeControl(runId);
      if (ctrl?.action === "synthesize_now") {
        await finalizePartialSynthesis(runId, send, ctrl.note);
        return;
      }
      if (ctrl?.action === "redirect" && ctrl.note?.trim()) {
        await recordRedirect(runId, ctrl.note.trim(), send);
      }
      await runLeafAnalysisPhase(runId, send, emit);
      return;
    }

    if (initialStatus === "awaiting_review" && initialCheckpoint === "after_analysis") {
      const ctrl = await consumeControl(runId);
      if (ctrl?.action === "synthesize_now") {
        await finalizePartialSynthesis(runId, send, ctrl.note);
        return;
      }
      await runManagerAndSynthesisPhase(runId, send);
      return;
    }

    send({ type: "error", message: "Unexpected run state — cannot resume." });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.strategyRun.update({
      where: { id: runId },
      data: { status: "failed", error: message, reviewCheckpoint: null },
    });
    send({ type: "error", message });
    await appendProgress(runId, "error", message);
  }
}
