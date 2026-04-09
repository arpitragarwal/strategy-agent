import { prisma } from "./db";
import { flattenLeaves, normalizeOutlineDoc, pathToNode } from "./outline";

function isPayloadRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Build text from one saved run (outputs only) for model context — same shape as legacy discovery memory block. */
export function formatMemoryArtifactDigest(payload: unknown, summaryFallback: string): string {
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

const MAX_SEARCH_RESULT_CHARS = 12_000;
const CANDIDATE_POOL = 30;
const MAX_ARTIFACTS_RETURNED = 5;

/**
 * Keyword scan of recent Memory — like a repository search from agent-chosen queries.
 * Returns markdown for the context & clarification step; empty if nothing scores.
 */
export async function searchStrategyMemory(queries: string[]): Promise<string> {
  const normalized = queries
    .flatMap((q) => String(q).toLowerCase().split(/\s+/))
    .map((t) => t.replace(/[^a-z0-9_-]/g, ""))
    .filter((t) => t.length > 2);
  const uniqueTokens = [...new Set(normalized)];
  if (!uniqueTokens.length) {
    return "";
  }

  const artifacts = await prisma.memoryArtifact.findMany({
    orderBy: { createdAt: "desc" },
    take: CANDIDATE_POOL,
    select: {
      id: true,
      summary: true,
      topics: true,
      payload: true,
      createdAt: true,
      runId: true,
    },
  });

  const scoreRow = (a: (typeof artifacts)[number]): number => {
    const syn =
      isPayloadRecord(a.payload) && typeof a.payload.synthesis === "string" ?
        a.payload.synthesis.slice(0, 2500)
      : "";
    const hay = `${a.summary}\n${a.topics}\n${syn}`.toLowerCase();
    let s = 0;
    for (const t of uniqueTokens) {
      if (hay.includes(t)) s += 2;
    }
    for (const q of queries) {
      const phrase = String(q).toLowerCase().trim();
      if (phrase.length > 3 && hay.includes(phrase)) s += 5;
    }
    return s;
  };

  const ranked = artifacts
    .map((a) => ({ a, sc: scoreRow(a) }))
    .filter((x) => x.sc > 0)
    .sort((x, y) => y.sc - x.sc)
    .slice(0, MAX_ARTIFACTS_RETURNED)
    .map((x) => x.a);

  if (!ranked.length) {
    return "_Memory search returned no matching excerpts for those queries._";
  }

  const blocks: string[] = [];
  for (const a of ranked) {
    const body = formatMemoryArtifactDigest(a.payload, a.summary);
    if (body.trim()) {
      const stamp = a.createdAt.toISOString().slice(0, 10);
      blocks.push(`### Hit (${stamp}${a.runId ? ` · ${a.runId.slice(-6)}` : ""})\n\n${body}`);
    }
  }

  const merged = blocks.join("\n\n---\n\n");
  if (merged.length <= MAX_SEARCH_RESULT_CHARS) return merged;
  return `${merged.slice(0, MAX_SEARCH_RESULT_CHARS)}\n\n_(results truncated)_`;
}
