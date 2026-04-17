export type DiscoveryMemoryRoute = {
  retrieve_memory: boolean;
  queries: string[];
};

/**
 * Single source of truth for quant pipeline JSON (context planner + leaf analysis).
 * Matches ops handled by `executeQuantPlan` in `src/lib/quant/executor.ts`.
 */
export const QUANT_PIPELINE_OPS_FOR_PROMPTS = `Allowed quant.steps operations (execute in order):
- {"op":"filter","column":"<col>","cmp":"eq"|"neq"|"gt"|"gte"|"lt"|"lte","value": string|number|boolean}
- {"op":"join","rightDatasetId":"<catalog id>","on":[["leftCol","rightCol"],...],"how":"inner"|"left","rightPrefix":"optional prefix for right-hand columns (default r_)"} — start from quant.datasetId (or each plan's datasetId) as the left table; add another CSV keyed by **on** (composite keys supported). Chained joins: use different **rightPrefix** each time (e.g. acc_, tix_).
  - **Same name on both sides:** if a pair is \`["product_line","product_line"]\` (or any \`["x","x"]\`), the result has **one** column \`x\` — there is **no** \`r_x\`. Only right-only columns (not in \`on\`, or different right-side name) appear as \`r_<col>\`.
  - **Left join:** rows with no key match still get all \`r_*\` columns set to null (stable schema).
- {"op":"project","columns":["col1","col2",...]} — **destructive:** only listed columns survive. Include **every** column you need for **all later steps**: each \`groupby.by\` and measure \`column\`, each later \`filter.column\`, each \`sort.by\`, each **left-hand** \`join\` \`on\` key, each column in any **later** \`project\`, and the optional top-level \`chart\` \`x\`/\`y\` on the **final** row shape. Common mistake: dropping \`account_id\` (or another join key) then \`groupby\` by account — that fails.
- {"op":"groupby","by":["col1",...],"measures":[{"alias":"name","column":"<col>","agg":"sum"|"mean"|"count"|"min"|"max"}]}
- {"op":"sort","by":"<col>","dir":"asc"|"desc"} (optional dir, default asc)
- {"op":"limit","n": number}

For cross-table questions, use **join** as documented in the catalog instead of reasoning from one file only.

**Time bucket:** prototype CSVs use the column name **fiscal_quarter** (values like 2025-Q1) on crm/deal_data, cx/*, finance/finance_summary, **finance/arr_by_account_quarter** (ARR by account × quarter from CRM), and support/support_summary — not \`quarter\`. **support/support_summary** is **account × fiscal_quarter** (join on **account_id** + **fiscal_quarter** to CX/CRM). crm/accounts uses **renewal_fiscal_quarter** for the account’s renewal slot. **crm/deal_data.logo_acquisition_cohort** matches **crm/accounts.logo_acquisition_cohort** for the same **account_id** (calendar year used as the logo cohort key in the prototype).

**Categorical filters:** the data catalog markdown includes **“Filter literals (exact strings)”** — copy those values exactly for \`filter\` \`eq\`/\`neq\` (e.g. \`outcome\` is \`lost\` not \`Lost\`; \`deal_type\` is \`renew\` not \`renewal\`).

Optional chart per plan: {"type":"bar"|"line","x":"<col>","y":"<col>","title":"optional"} — \`x\` and \`y\` must be **literal non-empty strings** (column names on the final rows), never null or omitted.`;

/** Model decides whether to run a Memory repository search (like optional web search). */
export function discoveryMemoryRoutePrompt(userGoal: string): string {
  return `You control an optional lookup in this app's **Memory repository**: saved outputs from prior strategy runs (final memos, manager critiques, branch analysis write-ups). Nothing is included automatically.

User goal / question:
${userGoal}

Decide if this goal would benefit from scanning Memory for **related** prior work (same company, market, product, or problem class). If yes, propose 1–3 short **search phrases** (keywords; not essays). If the ask is unrelated or Memory is unlikely to help, skip.

Output ONE JSON object only. First character "{", last "}".
Shape:
{
  "retrieve_memory": boolean,
  "queries": string[]
}
Example when skipping: {"retrieve_memory":false,"queries":[]}

Rules:
- If retrieve_memory is false, queries MUST be [].
- If true, queries has 1–3 non-empty strings.
- Do not request Memory for generic questions with no plausible link to prior strategy artifacts.`;
}

