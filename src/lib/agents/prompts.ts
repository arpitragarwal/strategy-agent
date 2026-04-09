export function discoveryPrompt(input: {
  /** Goal, question, metrics, constraints, KB notes — everything in one block. */
  prompt: string;
  priorAnalyses: string;
}): string {
  return `You are a strategy discovery agent. Your job is to scan the provided context (simulating recurring review of internal knowledge) and surface problems, opportunities, ambiguities, and early hypotheses.

User input (goal, question, and any context to honor):
${input.prompt}

Prior outputs only from earlier completed runs in this app (strategy memos, manager critiques, branch write-ups). **Does not** include those runs’ original questions, goals, or prompts — treat the user input above as the sole brief.
${input.priorAnalyses || "(none)"}

Rules: Use prior outputs **only when clearly relevant** to the user input above (same company, product, problem class, or reusable fact). If nothing clearly applies, **ignore this block entirely** — do not echo unrelated companies, metrics, or themes from past work.

Output concise markdown with sections:
## Themes
## Problems / risks
## Opportunities
## Open questions
## Suggested focus for structured breakdown
Keep it specific to the context; avoid generic consulting boilerplate.`;
}

export function structurePrompt(input: {
  userGoal: string;
  discovery: string;
}): string {
  return `You output ONE JSON object only. No markdown, no bullets, no preamble, no explanation. First character must be "{". Last must be "}".

Task: build a MECE-style issue tree for the goal below. If discovery notes are thin, still produce a concrete tree using the goal and general knowledge of the company or industry named in the goal—do not refuse or complain about missing context in prose.

User goal:
${input.userGoal}

Discovery notes:
${input.discovery}

Exact JSON shape:
{
  "roots": [
    {
      "id": "unique_snake_id",
      "title": "short pillar name",
      "question": "decision-oriented question for this node",
      "children": [
        { "id": "child_id", "title": "…", "question": "…", "children": [] }
      ]
    }
  ]
}

Rules:
- Every leaf must have "children": [] only.
- Internal nodes must have non-empty children.
- 3–6 top-level roots unless the problem is tiny.
- IDs: lowercase letters, numbers, underscores only.
- Questions must be specific and answerable.`;
}

/** Appended on second attempt when normalizeOutlineDoc finds empty/malformed roots. */
export const STRUCTURE_RETRY_SUFFIX = `

CRITICAL FIX: The previous JSON was rejected — "roots" was missing, empty, or not a non-empty array, or there were no leaf nodes.
Reply with ONLY one JSON object. "roots" MUST be a non-empty array. For a normal strategy question use at least 3 top-level pillars; each branch must end in leaves with "children": [].
First character "{", last character "}".`;

export function managerMeceReviewPrompt(input: {
  userGoal: string;
  discovery: string;
  outlineJson: string;
}): string {
  return `You are a senior manager reviewing the proposed MECE issue tree **before** any per-branch analysis runs.

User goal and context (full prompt):
${input.userGoal}

Discovery output:
${input.discovery}

Proposed MECE tree (JSON):
${input.outlineJson}

Output markdown with:
## MECE / coverage check (mutually exclusive? collectively exhaustive for the goal?)
## Gaps, overlaps, or mis-groupings
## Concrete structural fixes (merge/split/rename pillars, add missing branches, clarify questions)
## Must-fix issues before analysis proceeds

Be direct and actionable. The next step will **rebuild the tree JSON** from your feedback.`;
}

export function structureRevisionPrompt(input: {
  userGoal: string;
  discovery: string;
  priorOutlineJson: string;
  managerTreeFeedback: string;
}): string {
  return `You output ONE JSON object only. No markdown, no preamble. First character "{".

An initial MECE tree was drafted, then reviewed by a manager. Produce a **revised full tree** that addresses the feedback. Use new stable ids (lowercase_snake_case).

User goal:
${input.userGoal}

Discovery:
${input.discovery}

Prior tree JSON (reference — fix; do not preserve bad structure):
${input.priorOutlineJson}

Manager feedback (incorporate fully):
${input.managerTreeFeedback}

Exact shape:
{
  "roots": [
    {
      "id": "unique_snake_id",
      "title": "short pillar name",
      "question": "decision-oriented question",
      "children": [ ... leaves must have "children": [] ]
    }
  ]
}

Rules:
- Every leaf: "children": []
- Internal nodes: non-empty children
- 3–6 top-level roots unless the scope is tiny
- Questions must be answerable in analysis`;

}

export const STRUCTURE_REVISION_RETRY_SUFFIX = `

CRITICAL: Previous revision JSON was invalid or had no usable leaves.
Return ONLY one JSON object with non-empty "roots" and valid leaf nodes. First "{", last "}".`;

