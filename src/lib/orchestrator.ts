import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import {
  analysisPrompt,
  branchRollupPrompt,
  contextClarificationPlanPrompt,
  contextClarificationSynthesisPrompt,
  discoveryMemoryRoutePrompt,
  leafAnalysisRefinementPrompt,
  leafManagerReviewPrompt,
  managerMeceReviewPrompt,
  managerPrompt,
  partialManagerPrompt,
  partialSynthesisPrompt,
  STRUCTURE_RETRY_SUFFIX,
  STRUCTURE_REVISION_RETRY_SUFFIX,
  structurePrompt,
  structureRevisionPrompt,
  synthesisPrompt,
  type BranchRollupJson,
  type ContextClarificationPlanJson,
  type DiscoveryMemoryRoute,
  type LeafManagerReviewJson,
} from "./agents/prompts";
import { generateJson, generateText, getModelId } from "./genai";
import {
  mergeTokenUsageIntoStored,
  runTokenTrackingContext,
  RunTokenUsageAccumulator,
  withTokenPhase,
} from "./tokenUsage";
import {
  type OutlineDoc,
  flattenLeaves,
  initNodeStates,
  listAllNodeIds,
  normalizeOutlineDoc,
  pathToNode,
} from "./outline";
import {
  buildDataCatalogMarkdown,
  executeQuantPlan,
  listQuantDatasetIds,
  quantPlanReferencesValidDatasets,
} from "./quant";
import type { QuantPlan } from "./quant/types";
import { searchStrategyMemory } from "./strategyMemory";
import type {
  HypothesisVerdict,
  OutlineNode,
  NodeState,
  ProgressEntry,
  QuantResult,
  ReviewCheckpoint,
  StreamEvent,
} from "./types";

function normalizeContextClarificationPlan(
  plan: ContextClarificationPlanJson,
): ContextClarificationPlanJson {
  return {
    specificity_notes:
      typeof plan.specificity_notes === "string" ? plan.specificity_notes : "",
    quant_plans: Array.isArray(plan.quant_plans) ? plan.quant_plans.slice(0, 4) : [],
    clarifying_questions: Array.isArray(plan.clarifying_questions)
      ? plan.clarifying_questions
          .map((q) => String(q).trim())
          .filter(Boolean)
          .slice(0, 5)
      : [],
  };
}

async function mergeClarificationAnswersIntoDiscovery(
  runId: string,
  send?: StreamSender,
) {
  const run = await prisma.strategyRun.findUniqueOrThrow({ where: { id: runId } });
  const ans = run.clarificationAnswers?.trim();
  if (!ans) return;
  const prev = run.discoveryOutput ?? "";
  const merged = `${prev}\n\n## Your clarifications\n\n${ans}`;
  await prisma.strategyRun.update({
    where: { id: runId },
    data: {
      discoveryOutput: merged,
      clarificationAnswers: null,
    },
  });
  send?.({ type: "discovery", text: merged });
}

const DATA_CATALOG_MARKDOWN = buildDataCatalogMarkdown();

function analysisConcurrency(): number {
  const raw = process.env.ANALYSIS_CONCURRENCY;
  const n = raw?.trim() ? parseInt(raw, 10) : 4;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(16, n);
}

const LEAF_ANALYSIS_JSON_REPAIR_HINT =
  'Keys: "summary" (string), "analysis" (string), "hypothesis" (string or null), "verdict" ("confirmed"|"refuted"|"inconclusive"|"partially_supported"), "evidence_needed" (string array), "confidence" ("low"|"medium"|"high"), "quant" (null OR object with hypothesis_under_test, datasetId, steps: filter/join/project/groupby/sort/limit, optional chart).';

function leafManagerReviewEnabled(): boolean {
  const v = process.env.LEAF_MANAGER_REVIEW?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return true;
}