/** Plan step: what to quantify + what to ask the user (output JSON). */
export type ContextClarificationPlanJson = {
  /** Where the goal is vague (e.g. "largest segment" without naming it) — plain text. */
  specificity_notes: string;
  /** 0–4 plans using catalog datasets only; resolve "which X is biggest/fastest" when columns exist. */
  quant_plans: Array<{
    hypothesis_under_test: string;
    datasetId: string;
    steps: unknown[];
    chart?: unknown | null;
  }>;
  /** 1–5 short questions only when data cannot resolve (definitions, preferences, horizons). Else []. */
  clarifying_questions: string[];
};

export function contextClarificationPlanPrompt(input: {
  userGoal: string;
  retrievedMemory: string;
  dataCatalogMarkdown: string;
}): string {
  return `You are the **planning** half of a "Context & clarification" step for strategy work. You do NOT write the final brief yet.

Your jobs:
1. **Specificity check** — Read the goal for underspecified phrases (e.g. "the largest customer segment", "fastest-growing region", "main vertical") where naming the entity would sharpen the rest of the pipeline. Call this out in specificity_notes.
2. **Data-first disambiguation** — When prototype spreadsheet data (see catalog) can pin down those entities, emit quant_plans (up to **4**). Prefer **filter → join (if multiple tables) → project (optional, to select columns) → groupby → sort (desc) → limit**. Use exact datasetId values from the catalog and documented join keys.
3. **Human clarification** — When the catalog **cannot** resolve an important gap (definitions, horizons, intent), add concise clarifying_questions (max **5** strings).

**Mandatory closure:** If specificity_notes is **non-empty** (you flagged underspecified phrases), you **must not** leave both quant_plans and clarifying_questions empty. Either emit at least one **valid** quant_plan that targets a flagged gap using catalog columns, **or** at least one clarifying_question the user must answer, **or both**. If the goal is already concrete, keep specificity_notes brief and use [] for both arrays.

User goal / question:
${input.userGoal}

Memory repository (optional excerpts from prior runs — **outputs** only):
${input.retrievedMemory.trim() || "(No memory lookup was run, or search returned nothing useful.)"}

Rules for Memory: use **only** when clearly relevant; otherwise mentally ignore it.

${input.dataCatalogMarkdown}

Output **one JSON object only** — first character "{", last "}".
Shape:
{
  "specificity_notes": "string",
  "quant_plans": [ ... 0 to 4 objects with hypothesis_under_test, datasetId, steps, optional chart — same quant shape as the analysis agent ... ],
  "clarifying_questions": [ "string", ... ]
}

Each quant_plan object: hypothesis_under_test, datasetId, steps[], optional chart — same shape as the leaf analysis "quant" object.

${QUANT_PIPELINE_OPS_FOR_PROMPTS}

If retrieve_memory had nothing useful and the goal is already concrete, specificity_notes can be brief, quant_plans can be [], clarifying_questions can be [].`;
}

