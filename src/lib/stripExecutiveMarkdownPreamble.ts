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
  if (!/^[*+-]\s/.test(u) || u.length > 240) return false;
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
    /^[*+-]\s*(?:\*\s*)?(Bold|bolded|3-7|No H2|Supporting|Self-check|Verification|bullet|Open questions|markdown|summary|boilerplate|heading)\b/i.test(
      u,
    )
  ) {
    return true;
  }
  return false;
}

/** Bullet ending in a self-check answer like `? Yes.`, `? Yes (5).`, `? No – because …`. */
function isSelfCheckBulletLine(t: string): boolean {
  return /^[*+-]\s+.+\?\s*(Yes|No)\b[^?]{0,80}$/i.test(t);
}

/** Bullet whose content is a recap of an input section label (Themes/Problems/Analyses/…). */
function isContextRecapBulletLine(t: string): boolean {
  const m = t.match(/^[*+-]\s+\*{0,2}\s*([^*:]{1,60}?)\s*\*{0,2}\s*:/);
  if (!m) return false;
  const label = m[1].trim().toLowerCase();
  return (
    label === "themes" ||
    label === "theme" ||
    label === "problems" ||
    label === "problem" ||
    label === "risks" ||
    label === "risk" ||
    label === "problems/risks" ||
    label === "problems / risks" ||
    label === "opportunities" ||
    label === "opportunity" ||
    label === "data-backed specificity" ||
    label === "data backed specificity" ||
    label === "data-backed" ||
    label === "manager critique" ||
    label === "manager feedback" ||
    label === "manager notes" ||
    label === "manager" ||
    label === "analyses" ||
    label === "analysis" ||
    label === "analysis summary" ||
    label === "user goal" ||
    label === "goal" ||
    label === "context" ||
    label === "context & clarification" ||
    label === "context and clarification" ||
    label === "clarification" ||
    label === "per-leaf analyses" ||
    label === "hypotheses"
  );
}

/** Bullet that echoes the user goal as a question: `* **What is driving X?** …` / `* **How can we fix Y?** …` */
function isGoalEchoQuestionBullet(t: string): boolean {
  return /^[*+-]\s+\*\*(?:What|Why|How|When|Where|Which|Who)\b[^*]{0,240}\?\*\*/i.test(t);
}

/** Any of the above — used to skip leading junk and to drop isolated echo bullets inside the body. */
function isLeadingJunkBullet(t: string): boolean {
  if (!/^[*+-]\s/.test(t)) return false;
  if (isSelfCheckBulletLine(t)) return true;
  if (isSynthesisFormattingEchoLine(t)) return true;
  if (isContextRecapBulletLine(t)) return true;
  if (isGoalEchoQuestionBullet(t)) return true;
  return false;
}

/**
 * If the first block of non-empty lines is uniformly indented by 4+ spaces
 * (which ReactMarkdown/GFM would render as a <pre><code>), strip the common
 * minimum indent so later line-based cleaning can run. Preserves relative
 * nesting (doesn't flatten) so children of a labelled bullet still render
 * correctly after the label itself is removed.
 */
function dedentLeadingIndentedBlock(s: string): string {
  const lines = s.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const start = i;
  while (i < lines.length && lines[i].trim() !== "") i++;
  if (i === start) return s;
  const block = lines.slice(start, i);
  if (!/^\s{4,}[*+\-]\s/.test(block[0])) return s;
  let min = Infinity;
  for (const l of block) {
    const m = l.match(/^( *)/);
    const n = m ? m[1].length : 0;
    if (n < min) min = n;
  }
  if (!Number.isFinite(min) || min <= 0) return s;
  const cut = min as number;
  const deindented = block.map((l) => l.slice(cut));
  return [...lines.slice(0, start), ...deindented, ...lines.slice(i)].join("\n");
}

/** Any structural label bullet (e.g. `* **Supporting points:**`, `* **Open Questions:**`) —
 *  used so `consumeDedentedChildren` stops before eating the next label.
 */
const STRUCTURAL_LABEL_BULLET_RE =
  /^\s*[*+-]\s+\*\*\s*(?:Supporting\s+points?|Bullets?|Findings|Key\s+findings?|Key\s+points?|Evidence|Points?|Details?|Open\s+[Qq]uestions?|Recommendation|Answer|Bottom\s+line|Summary|Conclusion|Key\s+takeaway|Takeaway|TL;DR)s?\s*:?\s*\*\*\s*:?\s*$/i;

/** Dedent a contiguous run of indented child bullets/numbered items to flush top-level `- …`. */
function consumeDedentedChildren(lines: string[], startIdx: number, out: string[]): number {
  let j = startIdx;
  let consumedAny = false;
  while (j < lines.length) {
    const nl = lines[j];
    if (nl.trim() === "") {
      if (!consumedAny) {
        j++;
        continue;
      }
      let k = j + 1;
      while (k < lines.length && lines[k].trim() === "") k++;
      if (
        k < lines.length &&
        /^\s+([*+\-]|\d+\.)\s+/.test(lines[k]) &&
        !STRUCTURAL_LABEL_BULLET_RE.test(lines[k])
      ) {
        j = k;
        continue;
      }
      break;
    }
    if (STRUCTURAL_LABEL_BULLET_RE.test(nl)) break;
    const mm = nl.match(/^\s+([*+\-]|\d+\.)\s+(.*)$/);
    if (!mm) break;
    out.push(`- ${mm[2].trim()}`);
    consumedAny = true;
    j++;
  }
  return j;
}

