import { prisma } from "./db";
import { generateJson } from "./genai";
import { documentSelectionPrompt } from "./agents/prompts";

/**
 * Retrieval over the Drop reference corpus (ContextDocument table, populated by
 * scripts/ingest-drop-docs.mjs). Two-tier "manifest select":
 *
 *   1. Keyword pre-filter the corpus down to a small candidate pool. This keeps
 *      the manifest small enough to fit any model's context (the whole 478-doc
 *      manifest would be ~30k tokens — fine on Sonnet, too big for Gemma).
 *   2. Hand that compact manifest (title + description) to the model, which
 *      returns the ids of the handful actually worth reading.
 *   3. Hydrate the selected docs' full text (budget-trimmed) into a markdown
 *      block injected alongside prior-run Memory in the context step.
 */

const CANDIDATE_POOL = 40; // docs shown to the model for final selection
const MAX_DOCS_RETURNED = 6; // docs whose full text we hydrate
const PER_DOC_CHARS = 6_000; // per-doc hydration cap (~1.5k tokens)
const TOTAL_CHARS = 24_000; // overall injected-block cap

type CandidateRow = {
  shareToken: string;
  url: string;
  title: string;
  description: string;
  topics: string;
};

/** Split free text into scorable tokens (mirrors searchStrategyMemory). */
function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/\s+/)
        .map((t) => t.replace(/[^a-z0-9_-]/g, ""))
        .filter((t) => t.length > 2),
    ),
  ];
}

/** Keyword-rank the corpus against the goal; returns the top candidate pool. */
async function prefilter(goalText: string): Promise<CandidateRow[]> {
  const tokens = tokenize(goalText);
  if (!tokens.length) return [];

  const rows = await prisma.contextDocument.findMany({
    select: { shareToken: true, url: true, title: true, description: true, topics: true },
  });

  const score = (r: CandidateRow): number => {
    const hay = `${r.title}\n${r.description}\n${r.topics}`.toLowerCase();
    let s = 0;
    for (const t of tokens) if (hay.includes(t)) s += hay === r.title.toLowerCase() ? 3 : 2;
    // Title matches are worth more.
    const titleLc = r.title.toLowerCase();
    for (const t of tokens) if (titleLc.includes(t)) s += 2;
    return s;
  };

  return rows
    .map((r) => ({ r, sc: score(r) }))
    .filter((x) => x.sc > 0)
    .sort((x, y) => y.sc - x.sc)
    .slice(0, CANDIDATE_POOL)
    .map((x) => x.r);
}

/** Ask the model which candidates are worth reading; falls back to top-scored on failure. */
async function selectDocuments(goalText: string, candidates: CandidateRow[]): Promise<CandidateRow[]> {
  if (candidates.length <= 1) return candidates;

  const manifest = candidates
    .map((c, i) => `${i + 1}. ${c.title}${c.topics ? ` [${c.topics}]` : ""} — ${c.description}`)
    .join("\n");

  try {
    const res = await generateJson<{ doc_ids: number[] }>(
      documentSelectionPrompt(goalText, manifest, MAX_DOCS_RETURNED),
      { repairHint: 'Keys: "doc_ids" (array of integers referencing the numbered list; [] if none relevant).' },
    );
    const ids = Array.isArray(res.doc_ids) ? res.doc_ids : [];
    const picked = ids
      .map((n) => candidates[Number(n) - 1])
      .filter((c): c is CandidateRow => Boolean(c))
      .slice(0, MAX_DOCS_RETURNED);
    // Empty is a valid answer ("nothing relevant") — respect it.
    return picked;
  } catch {
    // Selection call failed — degrade to the top keyword hits rather than nothing.
    return candidates.slice(0, 3);
  }
}

/** Pull full text for the selected docs and format a budgeted markdown block. */
async function hydrate(selected: CandidateRow[]): Promise<string> {
  if (!selected.length) return "";
  const rows = await prisma.contextDocument.findMany({
    where: { shareToken: { in: selected.map((s) => s.shareToken) } },
    select: { shareToken: true, url: true, title: true, content: true },
  });
  const byToken = new Map(rows.map((r) => [r.shareToken, r]));

  const blocks: string[] = [];
  let budget = TOTAL_CHARS;
  for (const sel of selected) {
    const row = byToken.get(sel.shareToken);
    if (!row || !row.content.trim() || budget <= 0) continue;
    let body = row.content.trim();
    if (body.length > PER_DOC_CHARS) body = `${body.slice(0, PER_DOC_CHARS)}\n\n…[doc truncated]`;
    if (body.length > budget) body = `${body.slice(0, budget)}\n\n…[doc truncated]`;
    budget -= body.length;
    // Unambiguous delimiter — doc bodies contain their own #/##/### headings, so a
    // heading-based title would blur where one document ends and the next begins.
    blocks.push(`===== REFERENCE DOCUMENT: ${row.title} =====\nSource: ${row.url}\n\n${body}`);
  }
  return blocks.join("\n\n");
}

/**
 * Retrieve relevant reference-doc context for a run's goal. Returns a markdown
 * block (empty string when nothing relevant, retrieval is disabled, or the
 * corpus is empty). Never throws — retrieval is best-effort context.
 */
export async function retrieveDocumentContext(goalText: string): Promise<string> {
  if (process.env.CONTEXT_DOCS_ENABLED === "0") return "";
  try {
    const candidates = await prefilter(goalText);
    if (!candidates.length) return "";
    const selected = await selectDocuments(goalText, candidates);
    return await hydrate(selected);
  } catch {
    return "";
  }
}