export function contextClarificationSynthesisPrompt(input: {
  userGoal: string;
  retrievedMemory: string;
  specificityNotes: string;
  /** Markdown: executed quant narratives/errors (may be empty). */
  dataAnalysesMarkdown: string;
  clarifyingQuestions: string[];
}): string {
  const qBlock =
    input.clarifyingQuestions.length > 0 ?
      input.clarifyingQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")
    : "(No clarifying questions — data and goal were sufficient.)";

  const questionsBody =
    input.clarifyingQuestions.length > 0 ?
      "<numbered list mirroring the planned clarifying questions, phrased crisply>"
    : "_None — continue when ready._";

  return `You complete the **Context & clarification** brief (markdown for executives). Another pass already ran optional Memory lookup and executed spreadsheet analyses; your job is to **integrate** them with judgment. Output **markdown only**, shaped **exactly** like the template below.

User goal:
${input.userGoal}

Memory (optional prior-run excerpts — use only if relevant):
${input.retrievedMemory.trim() || "(None.)"}

Specificity / ambiguity notes from the planner:
${input.specificityNotes.trim() || "(None.)"}

Executed data analyses (prototype CSVs — treat as illustrative snapshots, not live systems):
${input.dataAnalysesMarkdown.trim() || "(No quant runs executed.)"}

Planned clarifying questions for the user (if any — you MUST surface these in the output):
${qBlock}

Output template (fill in — keep these seven sections in this exact order, nothing else):

## Themes
<2–5 bullets or a tight paragraph of specific themes that shape this strategy question>

## Problems / risks
- <specific problem or risk>
- <another>

## Opportunities
- <specific opportunity>
- <another>

## Data-backed specificity
<State what was pinned down from the executed analyses — key numbers, rankings, segments/regions. If no quant ran, say: _None — no quant runs executed._>

## Open questions
- <internal unknowns you would still want to close, not necessarily for the user>

## Questions for you
${questionsBody}

## Suggested focus for the hypothesis tree
- <sharpest angles the tree should cover first>

Hard rules (obey silently; do **not** write them in your output):
- Your reply must **begin** with \`## Themes\` — no preamble, no meta bullet list like \`* Memory:\` / \`* Analyses:\`, no title above it.
- Never wrap any part of the output in \`\`\` code fences anywhere — weave Memory, analyses, and clarifying questions into normal prose under the sections above.
- Never restate these rules or the template as bullets.
- Put each \`## Section\` on its own line (never glue \`## Themes\` onto the same line as tone or other text).
- Be specific; avoid generic consulting boilerplate. If Memory text is irrelevant, do not mention it.`;
}

export function structurePrompt(input: {
  userGoal: string;
  discovery: string;
}): string {
  return `You output ONE JSON object only. No markdown, no bullets, no preamble, no explanation. First character must be "{". Last must be "}".

FORBIDDEN (will break the pipeline): comma-separated theme lists, plain sentences listing segments or gaps, bullet lists of topics, or any paragraph that does not start with "{". Those are NOT acceptable — only the JSON object below the rules.

Task: build a **hypothesis tree** (mutually exclusive branches at each level, collectively covering the goal) for the goal below. If context & clarification notes are thin, still produce a concrete tree using the goal and general knowledge of the company or industry named in the goal—do not refuse or complain about missing context in prose.

User goal:
${input.userGoal}

Context & clarification notes:
${input.discovery}

Exact JSON shape:
{
  "roots": [
    {
      "id": "unique_snake_id",
      "title": "short pillar name",
      "question": "declarative, testable hypothesis for this node (every depth)",
      "children": [
        { "id": "child_id", "title": "…", "question": "…", "children": [] }
      ]
    }
  ]
}

Rules:
- **Every node (root, internal, leaf):** \`question\` must be a **clear, testable hypothesis** — a declarative claim someone could **confirm or refute** with data and reasoning (not a vague theme, not only a topic label). **Leaves** are analyzed directly against this claim; **internal** nodes are judged later by **rolling up** child results as evidence for the same parent hypothesis.
- **Leaves:** \`children\` must be \`[]\` only.
- **Internal nodes:** non-empty \`children\`; sibling hypotheses under one parent should be **MECE** at that level (mutually exclusive angles, together covering the parent's scope).
- 3–6 top-level roots unless the problem is tiny.
- **Order matters:** Within each \`children\` array, order siblings from **highest expected impact / most likely root causes / key decision levers** first, then supporting or downstream factors. Put dependencies before what they explain when the logic requires it. Do **not** use arbitrary or alphabetical ordering.
- IDs: lowercase letters, numbers, underscores only.`;
}

/** Appended on second attempt when normalizeOutlineDoc finds empty/malformed roots. */
export const STRUCTURE_RETRY_SUFFIX = `

CRITICAL FIX: The previous JSON was rejected — "roots" was missing, empty, or not a non-empty array, or there were no leaf nodes.
Reply with ONLY one JSON object. "roots" MUST be a non-empty array. For a normal strategy question use at least 3 top-level pillars; each branch must end in leaves with "children": [] and **every node's "question"** (root, internal, leaf) must be a testable declarative hypothesis.
First character "{", last character "}".`;

