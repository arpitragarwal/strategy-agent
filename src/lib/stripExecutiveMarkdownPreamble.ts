/**
 * Strip one or more leading ``` … ``` wrappers (model often fences the whole reply).
 */
export function unwrapLeadingMarkdownFences(text: string): string {
  let s = text.trim();
  if (!s) return s;
  for (let k = 0; k < 4; k++) {
    const t = s.trimStart();
    if (!t.startsWith("```")) break;
    const nl = t.indexOf("\n");
    if (nl === -1) break;
    const afterOpen = t.slice(nl + 1);
    const closeMatch = afterOpen.match(/\r?\n```\r?(?:\n|$)/);
    if (!closeMatch || closeMatch.index === undefined) break;
    s = afterOpen.slice(0, closeMatch.index).trim();
  }
  return s;
}

/**
 * Removes common model lead-in before executive markdown (manager critique, etc.):
 * - leading ``` fences
 * - mistaken list markers before headings (`* ## Foo` → `## Foo`)
 * - prose before the first real `## ` heading
 */
export function stripExecutiveMarkdownPreamble(text: string): string {
  let s = unwrapLeadingMarkdownFences(text);
  if (!s) return s;

  // `* ## Section` or `- ## Section` (invalid heading syntax → renders as body / code-ish)
  s = s.replace(/^(\s*)[*+-]\s+##\s/gm, "$1## ");

  const lines = s.split(/\r?\n/);
  const hIdx = lines.findIndex((line) => /^##\s+/.test(line.trimStart()));
  if (hIdx === -1) return s.trim();
  return lines.slice(hIdx).join("\n").trim();
}

/** Unwrap ``` / ```markdown segments whose body is prose (## headings or bullets), not JSON. */
function unwrapEmbeddedProseCodeFences(s: string): string {
  let out = s.replace(/```(?:markdown|md)\s*\n([\s\S]*?)\n```/gi, (_, inner: string) => {
    const t = inner.trim();
    if (/^\s*\{/.test(t) && /"(roots|quant_plans|specificity_notes)"\s*:/.test(t)) {
      return "```json\n" + inner + "\n```";
    }
    return t;
  });
  out = out.replace(/```\s*\n([\s\S]*?)\n```/g, (full, inner: string) => {
    const t = inner.trim();
    if (/^\s*[\[{]/.test(t) && /"(roots|id|hypothesis)"\s*:/.test(t)) return full;
    if (/^##\s/m.test(t) || /^[\s]*[*+-]\s/m.test(t)) return t;
    return full;
  });
  return out;
}

/**
 * Context & clarification brief: models often fence a Memory/Analyses recap or glue "## Themes"
 * onto one line, which renders as a redundant code block. Idempotent for save + display.
 */
export function sanitizeDiscoveryMarkdown(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  s = unwrapLeadingMarkdownFences(s);
  s = unwrapEmbeddedProseCodeFences(s);
  // Glued section heading after a sentence (e.g. "...data-driven.## Themes")
  s = s.replace(
    /\.(##\s+(?:Themes|Problems|Opportunities|Data-backed|Open questions|Questions for you|Suggested focus)\b)/g,
    ".\n\n$1",
  );
  s = s.replace(
    /([a-z0-9)])(##\s+(?:Themes|Problems|Opportunities|Data-backed|Open questions|Questions for you|Suggested focus)\b)/gi,
    "$1\n\n$2",
  );
  s = s.replace(/^(\s*)[*+-]\s+##\s/gm, "$1## ");
  s = stripExecutiveMarkdownPreamble(s);
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/** Leading bullets that echo the synthesis prompt's formatting rules (not user-facing content). */
function isSynthesisFormattingEchoLine(t: string): boolean {
  const u = t.trim();
  if (!/^\*\s/.test(u) || u.length > 220) return false;
  // Single-line literal: line breaks inside `/.../` are invalid in JS.
  if (
    /^\*\s*(?:\*\s*)?(short\s+markdown\.?|no\s+code\s+fences?|no\s+meta\s+bullet[^.]*|start\s+with\s+\*\*bold|followed\s+by\s+3[-–]7|ending\s+with.{0,48}open\s+questions|no\s+generic\s+boilerplate|no\s+prose\s+before|no\s+labels?\s+like)\b/i.test(
      u,
    )
  ) {
    return true;
  }
  if (
    /^\*\s*(Bold|bolded|3-7|No H2|Supporting|Self-check|Verification|bullet|Open questions|markdown|summary|boilerplate|concrete support|heading)\b/i.test(
      u,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Cleans synthesis output: unwrap ``` fences, drop self-check / instruction echo bullets,
 * fix `?Yes.**` glued to bold, then trim everything before the first real **…** lead line.
 */
export function stripSynthesisMarkdown(text: string): string {
  let s = unwrapLeadingMarkdownFences(text);
  if (!s) return s;
  s = unwrapEmbeddedProseCodeFences(s);

  // Model sometimes glues checklist "Yes." to the bold summary: `? Yes.**Reduce...`
  s = s.replace(/\?\s*Yes\.?\s*(\*\*)/gi, "\n\n$1");
  s = s.replace(/\?\s*No\.?\s*(\*\*)/gi, "\n\n$1");

  const lines = s.split(/\r?\n/);
  const cleaned: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();
    if (t === "") {
      i++;
      continue;
    }
    if (/^\*\s*.+\?\s*(Yes|No)\.?\s*$/i.test(t)) {
      i++;
      continue;
    }
    if (isSynthesisFormattingEchoLine(t)) {
      i++;
      continue;
    }
    break;
  }
  for (; i < lines.length; i++) cleaned.push(lines[i]);
  s = cleaned.join("\n").trim();

  const outLines = s.split(/\r?\n/);
  const boldIdx = outLines.findIndex((line) => line.trimStart().startsWith("**"));
  if (boldIdx > 0) {
    s = outLines.slice(boldIdx).join("\n").trim();
  }

  // Drop a lone role line if it survived before bullets (no **)
  s = s.replace(/^You are a synthesis[^\n]*\n+/i, "");
  s = s.replace(/^Synthesis agent[^\n]*\n+/i, "");

  return s.replace(/\n{3,}/g, "\n\n").trim();
}
