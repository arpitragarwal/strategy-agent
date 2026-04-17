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

/**
 * Cleans synthesis output: unwrap ``` fences, drop self-check / instruction echo bullets,
 * fix `?Yes.**` glued to bold, then trim everything before the first real **…** lead line.
 */
export function stripSynthesisMarkdown(text: string): string {
  let s = unwrapLeadingMarkdownFences(text);
  if (!s) return s;

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
    if (
      /^\*\s*(Bold|bolded|3-7|No H2|Supporting|Self-check|Verification|bullet|Open questions|markdown|summary|boilerplate|concrete support|heading)\b/i.test(
        t,
      ) &&
      t.length < 180
    ) {
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