export function managerMeceReviewPrompt(input: {
  userGoal: string;
  discovery: string;
  outlineJson: string;
}): string {
  return `You are a senior manager reviewing the proposed **hypothesis tree** before any per-leaf analysis runs. Output **markdown only**, shaped **exactly** like the template below.

User goal and context (full prompt):
${input.userGoal}

Context & clarification output:
${input.discovery}

Proposed hypothesis tree (JSON):
${input.outlineJson}

Output template (fill in — keep the title + six sections in this exact order, nothing else):

# Hypothesis tree review

## Hypothesis tree / coverage
<Are the roots mutually exclusive? Do they collectively cover the goal? Concrete verdict, then specifics.>

## Gaps, overlaps, or mis-groupings
- <missing angle / overlap / wrong parent>
- <another>

## Node hypotheses (every depth)
<Are all nodes' \`question\` fields testable claims (confirm/deny with evidence)? Flag any internal node that only "frames a pillar" without a falsifiable statement.>

## Ordering
<Within each level, should higher-impact or more causal branches appear earlier? Say what to reorder.>

## Concrete structural fixes
- <merge / split / rename pillar X because …>
- <add missing branch Y>
- <sharpen hypothesis on node Z>

## Must-fix issues before analysis proceeds
- <blocker 1>
- <blocker 2>

Hard rules (obey silently; do **not** write them in your output):
- Your reply must **begin** with the literal characters \`# Hypothesis tree review\` — no role statement, no "Senior manager…" line, no restating the user goal, no bullets that restate this task.
- Never wrap any part of the output in \`\`\` code fences.
- Never restate these rules or the template as bullets.
- Use Unicode arrows (→) instead of LaTeX (\`$...$\`).
- Be direct and actionable — the next step will **rebuild the tree JSON** from your feedback.`;
}

export function structureRevisionPrompt(input: {
  userGoal: string;
  discovery: string;
  priorOutlineJson: string;
  managerTreeFeedback: string;
}): string {
  return `You output ONE JSON object only. No markdown, no preamble. First character "{".

FORBIDDEN (will break the pipeline): repeating the user goal or manager review as markdown sections (e.g. "* User Goal:", "## Manager Feedback"), bullet lists of feedback, or any prose that does not start with "{". Your entire reply must be parseable as one JSON value — the tree object only.

An initial hypothesis tree was drafted, then reviewed by a manager. Produce a **revised full tree** that addresses the feedback. Use new stable ids (lowercase_snake_case).

User goal:
${input.userGoal}

Context & clarification:
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
      "question": "declarative testable hypothesis (root, internal, or leaf)",
      "children": [ ... leaves must have "children": [] ]
    }
  ]
}

Rules:
- Every leaf: "children": []
- Internal nodes: non-empty children
- 3–6 top-level roots unless the scope is tiny
- **Order matters:** In every \`children\` array, list branches from **strongest drivers / causes / decision-critical** first to more peripheral last—same intent as the initial structure pass, unless manager feedback explicitly requires a different order.
- **Every node "question"** (root, internal, leaf) must be a **testable hypothesis** (confirm / deny with evidence); internal nodes are validated via rollup from children, not prose labels only.`;
}

export const STRUCTURE_REVISION_RETRY_SUFFIX = `

CRITICAL: Previous revision JSON was invalid or had no usable leaves.
Return ONLY one JSON object with non-empty "roots" and valid leaf nodes; **every node's "question"** must be a testable hypothesis. First "{", last "}".
Do NOT output markdown feedback or labeled sections — only the JSON tree.`;