export function analysisPrompt(input: {
  userGoal: string;
  discovery: string;
  pathTitles: string;
  leafQuestion: string;
  redirectContext?: string;
  dataCatalogMarkdown: string;
}): string {
  const steer =
    input.redirectContext?.trim() ?
      `\nUser steering / redirect (prioritize this when answering this leaf):\n${input.redirectContext.trim()}\n`
    : "";

  return `You are an analysis agent. Answer one leaf of a strategy tree with discipline. You may request a quantitative check using prototype CSVs (no live connectors).

Overall goal:
${input.userGoal}

Discovery context:
${input.discovery}
${steer}
Path in tree: ${input.pathTitles}

Leaf question:
${input.leafQuestion}

${input.dataCatalogMarkdown}

Quantitative plans: when numeric evidence from these CSVs would strengthen the answer, include "quant" with a pipeline. If the leaf is purely qualitative or no dataset fits, set "quant" to null.

Allowed quant.steps operations (execute in order):
- {"op":"filter","column":"<col>","cmp":"eq"|"neq"|"gt"|"gte"|"lt"|"lte","value": string|number|boolean}
- {"op":"groupby","by":["col1",...],"measures":[{"alias":"name","column":"<col>","agg":"sum"|"mean"|"count"|"min"|"max"}]}
- {"op":"sort","by":"<col>","dir":"asc"|"desc"} (optional dir, default asc)
- {"op":"limit","n": number}

Optional "chart": {"type":"bar"|"line","x":"<col>","y":"<col>","title":"optional"} referencing columns present AFTER all steps.

Your entire reply must be ONE JSON object only — no markdown, no keys in prose form, no text before { or after }.

Required JSON shape (types matter):
{
  "summary": "string, 2-4 sentences for executives",
  "analysis": "string, detailed reasoning",
  "hypothesis": null or "string",
  "evidence_needed": ["array", "of", "strings"],
  "confidence": "low" | "medium" | "high",
  "quant": null OR {
    "hypothesis_under_test": "string, what the numbers will test",
    "datasetId": "string, exact id from catalog e.g. crm/opportunities",
    "steps": [ ...quant steps... ],
    "chart": null OR { "type": "bar" | "line", "x": "string", "y": "string", "title": "optional string" }
  }
}`;
}

export function managerPrompt(input: {
  userGoal: string;
  discovery: string;
  analysesMarkdown: string;
}): string {
  return `You are a manager agent pressure-testing a strategy analysis before synthesis.

Goal:
${input.userGoal}

Discovery:
${input.discovery}

Per-leaf analyses:
${input.analysesMarkdown}

Output markdown with:
## Challenge assumptions
## Contradictions / gaps
## What would change the recommendation
## Go / no-go checks for the next phase
Be direct and skeptical but constructive.`;
}

export function synthesisPrompt(input: {
  userGoal: string;
  discovery: string;
  managerNotes: string;
  analysesMarkdown: string;
}): string {
  return `You are a synthesis agent. Produce an actionable strategy memo in markdown.

Goal:
${input.userGoal}

Discovery:
${input.discovery}

Manager critique:
${input.managerNotes}

Analyses:
${input.analysesMarkdown}

Structure the memo as:
# Executive summary
# Recommended moves (numbered, each with owner-style role and timeframe)
# Risks & mitigations
# Metrics to track
# Next 30 days plan
# Open questions

Keep language crisp; tie recommendations to points in the analyses.`;
}

export function partialManagerPrompt(input: {
  userGoal: string;
  discovery: string;
  analysesMarkdown: string;
}): string {
  return `You are a manager agent. The user paused the pipeline early — not every MECE leaf was analyzed.

Goal:
${input.userGoal}

Discovery:
${input.discovery}

Per-leaf analyses (some branches show "pending" or were skipped):
${input.analysesMarkdown}

Output concise markdown:
## Challenge assumptions (given partial coverage)
## Biggest gaps from incomplete branches
## What to validate before acting
## Go / no-go checks
Be direct; flag uncertainty from missing analyses.`;
}

export function partialSynthesisPrompt(input: {
  userGoal: string;
  discovery: string;
  managerNotes: string;
  analysesMarkdown: string;
  userInstruction?: string;
}): string {
  const extra = input.userInstruction?.trim() ?
    `\nUser instruction when stopping early:\n${input.userInstruction.trim()}\n`
    : "";

  return `You are a synthesis agent. The user requested an early / partial synthesis: not all planned branches were analyzed.

Goal:
${input.userGoal}
${extra}
Discovery:
${input.discovery}

Manager critique:
${input.managerNotes}

Analyses (partial — note pending/skipped branches):
${input.analysesMarkdown}

Start the memo with a short banner line: **Partial synthesis — analysis was stopped before all branches completed.**

Then use the same sections as a full memo:
# Executive summary (flag incompleteness)
# Early recommendations (what we can say now)
# What remains to analyze
# Risks from partial coverage
# Next steps

Keep recommendations tentative where evidence is missing.`;
}