/**
 * Cleans synthesis output: unwrap ``` fences, drop self-check / instruction / context-echo bullets,
 * unwrap template-label bullets (`* **Recommendation:** X` → `**X**`, `* **Supporting points:**` and
 * `* **Open Questions:**` → proper shape), fix `?Yes.**` glued to bold, then trim everything before
 * the first real **…** lead line.
 */
export function stripSynthesisMarkdown(text: string): string {
  let s = unwrapLeadingMarkdownFences(text);
  if (!s) return s;
  s = unwrapEmbeddedProseCodeFences(s);
  s = dedentLeadingIndentedBlock(s);

  // Model sometimes glues checklist "Yes." to the bold summary: `? Yes.**Reduce...`
  s = s.replace(/\?\s*Yes\.?\s*(\*\*)/gi, "\n\n$1");
  s = s.replace(/\?\s*No\.?\s*(\*\*)/gi, "\n\n$1");

  // Pass 1: drop leading junk bullets (self-check / rule-echo / context-recap / goal-echo Q&A)
  //         until the first "real" content line. When a context-recap label ends with `:` (no
  //         content on the same line), also consume its indented child bullets — otherwise a
  //         `* Analyses:` drop would leave the nested leaf-analysis bullets orphaned.
  const l1 = s.split(/\r?\n/);
  let i = 0;
  while (i < l1.length) {
    const raw = l1[i];
    const t = raw.trim();
    if (t === "") { i++; continue; }
    if (isLeadingJunkBullet(t)) {
      const endsWithColon = /:\s*$/.test(t);
      i++;
      if (endsWithColon) {
        while (i < l1.length) {
          const nl = l1[i];
          if (nl.trim() === "") { i++; continue; }
          if (/^\s+[*+\-]\s/.test(nl) || /^\s+\d+\.\s/.test(nl)) { i++; continue; }
          break;
        }
      }
      continue;
    }
    break;
  }
  s = l1.slice(i).join("\n").trim();

  // Pass 2: line-by-line structural rewrites.
  const lines = s.split(/\r?\n/);
  const out: string[] = [];
  const summaryRe =
    /^[*+-]\s+\*\*\s*(?:Recommendation|Answer|Bottom\s+line|Summary|Conclusion|Key\s+takeaway|Takeaway|TL;DR)s?\s*:?\s*\*\*\s*:?\s*(.+?)\s*$/i;
  const childrenLabelRe =
    /^[*+-]\s+\*\*\s*(?:Supporting\s+points?|Bullets?|Findings|Key\s+findings?|Key\s+points?|Evidence|Points?|Details?)\s*:?\s*\*\*\s*:?\s*$/i;
  const openQLabelRe = /^[*+-]\s+\*\*\s*Open\s+[Qq]uestions?\s*:?\s*\*\*\s*:?\s*$/i;

  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    const t = line.trim();

    const mSummary = t.match(summaryRe);
    if (mSummary) {
      let content = mSummary[1].trim();
      const innerBold = content.match(/^\*\*(.+?)\*\*\s*$/);
      if (innerBold) content = innerBold[1].trim();
      content = content.replace(/\*\*/g, "").trim();
      if (content) {
        if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
        out.push(`**${content}**`);
        out.push("");
      }
      continue;
    }

    if (openQLabelRe.test(t)) {
      if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
      out.push("## Open questions");
      k = consumeDedentedChildren(lines, k + 1, out) - 1;
      continue;
    }

    if (childrenLabelRe.test(t)) {
      k = consumeDedentedChildren(lines, k + 1, out) - 1;
      continue;
    }

    // Drop stray echo/recap bullets that slipped past the leading pass.
    if (isContextRecapBulletLine(t) || isSelfCheckBulletLine(t) || isGoalEchoQuestionBullet(t)) {
      continue;
    }

    out.push(line);
  }

  s = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // Promote the first standalone bold line to the top if junk remains before it.
  const outLines = s.split(/\r?\n/);
  const boldIdx = outLines.findIndex((line) => {
    const t = line.trimStart();
    return t.startsWith("**") && !t.startsWith("***") && !/^[*+-]\s/.test(line.trimStart());
  });
  if (boldIdx > 0) {
    s = outLines.slice(boldIdx).join("\n").trim();
  }

  // Drop a lone role line if it survived before bullets (no **)
  s = s.replace(/^You are a synthesis[^\n]*\n+/i, "");
  s = s.replace(/^Synthesis agent[^\n]*\n+/i, "");

  return s.replace(/\n{3,}/g, "\n\n").trim();
}