/** Short prompt when the full revision prompt confuses the model into prose. */
export function structureRevisionMinimalPrompt(input: {
  userGoal: string;
  priorOutlineJson: string;
  managerTreeFeedback: string;
}): string {
  const goal = input.userGoal.replace(/\s+/g, " ").trim().slice(0, 2500);
  const prior = input.priorOutlineJson.slice(0, 14000);
  const mgr = input.managerTreeFeedback.slice(0, 8000);
  return `Return exactly one JSON object. First character "{". Last "}". No markdown, no bullet lists, no "* User Goal" lines, no code fences.

Required shape: {"roots":[...]} — each node has "id" (string), "title", "question" (testable hypothesis), "children" (use [] on leaves; non-empty arrays on internal nodes). 3–6 top-level roots unless the scope is tiny.

User goal (for meaning only — do not restate as headings):
${goal}

Prior tree JSON (revise; you may assign new ids):
${prior}

Manager feedback (incorporate into the tree structure and hypotheses):
${mgr}`;
}

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
      `\nUser steering notes (prioritize when answering this leaf):\n${input.redirectContext.trim()}\n`
    : "";

  return `You are an analysis agent working on one **leaf node** of a **hypothesis tree** (every node in the tree is framed as a hypothesis; leaves are tested here directly). This node's \`question\` is the **hypothesis** to test. Weigh evidence (context, reasoning, and optional CSV analysis) and **confirm or refute** it when possible; use "inconclusive" or "partially_supported" when evidence is mixed or incomplete.

Overall goal:
${input.userGoal}

Context & clarification:
${input.discovery}
${steer}
Path in tree: ${input.pathTitles}

**Hypothesis under test** (same as leaf question; restate crisply in "hypothesis" if you sharpen the wording):
${input.leafQuestion}

${input.dataCatalogMarkdown}

Quantitative plans: when numeric evidence from these CSVs would strengthen confirmation or refutation, include "quant" with a pipeline. If the hypothesis is purely qualitative or no dataset fits, set "quant" to null.

${QUANT_PIPELINE_OPS_FOR_PROMPTS}

evidence_needed (required discipline): List concrete gaps that limit this answer — not generic caveats. Each item is one short string. Include when relevant:
- Data / numbers: metrics, cuts, or time ranges not in context notes or CSVs; unreliable proxies you had to use.
- Context: missing segment, geography, product, channel, competitor, or regulatory detail that would change the read.
- Stakeholders / primary research: who you would need to interview or what internal doc/source would resolve ambiguity.
- Quant: you set "quant" to null but a specific dataset or cut would have helped — say what you would run (name datasetId if obvious from the catalog).

Also mention limitations of the prototype CSVs (snapshot only, no live systems) when you leaned on them heavily. Use an empty array only when nothing substantive is missing for *this* leaf.

Your entire reply must be ONE JSON object only — no markdown, no keys in prose form, no text before { or after }.

Required JSON shape (types matter):
{
  "summary": "string, 2-4 sentences for executives; lead with whether the hypothesis is confirmed, refuted, or uncertain and why",
  "analysis": "string, detailed reasoning that explicitly argues for confirm / deny / mixed; cite quant or context",
  "hypothesis": null or "string — refined statement of the claim being tested",
  "verdict": "confirmed" | "refuted" | "inconclusive" | "partially_supported",
  "evidence_needed": ["specific gap strings per rules above; [] only if truly nothing missing"],
  "confidence": "low" | "medium" | "high",
  "quant": null OR {
    "hypothesis_under_test": "string, what the numbers will test",
    "datasetId": "string, exact id from catalog e.g. crm/deal_data",
    "steps": [ ...quant steps... ],
    "chart": null OR { "type": "bar" | "line", "x": "string", "y": "string", "title": "optional string" }
  }
}`;
}

/** Manager pressure-test after an initial leaf analysis (JSON). */
export type LeafManagerReviewJson = {
  adequately_addresses_hypothesis: boolean;
  pressure_test_summary: string;
  analysis_alignment: "strong" | "moderate" | "weak";
  /** Name a real catalog datasetId when suggesting CSV checks; never invent ids. */
  missed_catalog_opportunities: string[];
  suggested_followup_quant: null | {
    hypothesis_under_test: string;
    datasetId: string;
    steps: unknown[];
    chart?: unknown | null;
  };
  refinement_directives: string[];
};

