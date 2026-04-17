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
 * Strip a uniform leading indent across non-empty lines (e.g. models indenting
 * the whole reply by 4+ spaces, which would render as a `<pre><code>` block).
 */
export function dedentUniformIndent(s: string): string {
  const lines = s.split(/\r?\n/);
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = l.match(/^( +)/);
    const n = m ? m[1].length : 0;
    if (n < min) min = n;
    if (min === 0) break;
  }
  if (!Number.isFinite(min) || min <= 0) return s;
  const cut = min as number;
  return lines.map((l) => (l.trim() ? l.slice(cut) : l)).join("\n");
}

/**
 * Removes common model lead-in before executive markdown (manager critique, etc.):
 * - leading ``` fences
 * - uniform 4+ space indent across non-empty lines (would render as code block)
 * - mistaken list markers before headings (`* ## Foo` → `## Foo`)
 * - prose before the first real `## ` heading
 */
export function stripExecutiveMarkdownPreamble(text: string): string {
  let s = unwrapLeadingMarkdownFences(text);
  if (!s) return s;
  s = dedentUniformIndent(s);

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
  if (!/^\*\s/.test(u) || u.length > 240) return false;
  // Patterns copied from the synthesis prompt (model sometimes restates them as a checklist).
  const phrases = [
    /short\s+markdown\b/,
    /no\s+code\s+fences?/,
    /no\s+meta\s+bullet/,
    /start\s+with\s+\*?\*?bold/,
    /\bbold\s+recommendation\b/,
    /\bbold\s+summary\b/,
    /followed\s+by\s+3[-–]7/,
    /\b3[-–]7\s+bullet/,
    /bullet\s+points?\s+of\s+concrete\s+support/,
    /concrete\s+support/,
    /ending\s+with.{0,48}open\s+questions/,
    /\bopen\s+questions?\b[^.]*\bsection\b/,
    /no\s+generic\s+boilerplate/,
    /no\s+prose\s+before/,
    /no\s+labels?\s+like/,
    /no\s+h2\s+before/,
    /no\s+"?supporting\s+points"?\s+heading/,
  ];
  if (phrases.some((re) => re.test(u.toLowerCase()))) return true;
  // Fallback keyword heads seen in older outputs.
  if (
    /^\*\s*(?:\*\s*)?(Bold|bolded|3-7|No H2|Supporting|Self-check|Verification|bullet|Open questions|markdown|summary|boilerplate|heading)\b/i.test(
      u,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * If the first block of non-empty lines is uniformly indented by 4+ spaces
 * and consists of bullets, ReactMarkdown renders it as a code block. De-indent
 * so the individual rule-echo / other detection can then decide what to drop.
 */
function dedentLeadingIndentedBlock(s: string): string {
  const lines = s.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const start = i;
  // Scan contiguous non-empty block
  while (i < lines.length && lines[i].trim() !== "") i++;
  if (i === start) return s;
  const block = lines.slice(start, i);
  const allIndentedBullets = block.every((l) => /^\s{4,}[*+\-]\s/.test(l));
  if (!allIndentedBullets) return s;
  const deindented = block.map((l) => l.replace(/^\s+/, ""));
  return [...lines.slice(0, start), ...deindented, ...lines.slice(i)].join("\n");
}

/**
 * Cleans synthesis output: unwrap ``` fences, drop self-check / instruction echo bullets,
 * fix `?Yes.**` glued to bold, then trim everything before the first real **…** lead line.
 */
export function stripSynthesisMarkdown(text: string): string {
  let s = unwrapLeadingMarkdownFences(text);
  if (!s) return s;
  s = unwrapEmbeddedProseCodeFences(s);
  s = dedentLeadingIndentedBlock(s);

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
