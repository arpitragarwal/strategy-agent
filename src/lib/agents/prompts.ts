export function discoveryPrompt(input: {
  userGoal: string;
  companyContext: string;
  priorAnalyses: string;
}): string {
  return `You are a strategy discovery agent. Your job is to scan the provided context (simulating recurring review of internal knowledge) and surface problems, opportunities, ambiguities, and early hypotheses.

User goal or question:
${input.userGoal}

Company / knowledge context (may include docs, metrics notes, org facts):
${input.companyContext || "(none provided)"}

Prior completed analyses summaries (memory — reuse or build on these, cite overlap):
${input.priorAnalyses || "(none)"}

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

export function analysisPrompt(input: {
  userGoal: string;
  discovery: string;
  pathTitles: string;
  leafQuestion: string;
  redirectContext?: string;
}): string {
  const steer =
    input.redirectContext?.trim() ?
      `\nUser steering / redirect (prioritize this when answering this leaf):\n${input.redirectContext.trim()}\n`
    : "";

  return `You are an analysis agent. Answer one leaf of a strategy tree with discipline.

Overall goal:
${input.userGoal}

Discovery context:
${input.discovery}
${steer}
Path in tree: ${input.pathTitles}

Leaf question:
${input.leafQuestion}

Respond as JSON:
{
  "summary": "2-4 sentences for executives",
  "analysis": "Detailed reasoning with bullet points if needed",
  "hypothesis": "Single testable hypothesis OR null if not applicable",
  "evidence_needed": ["what data would increase confidence"],
  "confidence": "low|medium|high"
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