export function leafManagerReviewPrompt(input: {
  userGoal: string;
  discovery: string;
  pathTitles: string;
  leafQuestion: string;
  initialSummary: string;
  initialAnalysis: string;
  initialVerdict: string;
  initialConfidence: string;
  evidenceNeededLines: string[];
  quantBlockForReview: string;
  dataCatalogMarkdown: string;
  /** Exact allowed datasetId values (one per line). */
  allowedDatasetIdsBlock: string;
}): string {
  const ev =
    input.evidenceNeededLines.length > 0 ?
      input.evidenceNeededLines.map((s) => `- ${s}`).join("\n")
    : "(none listed)";

  return `You are a **senior manager** pressure-testing a **single leaf analysis** before it is finalized. The tree is MECE; this leaf's job is to test one hypothesis.

**Anti-hallucination / grounding rules (mandatory):**
- You do **not** have raw CSV rows. Judge only from the **text** below: initial analysis, quant output (if any), context & clarification, and the **data catalog** (dataset ids and descriptions).
- **Never invent** dataset ids, column names, or numbers. The only valid \`datasetId\` values for any suggested quant are **exactly** those listed under ALLOWED DATASET IDS — character-for-character.
- If you suggest \`suggested_followup_quant\`, it must use \`datasetId\` from that list and \`steps\` that only reference columns **named or clearly implied** in the catalog description for that dataset. If unsure of a column, do **not** put it in \`steps\`; instead add a string to \`refinement_directives\` like "Verify column X exists in crm/deal_data before quant".
- Do **not** claim specific cell values or aggregates exist unless they appear in the **quant block** or **context** text. You may say "a quant on crm/deal_data could test …" without fabricating outcomes.
- \`missed_catalog_opportunities\`: short strings; when pointing at data, include a valid dataset id from the allow list (e.g. "crm/deal_data: ACV trend by quarter could test cohort mix").
- If the analysis is sound and grounded, set \`adequately_addresses_hypothesis\` true and keep arrays empty and \`suggested_followup_quant\` null.

Overall goal:
${input.userGoal}

Context & clarification (excerpt may be long):
${input.discovery}

Path: ${input.pathTitles}

**Hypothesis (leaf question):**
${input.leafQuestion}

**Initial executive summary:**
${input.initialSummary}

**Initial full analysis (reasoning):**
${input.initialAnalysis}

**Stated verdict / confidence:** ${input.initialVerdict} / ${input.initialConfidence}

**Evidence gaps the analyst listed:**
${ev}

**Quant that ran (or error / none):**
${input.quantBlockForReview}

ALLOWED DATASET IDS (only these strings are valid \`datasetId\` / join \`rightDatasetId\`):
${input.allowedDatasetIdsBlock}

${input.dataCatalogMarkdown}

Output **one JSON object only** — first "{", last "}".

Shape:
{
  "adequately_addresses_hypothesis": boolean,
  "pressure_test_summary": "string, 2-5 sentences: does the analysis directly answer the hypothesis? logical gaps?",
  "analysis_alignment": "strong" | "moderate" | "weak",
  "missed_catalog_opportunities": ["short strings, optional dataset id from allow list"],
  "suggested_followup_quant": null OR { "hypothesis_under_test", "datasetId" (must be in allow list), "steps", optional "chart" },
  "refinement_directives": ["imperatives for the analyst's second pass, e.g. tighten verdict, add quant, address contradiction"]
}`;
}

