import { dedentUniformIndent } from "./stripExecutiveMarkdownPreamble";

/**
 * Cleans hypothesis-tree manager review markdown: models often wrap prose in
 * fences, repeat role/instructions, or echo rubric bullets before real sections.
 * Idempotent enough for save + display.
 */
export function sanitizeManagerTreeReviewMarkdown(raw: string): string {
  let s = raw.trim();
  if (!s) return s;

  for (let depth = 0; depth < 4; depth++) {
    const whole = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*)\n```\s*$/i);
    if (whole) s = whole[1]!.trim();
    else break;
  }

  s = dedentUniformIndent(s);

  s = s.replace(/```(?:markdown|md)\s*\n([\s\S]*?)\n```/gi, (_, inner: string) => {
    const t = inner.trim();
    if (looksLikeJsonTree(t)) return "```json\n" + inner + "\n```";
    return t;
  });

  s = s.replace(/```\s*\n([\s\S]*?)\n```/g, (full, inner: string) => {
    const t = inner.trim();
    if (looksLikeJsonTree(t)) return full;
    if (/^#{1,6}\s/m.test(t) || /^[\s]*[*+-]\s/m.test(t)) return t;
    return full;
  });

  s = stripLeadingBeforeFirstHeading(s);

  s = s
    .replace(/\$\\rightarrow\$/g, "→")
    .replace(/\$\\Rightarrow\$/g, "⇒")
    .replace(/\$\\leftarrow\$/g, "←");

  return s.trim();
}

function looksLikeJsonTree(t: string): boolean {
  const u = t.trimStart();
  if (!u.startsWith("{")) return false;
  return u.includes('"roots"') || (u.includes('"id"') && u.includes('"question"'));
}

function stripLeadingBeforeFirstHeading(s: string): string {
  const lines = s.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]!)) return lines.slice(i).join("\n");
  }
  return s;
}