function formatQuantBlockForManager(q: QuantResult | undefined): string {
  if (!q) return "(No quant was run.)";
  const lines = [
    `hypothesis_under_test: ${q.hypothesis_under_test ?? "—"}`,
    `datasetId: ${q.datasetId ?? "—"}`,
    q.error ? `error: ${q.error}` : "",
    q.narrative ? `narrative: ${q.narrative}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function markdownLeafManagerReview(m: LeafManagerReviewJson): string {
  const lines = [
    "### Leaf manager review",
    "",
    m.pressure_test_summary,
    "",
    `**Alignment:** ${m.analysis_alignment}`,
    "",
  ];
  if (m.missed_catalog_opportunities?.length) {
    lines.push("**Possible catalog checks**", ...m.missed_catalog_opportunities.map((s) => `- ${s}`), "");
  }
  if (m.refinement_directives?.length) {
    lines.push("**Directives for revision**", ...m.refinement_directives.map((s) => `- ${s}`), "");
  }
  if (m.suggested_followup_quant) {
    lines.push(
      "_Follow-up quant suggested (validated against allow-list before refinement)._",
      "",
    );
  }
  return lines.join("\n").trim();
}

function shouldSkipLeafRefinement(m: LeafManagerReviewJson): boolean {
  if (!m.adequately_addresses_hypothesis) return false;
  if (m.missed_catalog_opportunities?.length) return false;
  if (m.suggested_followup_quant != null) return false;
  if (m.refinement_directives?.length) return false;
  return true;
}

function sanitizeManagerSuggestedQuant(raw: unknown): QuantPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as QuantPlan;
  if (typeof p.datasetId !== "string" || !Array.isArray(p.steps)) return null;
  if (!quantPlanReferencesValidDatasets(p)) return null;
  return p;
}

function runQuantIfValid(parsed: AnalysisJson): QuantResult | undefined {
  if (
    parsed.quant &&
    typeof parsed.quant === "object" &&
    typeof (parsed.quant as QuantPlan).datasetId === "string" &&
    Array.isArray((parsed.quant as QuantPlan).steps) &&
    quantPlanReferencesValidDatasets(parsed.quant as QuantPlan)
  ) {
    return executeQuantPlan(parsed.quant as QuantPlan);
  }
  return undefined;
}

function buildNodeStateFromAnalysis(
  leafId: string,
  parsed: AnalysisJson,
  quantResult: QuantResult | undefined,
): NodeState {
  const verdict = normalizeHypothesisVerdict(parsed.verdict);
  const confidence = normalizeConfidence(parsed.confidence);
  const evidenceList = Array.isArray(parsed.evidence_needed)
    ? parsed.evidence_needed.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const hypothesisStatement =
    typeof parsed.hypothesis === "string" && parsed.hypothesis.trim() ?
      parsed.hypothesis.trim()
    : undefined;

  const block = [
    parsed.analysis,
    quantResult?.narrative ? `\n\n**Quant:** ${quantResult.narrative}` : "",
    quantResult?.error ? `\n\n_Quant error: ${quantResult.error}_` : "",
  ].join("");

  return {
    id: leafId,
    status: "done",
    summary: parsed.summary,
    analysis: block.trim(),
    hypothesisStatement,
    verdict,
    confidence,
    evidenceNeeded: evidenceList.length ? evidenceList : undefined,
    ...(quantResult ? { quant: quantResult } : {}),
  };
}

async function analyzeLeafToDoneState(params: {
  userGoal: string;
  discoveryText: string;
  roots: OutlineNode[];
  leaf: OutlineNode;
  redirectContext: string | undefined;
}): Promise<NodeState> {
  const pathTitles = pathToNode(params.roots, params.leaf.id).join(" > ");
  const leafQuestion = params.leaf.question ?? params.leaf.title;

  const parsedInitial = await generateJson<AnalysisJson>(
    analysisPrompt({
      userGoal: params.userGoal,
      discovery: params.discoveryText,
      pathTitles,
      leafQuestion,
      redirectContext: params.redirectContext,
      dataCatalogMarkdown: DATA_CATALOG_MARKDOWN,
    }),
    { repairHint: LEAF_ANALYSIS_JSON_REPAIR_HINT },
  );
  let quantResult = runQuantIfValid(parsedInitial);
  let draft = buildNodeStateFromAnalysis(params.leaf.id, parsedInitial, quantResult);

  if (!leafManagerReviewEnabled()) {
    return draft;
  }

  let managerJson: LeafManagerReviewJson | null = null;
  try {
    managerJson = await withTokenPhase("leaf_manager", () =>
      generateJson<LeafManagerReviewJson>(
        leafManagerReviewPrompt({
          userGoal: params.userGoal,
          discovery: params.discoveryText,
          pathTitles,
          leafQuestion,
          initialSummary: draft.summary ?? "",
          initialAnalysis: parsedInitial.analysis ?? "",
          initialVerdict: draft.verdict ?? "inconclusive",
          initialConfidence: draft.confidence ?? "medium",
          evidenceNeededLines: draft.evidenceNeeded ?? [],
          quantBlockForReview: formatQuantBlockForManager(draft.quant),
          dataCatalogMarkdown: DATA_CATALOG_MARKDOWN,
          allowedDatasetIdsBlock: listQuantDatasetIds().join("\n"),
        }),
        {
          repairHint:
            'Keys: "adequately_addresses_hypothesis" (boolean), "pressure_test_summary" (string), "analysis_alignment" ("strong"|"moderate"|"weak"), "missed_catalog_opportunities" (string array), "suggested_followup_quant" (null or object with hypothesis_under_test, datasetId, steps, optional chart), "refinement_directives" (string array).',
        },
      ),
    );
  } catch {
    managerJson = null;
  }

  if (!managerJson) {
    return draft;
  }

  const reviewMd = markdownLeafManagerReview(managerJson);

  if (shouldSkipLeafRefinement(managerJson)) {
    return { ...draft, leafManagerReview: reviewMd };
  }

  const suggestedValid = sanitizeManagerSuggestedQuant(managerJson.suggested_followup_quant);
  const managerSuggestedQuantHint =
    suggestedValid ? JSON.stringify(suggestedValid) : "(none)";

  let parsedRefined: AnalysisJson;
  try {
    parsedRefined = await withTokenPhase("leaf_refine", () =>
      generateJson<AnalysisJson>(
        leafAnalysisRefinementPrompt({
          userGoal: params.userGoal,
          discovery: params.discoveryText,
          pathTitles,
          leafQuestion,
          redirectContext: params.redirectContext,
          dataCatalogMarkdown: DATA_CATALOG_MARKDOWN,
          priorAnalysisJson: JSON.stringify(parsedInitial),
          managerReviewJson: JSON.stringify(managerJson),
          managerSuggestedQuantHint,
        }),
        { repairHint: LEAF_ANALYSIS_JSON_REPAIR_HINT },
      ),
    );
  } catch {
    return { ...draft, leafManagerReview: reviewMd };
  }

  quantResult = runQuantIfValid(parsedRefined);
  const refined = buildNodeStateFromAnalysis(
    params.leaf.id,
    parsedRefined,
    quantResult,
  );
  return { ...refined, leafManagerReview: reviewMd };
}

function normalizeHypothesisVerdict(raw: unknown): HypothesisVerdict {
  const s = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  if (s === "confirmed" || s === "confirm") return "confirmed";
  if (s === "refuted" || s === "refute" || s === "denied" || s === "deny") return "refuted";
  if (s === "partially_supported" || s === "partial" || s === "partially supported")
    return "partially_supported";
  return "inconclusive";
}

function normalizeConfidence(raw: unknown): "low" | "medium" | "high" {
  const s = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  if (s === "high") return "high";
  if (s === "low") return "low";
  return "medium";
}

function ensureNodeStatesForTree(
  roots: OutlineNode[],
  states: Record<string, NodeState>,
): void {
  for (const id of listAllNodeIds(roots)) {
    if (!states[id]) {
      states[id] = { id, status: "pending" };
    }
  }
}

function isNodeStateComplete(s: NodeState | undefined): boolean {
  return s?.status === "done" || s?.status === "skipped";
}

function childSummariesMarkdownForRollup(
  roots: OutlineNode[],
  parent: OutlineNode,
  states: Record<string, NodeState>,
): string {
  const kids = parent.children ?? [];
  return kids
    .map((c) => {
      const path = pathToNode(roots, c.id).join(" > ");
      const st = states[c.id];
      const lines = [`### ${path}`, `**Title:** ${c.title}`];
      if (c.question) lines.push(`**Hypothesis / question:** ${c.question}`);
      if (!st) {
        lines.push("_(no state)_");
        return lines.join("\n");
      }
      lines.push(`**Run status:** ${st.status}`);
      if (st.verdict) lines.push(`**Verdict:** ${st.verdict}`);
      if (st.confidence) lines.push(`**Confidence:** ${st.confidence}`);
      if (st.summary) lines.push(`**Summary:** ${st.summary}`);
      if (st.evidenceNeeded?.length) {
        lines.push(`**Gaps:** ${st.evidenceNeeded.join("; ")}`);
      }
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

function deterministicFallbackBranchRollup(
  parent: OutlineNode,
  states: Record<string, NodeState>,
): NodeState {
  const kids = parent.children ?? [];
  const rank: Record<"low" | "medium" | "high", number> = {
    low: 0,
    medium: 1,
    high: 2,
  };
  let minConf: "low" | "medium" | "high" = "high";
  const bullets: string[] = [];
  for (const c of kids) {
    const st = states[c.id];
    const sm =
      st?.summary?.trim() ||
      (st?.status === "skipped" ? "(skipped)" : "—");
    bullets.push(`- **${c.title}:** ${sm}`);
    if (st?.confidence && rank[st.confidence] < rank[minConf]) {
      minConf = st.confidence;
    }
  }
  return {
    id: parent.id,
    status: "done",
    summary: `Branch rollup from ${kids.length} child node(s) (automatic fallback).`,
    analysis: bullets.join("\n"),
    verdict: "inconclusive",
    confidence: minConf,
  };
}

async function rollupSingleInternalNode(
  roots: OutlineNode[],
  parent: OutlineNode,
  states: Record<string, NodeState>,
  userGoal: string,
  discoveryText: string,
): Promise<NodeState> {
  const pathTitles = pathToNode(roots, parent.id).join(" > ");
  const childMd = childSummariesMarkdownForRollup(roots, parent, states);
  try {
    const parsed = await generateJson<BranchRollupJson>(
      branchRollupPrompt({
        userGoal,
        contextClarification: discoveryText,
        parentPathTitles: pathTitles,
        parentTitle: parent.title,
        parentQuestion: parent.question,
        childSummariesMarkdown: childMd,
      }),
      {
        repairHint:
          'Keys: "summary", "analysis", "verdict" (confirmed|refuted|inconclusive|partially_supported), "confidence" (low|medium|high), "evidence_needed" (string array).',
      },
    );
    const evidenceList = Array.isArray(parsed.evidence_needed)
      ? parsed.evidence_needed.map((s) => String(s).trim()).filter(Boolean)
      : [];
    return {
      id: parent.id,
      status: "done",
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      analysis: typeof parsed.analysis === "string" ? parsed.analysis : "",
      verdict: normalizeHypothesisVerdict(parsed.verdict),
      confidence: normalizeConfidence(parsed.confidence),
      evidenceNeeded: evidenceList.length ? evidenceList : undefined,
    };
  } catch {
    return deterministicFallbackBranchRollup(parent, states);
  }
}

/** Bottom-up waves: parents roll up after all direct children are done or skipped. */
async function rollupBranchStatesFromLeaves(
  runId: string,
  roots: OutlineNode[],
  states: Record<string, NodeState>,
  userGoal: string,
  discoveryText: string,
  send: StreamSender,
  emit: (stage: string, message: string) => Promise<void>,
) {
  const allChildrenComplete = (node: OutlineNode): boolean => {
    const kids = node.children ?? [];
    return (
      kids.length > 0 && kids.every((c) => isNodeStateComplete(states[c.id]))
    );
  };

  let wave = true;
  while (wave) {
    const ready: OutlineNode[] = [];
    const collect = (nodes: OutlineNode[]) => {
      for (const n of nodes) {
        if (n.children?.length) {
          collect(n.children);
          const st = states[n.id];
          if (
            st?.status === "pending" &&
            allChildrenComplete(n)
          ) {
            ready.push(n);
          }
        }
      }
    };
    collect(roots);
    if (!ready.length) break;

    for (const parent of ready) {
      states[parent.id] = {
        ...states[parent.id],
        id: parent.id,
        status: "running",
      };
    }
    await prisma.strategyRun.update({
      where: { id: runId },
      data: { nodeStates: states as object },
    });
    for (const parent of ready) {
      send({ type: "node", state: states[parent.id]! });
    }

    const rolled = await Promise.all(
      ready.map((parent) =>
        rollupSingleInternalNode(
          roots,
          parent,
          states,
          userGoal,
          discoveryText,
        ),
      ),
    );

    for (let i = 0; i < ready.length; i++) {
      const parent = ready[i]!;
      const done = rolled[i]!;
      states[parent.id] = done;
      send({ type: "node", state: done });
    }
    await prisma.strategyRun.update({
      where: { id: runId },
      data: { nodeStates: states as object },
    });
    await emit(
      "analysis",
      `Rolled up ${ready.length} branch level(s) toward the root`,
    );
  }
}

type AnalysisJson = {
  summary: string;
  analysis: string;
  hypothesis: string | null;
  verdict?: string;
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

const MEMORY_ARTIFACT_TITLE_MAX = 88;

/** Short list title derived from the user's strategy question (goal prompt). */
function memoryArtifactTitle(strategyQuestion: string, partial: boolean): string {
  let s = strategyQuestion.replace(/\s+/g, " ").trim();
  if (!s) s = "Strategy analysis";
  if (s.length > MEMORY_ARTIFACT_TITLE_MAX) {
    const cut = s.slice(0, MEMORY_ARTIFACT_TITLE_MAX - 1);
    const lastSpace = cut.lastIndexOf(" ");
    s =
      (lastSpace > MEMORY_ARTIFACT_TITLE_MAX >> 1 ? cut.slice(0, lastSpace) : cut) +
      "…";
  }
  return partial ? `${s} (partial)` : s;
}

function verdictLabel(v: HypothesisVerdict): string {
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

function analysesMarkdown(
  roots: OutlineNode[],
  states: Record<string, NodeState>,
): string {
  if (!roots.length) {
    return "(No hypothesis tree yet — context & clarification only.)";
  }
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
      const hyp = st?.hypothesisStatement ?? leaf.question ?? leaf.title;
      const lines: string[] = [`### ${path}`, `**Hypothesis:** ${hyp}`];
      if (st?.verdict) {
        const conf = st.confidence ? `${st.confidence}` : "—";
        lines.push(
          `**Verdict:** ${verdictLabel(st.verdict)} · **Confidence:** ${conf}`,
        );
      }
      if (st?.evidenceNeeded?.length) {
        lines.push(
          `**Additional data / evidence needed:** ${st.evidenceNeeded.join("; ")}`,
        );
      }
      lines.push("", st?.analysis ?? "(pending)");
      return lines.join("\n") + q;
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
      ? "context & clarification"
      : checkpoint === "after_structure"
        ? "revised hypothesis tree"
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
  const managerNotes = await withTokenPhase("partial_manager", () =>
    generateText(
      partialManagerPrompt({
        userGoal: run.prompt,
        discovery: discoveryText,
        analysesMarkdown: analysesMd,
      }),
    ),
  );
  await prisma.strategyRun.update({
    where: { id: runId },
    data: { managerNotes },
  });
  send({ type: "manager", notes: managerNotes });

  const synthesis = await withTokenPhase("partial_synthesis", () =>
    generateText(
      partialSynthesisPrompt({
        userGoal: run.prompt,
        discovery: discoveryText,
        managerNotes,
        analysesMarkdown: analysesMd,
        userInstruction: userNote ?? undefined,
      }),
    ),
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
      title: memoryArtifactTitle(run.prompt, true),
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

async function runContextClarificationPhase(
  runId: string,
  send: StreamSender,
  emit: (stage: string, message: string) => Promise<void>,
) {
  await withTokenPhase("context", async () => {
  const run = await prisma.strategyRun.findUniqueOrThrow({ where: { id: runId } });
  await emit("context", "Starting pipeline — context & clarification");
  let route: DiscoveryMemoryRoute = { retrieve_memory: false, queries: [] };
  try {
    route = await generateJson<DiscoveryMemoryRoute>(
      discoveryMemoryRoutePrompt(run.prompt),
      {
        repairHint:
          'Keys: "retrieve_memory" (boolean), "queries" (array of 0-3 strings). If retrieve_memory is false, queries must be [].',
      },
    );
  } catch {
    route = { retrieve_memory: false, queries: [] };
  }
  let retrievedMemory = "";
  if (
    route.retrieve_memory &&
    Array.isArray(route.queries) &&
    route.queries.some((q) => String(q).trim())
  ) {
    await emit("context", "Searching Memory repository…");
    retrievedMemory = await searchStrategyMemory(
      route.queries.map((q) => String(q).trim()).filter(Boolean),
    );
  }

  await emit("context", "Planning data checks and specificity…");
  let plan: ContextClarificationPlanJson = {
    specificity_notes: "",
    quant_plans: [],
    clarifying_questions: [],
  };
  try {
    plan = normalizeContextClarificationPlan(
      await generateJson<ContextClarificationPlanJson>(
        contextClarificationPlanPrompt({
          userGoal: run.prompt,
          retrievedMemory,
          dataCatalogMarkdown: DATA_CATALOG_MARKDOWN,
        }),
        {
          repairHint:
            'Keys: "specificity_notes" (string), "quant_plans" (array, max 4 objects: hypothesis_under_test, datasetId, steps with filter/join/project/groupby/sort/limit, optional chart), "clarifying_questions" (array, max 5 short strings).',
        },
      ),
    );
  } catch {
    plan = { specificity_notes: "", quant_plans: [], clarifying_questions: [] };
  }

  const dataBlocks: string[] = [];
  for (const rawPlan of plan.quant_plans) {
    if (
      !rawPlan ||
      typeof rawPlan !== "object" ||
      typeof rawPlan.datasetId !== "string" ||
      !Array.isArray(rawPlan.steps)
    ) {
      continue;
    }
    const label =
      typeof rawPlan.hypothesis_under_test === "string" ?
        rawPlan.hypothesis_under_test
      : "Data check";
    await emit("context", `Running data check: ${label.slice(0, 72)}…`);
    const result = executeQuantPlan(rawPlan as QuantPlan);
    const narr = [
      `**${label}**`,
      result.narrative ?? "",
      result.error ? `_Error: ${result.error}_` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    dataBlocks.push(narr);
  }
  const dataAnalysesMarkdown = dataBlocks.join("\n\n---\n\n");

  await emit("context", "Writing context & clarification brief…");
  const discoveryText = await generateText(
    contextClarificationSynthesisPrompt({
      userGoal: run.prompt,
      retrievedMemory,
      specificityNotes: plan.specificity_notes,
      dataAnalysesMarkdown,
      clarifyingQuestions: plan.clarifying_questions,
    }),
  );

  await prisma.strategyRun.update({
    where: { id: runId },
    data: { discoveryOutput: discoveryText },
  });
  send({ type: "discovery", text: discoveryText });
  await emit("context", "Context & clarification draft saved");
  await pauseForHumanReview(runId, send, "after_discovery");
  });
}

async function runStructureRevisionPhase(
  runId: string,
  send: StreamSender,
  emit: (stage: string, message: string) => Promise<void>,
) {
  await withTokenPhase("structure", async () => {
  const run = await prisma.strategyRun.findUniqueOrThrow({ where: { id: runId } });
  const discoveryText = run.discoveryOutput ?? "";
  if (!discoveryText) {
    throw new Error("Discovery output missing — cannot build structure.");
  }

  await emit("structure", "Building initial hypothesis tree");
  const structureRepairHint =
    'One object with key "roots" (array). Each node: "id" (string), "title", "question" (testable declarative hypothesis at every depth), "children" (array; use [] on leaves). Internal nodes must have non-empty children.';

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
      "Structure agent returned no usable hypothesis tree (no roots or no leaf nodes). Try again or shorten the goal.",
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
    `Initial hypothesis tree (${flattenLeaves(roots).length} leaves) — manager review`,
  );

  const treeReviewNotes = await withTokenPhase("manager_tree", () =>
    generateText(
      managerMeceReviewPrompt({
        userGoal: run.prompt,
        discovery: discoveryText,
        outlineJson: JSON.stringify(firstOutline, null, 2),
      }),
    ),
  );
  await prisma.strategyRun.update({
    where: { id: runId },
    data: { treeReviewNotes },
  });
  send({ type: "tree_review", notes: treeReviewNotes });
  await emit("structure", "Revising hypothesis tree from manager feedback");

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
      "Revision did not produce a valid tree — keeping initial hypothesis tree for analysis.",
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
      ? `Revised hypothesis tree ready (${flattenLeaves(roots).length} leaves) — continuing`
      : `Revised hypothesis tree ready (${flattenLeaves(roots).length} leaves) — awaiting your review`,
  );

  await pauseForHumanReview(runId, send, "after_structure");
  });
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
    throw new Error("Hypothesis tree missing — cannot analyze leaves.");
  }

  const states = { ...((run.nodeStates as Record<string, NodeState> | null) ?? {}) };
  ensureNodeStatesForTree(roots, states);
  const leaves = flattenLeaves(roots);
  const concurrency = analysisConcurrency();
  let offset = 0;
  let stoppedEarlyForPartial = false;

  await withTokenPhase("analysis", async () => {
    while (offset < leaves.length) {
      const ctrl = await consumeControl(runId);
      if (ctrl?.action === "synthesize_now") {
        await finalizePartialSynthesis(runId, send, ctrl.note);
        stoppedEarlyForPartial = true;
        return;
      }
      if (ctrl?.action === "redirect" && ctrl.note?.trim()) {
        await recordRedirect(runId, ctrl.note.trim(), send);
      }

      const redirectRow = await prisma.strategyRun.findUniqueOrThrow({
        where: { id: runId },
        select: { redirectContext: true },
      });
      const redirectContext =
        redirectRow.redirectContext?.trim() || undefined;
      const batch = leaves.slice(offset, offset + concurrency);
      offset += batch.length;

      for (const leaf of batch) {
        states[leaf.id] = {
          ...states[leaf.id],
          id: leaf.id,
          status: "running",
        };
      }
      await prisma.strategyRun.update({
        where: { id: runId },
        data: { nodeStates: states as object },
      });
      for (const leaf of batch) {
        send({ type: "node", state: states[leaf.id] });
        await emit("analysis", `Analyzing: ${leaf.title}`);
      }

      const doneStates = await Promise.all(
        batch.map((leaf) =>
          analyzeLeafToDoneState({
            userGoal: run.prompt,
            discoveryText,
            roots,
            leaf,
            redirectContext,
          }),
        ),
      );

      for (const done of doneStates) {
        states[done.id] = done;
        send({ type: "node", state: done });
      }
      await prisma.strategyRun.update({
        where: { id: runId },
        data: { nodeStates: states as object },
      });
    }
  });

  if (stoppedEarlyForPartial) {
    return;
  }

  await withTokenPhase("rollup", async () => {
    await emit("analysis", "Rolling up branch conclusions from leaf results…");
    await rollupBranchStatesFromLeaves(
      runId,
      roots,
      states,
      run.prompt,
      discoveryText,
      send,
      emit,
    );

    const modeRow = await prisma.strategyRun.findUnique({
      where: { id: runId },
      select: { runMode: true },
    });
    const endToEnd = modeRow?.runMode === "end_to_end";
    await emit(
      "analysis",
      endToEnd
        ? "All branches rolled up — manager critique next"
        : "All branches rolled up — awaiting your review",
    );
    await pauseForHumanReview(runId, send, "after_analysis");
  });
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
  const managerNotes = await withTokenPhase("manager_analyses", () =>
    generateText(
      managerPrompt({
        userGoal: run.prompt,
        discovery: discoveryText,
        analysesMarkdown: analysesMd,
      }),
    ),
  );
  await prisma.strategyRun.update({
    where: { id: runId },
    data: { managerNotes },
  });
  send({ type: "manager", notes: managerNotes });

  const synEntry = await appendProgress(runId, "synthesis", "Writing final memo");
  send({ type: "progress", entry: synEntry });

  const synthesis = await withTokenPhase("synthesis", () =>
    generateText(
      synthesisPrompt({
        userGoal: run.prompt,
        discovery: discoveryText,
        managerNotes,
        analysesMarkdown: analysesMd,
      }),
    ),
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
      title: memoryArtifactTitle(run.prompt, false),
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

  const acc = new RunTokenUsageAccumulator(getModelId());
  await runTokenTrackingContext(acc, async () => {
    try {
    if (initialStatus === "pending") {
      await runContextClarificationPhase(runId, send, emit);
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
      await mergeClarificationAnswersIntoDiscovery(runId, send);
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
    } finally {
      try {
        const row = await prisma.strategyRun.findUnique({
          where: { id: runId },
          select: { tokenUsage: true },
        });
        const merged = mergeTokenUsageIntoStored(row?.tokenUsage, acc.toJSON());
        await prisma.strategyRun.update({
          where: { id: runId },
          data: { tokenUsage: merged as Prisma.InputJsonValue },
        });
      } catch {
        /* ignore persistence errors */
      }
    }
  });
}