export function leafAnalysisRefinementPrompt(input: {
  userGoal: string;
  discovery: string;
  pathTitles: string;
  leafQuestion: string;
  redirectContext?: string;
  dataCatalogMarkdown: string;
  priorAnalysisJson: string;
  managerReviewJson: string;
  /** Pre-validated quant hint from manager, or "(none)". */
  managerSuggestedQuantHint: string;
}): string {
  const steer =
    input.redirectContext?.trim() ?
      `\nUser steering notes (still apply):\n${input.redirectContext.trim()}\n`
    : "";

  return `You are revising a **leaf hypothesis analysis** after a **manager review**. Output a **full replacement** analysis in the **same JSON shape** as the first pass (not a diff). Integrate the manager's feedback; strengthen grounding; fix logic gaps.

${steer}
Overall goal:
${input.userGoal}

Context & clarification:
${input.discovery}

Path: ${input.pathTitles}
Hypothesis: ${input.leafQuestion}

**Prior analysis (JSON — your baseline; improve, do not ignore unless manager says it was wrong):**
${input.priorAnalysisJson}

**Manager review (JSON):**
${input.managerReviewJson}

**Manager-suggested quant (already validated against catalog; null if none):**
${input.managerSuggestedQuantHint}

Rules:
- Address \`refinement_directives\` and \`pressure_test_summary\` from the manager JSON. If \`suggested_followup_quant\` was provided above, you **should** usually set your output \`quant\` to that exact object (or a minor fix) and **not** invent a different dataset.
- **Anti-hallucination:** \`quant.datasetId\` and any join \`rightDatasetId\` must appear in the catalog markdown. Only use column names you can justify from catalog descriptions. If you cannot run a valid quant, set \`quant\` to null and explain in \`evidence_needed\`.
- \`verdict\` and \`confidence\` must reflect the **refined** reasoning.

${input.dataCatalogMarkdown}

${QUANT_PIPELINE_OPS_FOR_PROMPTS}

Output ONE JSON object only — same keys as the initial leaf analysis:
{
  "summary": "string",
  "analysis": "string",
  "hypothesis": null or "string",
  "verdict": "confirmed" | "refuted" | "inconclusive" | "partially_supported",
  "evidence_needed": ["string"],
  "confidence": "low" | "medium" | "high",
  "quant": null OR { "hypothesis_under_test", "datasetId", "steps", optional "chart" }
}`;
}

export type BranchRollupJson = {
  summary: string;
  analysis: string;
  verdict: string;
  confidence: string;
  evidence_needed?: string[];
};

/** Roll child hypothesis results into a parent-node hypothesis verdict + confidence. */
export function branchRollupPrompt(input: {
  userGoal: string;
  contextClarification: string;
  parentPathTitles: string;
  parentTitle: string;
  parentQuestion?: string;
  childSummariesMarkdown: string;
}): string {
  return `You **roll up** completed child analyses to judge the **parent node's own hypothesis**. Children may be leaf hypotheses or already-rolled sub-branches; each has a verdict, confidence, and summary. Treat their conclusions as **evidence** about whether the **parent's declarative claim** holds.

Overall goal:
${input.userGoal}

Context & clarification:
${input.contextClarification}

Parent path: ${input.parentPathTitles}
Parent title: ${input.parentTitle}
**Parent hypothesis under test** (this internal node's \`question\` — confirm, refute, or qualify it using children):
${input.parentQuestion?.trim() || "(none)"}

**Direct children:**
${input.childSummariesMarkdown}

Rules:
- **summary:** 2–4 sentences for executives — given child results, does the **parent hypothesis** stand, fail, or remain open?
- **analysis:** Plain text (no JSON inside). Explain how child verdicts bear on the **parent claim**; note conflicts or reinforcement.
- **verdict:** For the **parent hypothesis** (not a loose theme): "confirmed" | "refuted" | "inconclusive" | "partially_supported".
- **confidence:** Rolled-up "low" | "medium" | "high". Use **low** if children conflict materially or any child was low-confidence/skipped; **high** only if children align and are mostly high-confidence.
- **evidence_needed:** Gaps for judging the **parent hypothesis** that children did not resolve; [] if none.

Output ONE JSON object only. First "{", last "}".
Shape:
{
  "summary": "string",
  "analysis": "string",
  "verdict": "confirmed" | "refuted" | "inconclusive" | "partially_supported",
  "confidence": "low" | "medium" | "high",
  "evidence_needed": ["optional strings"]
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

Context & clarification:
${input.discovery}

Per-leaf analyses (deepest leaves — branch rollups appear in the UI but focus on leaf evidence here):
${input.analysesMarkdown}

Output template (fill in — keep this shape, same four sections, nothing else):

## Challenge assumptions
<direct, skeptical but constructive bullets or short prose>

## Contradictions / gaps
<…>

## What would change the recommendation
<…>

## Go / no-go checks for the next phase
<…>

Hard rules (do **not** write these rules in your output; obey them silently):
- Your reply must **begin** with the literal characters \`## Challenge assumptions\` — no role statement, preamble, checklist, quoted instructions, or bullets before it.
- Never wrap any part of the output in \`\`\` code fences.
- Never restate these rules or the template as bullets (e.g. do **not** write lines like "* First character must be \\#", "* No code fences", "* Exactly four sections").
- No extra sections; keep it tight and action-oriented.`;
}

export function synthesisPrompt(input: {
  userGoal: string;
  discovery: string;
  managerNotes: string;
  analysesMarkdown: string;
}): string {
  return `You are a synthesis agent. Output **short** markdown only — shaped **exactly** like the template below.

Goal:
${input.userGoal}

Context & clarification:
${input.discovery}

Manager critique:
${input.managerNotes}

Analyses:
${input.analysesMarkdown}

Output template (fill in — keep this shape, same three sections, nothing else):

**<one or two sentences answering the goal, the whole thing inside these double asterisks>**

- <first concrete support: numbers, facts from analyses, or tight reasoning>
- <second concrete support>
- <third concrete support>
- <up to 7 total>

## Open questions
- <what still needs more data, analysis, or decisions before acting; or the single line _None material — proceed with monitoring as above._>

Hard rules (do **not** write these rules in your output; obey them silently):
- Your reply must **begin** with the literal character \`*\` of the opening \`**\` of the bold recommendation — no prose, headings, preamble, role statement, checklist, or bullets before it.
- Never wrap any part of the output in \`\`\` code fences.
- Never restate these rules, the task, or the template as bullets (e.g. do **not** write lines like "* Start with **bold**", "* No code fences", "* 3-7 bullets", "* No H2 before", "* No labels"). They are instructions for you only.
- No "Supporting points" heading, no \`##\` heading before the bullets, no extra sections, no tables, no long prose.`;
}

export function partialManagerPrompt(input: {
  userGoal: string;
  discovery: string;
  analysesMarkdown: string;
}): string {
  return `You are a manager agent. The user paused the pipeline early — not every hypothesis leaf was analyzed.

Goal:
${input.userGoal}

Context & clarification:
${input.discovery}

Per-leaf analyses (some branches show "pending" or were skipped):
${input.analysesMarkdown}

Output template (fill in — keep this shape, same four sections, nothing else):

## Challenge assumptions (given partial coverage)
<direct, skeptical but constructive bullets or short prose; flag uncertainty from missing analyses>

## Biggest gaps from incomplete branches
<…>

## What to validate before acting
<…>

## Go / no-go checks
<…>

Hard rules (do **not** write these rules in your output; obey them silently):
- Your reply must **begin** with \`## Challenge assumptions\` — no role statement, preamble, checklist, or bullets before it.
- Never wrap any part of the output in \`\`\` code fences.
- Never restate these rules or the template as bullets (e.g. do **not** write lines like "* Exactly four sections", "* No code fences").
- No extra sections.`;
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

  return `You are a synthesis agent. The user requested an **early / partial** synthesis: not all branches were analyzed. Output **short** markdown only — shaped **exactly** like the template below.

Goal:
${input.userGoal}
${extra}
Context & clarification:
${input.discovery}

Manager critique:
${input.managerNotes}

Analyses (partial — note pending/skipped branches):
${input.analysesMarkdown}

Output template (fill in — keep this shape, same three sections, nothing else):

**Partial synthesis** — not all hypotheses were tested.

**<one or two sentences with the best-effort answer to the goal; if provisional, say so inside these double asterisks>**

- <first concrete support from a completed analysis: data or reasoning>
- <second concrete support>
- <optional bullet flagging something not analyzed that could change the answer>
- <up to 7 total>

## Open questions
- <gaps from incomplete branches, missing data, and what to analyze next before a final call>

Hard rules (do **not** write these rules in your output; obey them silently):
- Your reply must **begin** with \`**Partial synthesis**\` exactly — no prose, headings, preamble, role statement, checklist, or bullets before it.
- Never wrap any part of the output in \`\`\` code fences.
- Never restate these rules, the task, or the template as bullets (e.g. do **not** write lines like "* Start with **bold**", "* No code fences", "* 3-7 bullets").
- No other sections, tables, or long prose.`;
}
