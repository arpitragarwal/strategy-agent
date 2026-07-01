/**
 * One-time (re-runnable) ingestion of the Drop reference docs into Postgres.
 *
 * Reads private/drop_documents.csv (title, description, link), fetches each
 * doc's server-rendered page at {DROP_BASE_URL}/s/{token} using your Drop
 * session cookie, strips the app chrome, converts the content to markdown,
 * and upserts it into the ContextDocument table. Re-running skips docs whose
 * content hash is unchanged.
 *
 * Auth: put your Drop instance and cookie in .env as
 *     DROP_BASE_URL=https://your-drop-instance.example.com
 *     DROP_COOKIE=auth_token=...; bi_session=...
 * (grab the cookie from a logged-in browser session; it is short-lived).
 *
 * Run:
 *     node --env-file=.env scripts/ingest-drop-docs.mjs           # all docs
 *     node --env-file=.env scripts/ingest-drop-docs.mjs --limit 3 # first N (smoke test)
 *     node --env-file=.env scripts/ingest-drop-docs.mjs --dry     # fetch+parse, no DB writes
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import TurndownService from "turndown";

const ROOT = new URL("..", import.meta.url).pathname;
const CSV_PATH = `${ROOT}private/drop_documents.csv`;
const BASE = process.env.DROP_BASE_URL;
const CONCURRENCY = 6;

if (!BASE) throw new Error("DROP_BASE_URL missing from .env");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i >= 0 ? parseInt(args[i + 1], 10) : Infinity;
})();

// Cookie: read straight from .env (value contains '=' and ';', so take the remainder verbatim).
function readCookie() {
  const line = readFileSync(`${ROOT}.env`, "utf8")
    .split("\n")
    .find((l) => l.startsWith("DROP_COOKIE="));
  if (!line) throw new Error("DROP_COOKIE missing from .env");
  let v = line.slice("DROP_COOKIE=".length).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!v) throw new Error("DROP_COOKIE is empty");
  return v;
}

// Minimal RFC-4180 CSV parser (handles quoted fields, embedded commas/newlines/quotes).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function tokenFromLink(link) {
  const m = link.trim().match(/\/s\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.remove(["script", "style", "noscript"]);
// Images carry no text signal and, when base64 data-URIs, bloat docs to multi-MB.
// Keep only the alt text (usually a short caption).
turndown.addRule("dropImages", {
  filter: "img",
  replacement: (_content, node) => {
    const alt = (node.getAttribute("alt") || "").trim();
    return alt && !alt.startsWith("data:") ? `[image: ${alt}]` : "";
  },
});

// Hard ceiling on stored text; anything past this is almost certainly embedded
// data, not prose. Hydration applies a tighter per-doc budget at retrieval time.
const MAX_CONTENT_CHARS = 200_000;

// Remove a balanced <tag>…</tag> block starting at `openIdx` (handles nesting of the same tag).
function cutBalanced(html, openIdx, tag) {
  const openRe = new RegExp(`<${tag}\\b`, "gi");
  const closeRe = new RegExp(`</${tag}>`, "gi");
  let depth = 0, i = openIdx;
  openRe.lastIndex = openIdx;
  while (i < html.length) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    if (!nextClose) return html.length;
    if (nextOpen && nextOpen.index < nextClose.index) { depth++; i = nextOpen.index + 1; }
    else { depth--; i = nextClose.index + `</${tag}>`.length; if (depth === 0) return i; }
  }
  return html.length;
}

// Every doc is served inside Drop's chrome: a `<header class="drop-nav">` bar and a
// `<div class="df-nav-row">` footer, injected into <body>. Strip both and keep the rest
// (works whether the doc uses the app `.wrap` shell or is a standalone HTML upload).
function extractContentHtml(html) {
  const bodyStart = html.indexOf("<body");
  const bodyEnd = html.indexOf("</body>");
  let out = html.slice(bodyStart >= 0 ? html.indexOf(">", bodyStart) + 1 : 0, bodyEnd >= 0 ? bodyEnd : html.length);

  // Drop the top nav (<header …drop-nav…>…</header>).
  const navOpen = out.search(/<header\b[^>]*class="[^"]*drop-nav[^"]*"/i);
  if (navOpen >= 0) out = out.slice(0, navOpen) + out.slice(cutBalanced(out, navOpen, "header"));

  // Drop the footer nav row (Drop · Upload · Browse) to the end of its wrapper.
  const footOpen = out.indexOf('<div class="df-nav-row">');
  if (footOpen >= 0) out = out.slice(0, footOpen) + out.slice(cutBalanced(out, footOpen, "div"));

  return out;
}

function extractTopics(contentHtml) {
  const tags = [...contentHtml.matchAll(/<span class="df-tag">([^<]*)<\/span>/g)].map((m) => m[1].trim());
  return [...new Set(tags.filter(Boolean))].join(", ");
}

function htmlToMarkdown(contentHtml) {
  let md = turndown.turndown(contentHtml);
  // Scrub any stray base64 data-URIs turndown may have kept (e.g. in links).
  md = md.replace(/data:[a-z0-9/;=+._-]{40,}/gi, "[data]");
  md = md.replace(/\n{3,}/g, "\n\n").trim();
  if (md.length > MAX_CONTENT_CHARS) md = md.slice(0, MAX_CONTENT_CHARS) + "\n\n…[truncated]";
  return md;
}

async function fetchDoc(token, cookie, attempt = 1) {
  try {
    const res = await fetch(`${BASE}/s/${token}`, { headers: { cookie, accept: "text/html" } });
    if (res.status === 401 || res.status === 403) throw new Error(`AUTH ${res.status} — cookie expired? Re-grab DROP_COOKIE.`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (attempt < 3 && !String(e.message).startsWith("AUTH")) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      return fetchDoc(token, cookie, attempt + 1);
    }
    throw e;
  }
}

async function main() {
  const cookie = readCookie();
  const rows = parseCsv(readFileSync(CSV_PATH, "utf8"));
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  const ci = { title: header.indexOf("title"), description: header.indexOf("description"), link: header.indexOf("link") };
  if (ci.link < 0) throw new Error("CSV missing a 'link' column");

  const docs = rows
    .filter((r) => r[ci.link]?.trim())
    .map((r) => ({
      title: (r[ci.title] || "").trim(),
      description: (r[ci.description] || "").trim(),
      url: r[ci.link].trim(),
      shareToken: tokenFromLink(r[ci.link]),
    }))
    .filter((d) => d.shareToken)
    .slice(0, LIMIT);

  console.log(`${docs.length} docs to ingest${DRY ? " (DRY RUN — no writes)" : ""}. Concurrency=${CONCURRENCY}.`);
  const prisma = DRY ? null : new PrismaClient();

  let done = 0, upserted = 0, skipped = 0, failed = 0;
  const failures = [];
  const queue = [...docs];
  async function worker() {
    while (queue.length) {
      const d = queue.shift();
      try {
        const html = await fetchDoc(d.shareToken, cookie);
        const contentHtml = extractContentHtml(html);
        const content = htmlToMarkdown(contentHtml);
        const topics = extractTopics(contentHtml);
        if (!content || content.length < 20) throw new Error(`empty content (len=${content.length})`);
        const contentHash = createHash("sha256").update(content).digest("hex");

        if (prisma) {
          const existing = await prisma.contextDocument.findUnique({ where: { shareToken: d.shareToken }, select: { contentHash: true } });
          if (existing?.contentHash === contentHash) { skipped++; }
          else {
            upserted++;
            await prisma.contextDocument.upsert({
              where: { shareToken: d.shareToken },
              create: { shareToken: d.shareToken, url: d.url, title: d.title, description: d.description, content, contentHash, topics, fetchedAt: new Date() },
              update: { url: d.url, title: d.title, description: d.description, content, contentHash, topics, fetchedAt: new Date() },
            });
          }
        }
        done++;
        if (done % 25 === 0 || DRY) console.log(`  ${done}/${docs.length}  [${d.shareToken}] ${d.title.slice(0, 50)} — ${content.length} chars${topics ? `, topics: ${topics}` : ""}`);
      } catch (e) {
        failed++;
        failures.push(`${d.shareToken} (${d.title.slice(0, 40)}): ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (prisma) await prisma.$disconnect();

  console.log(`\nDone. processed=${done} upserted=${upserted} skipped(unchanged)=${skipped} failed=${failed}`);
  if (failures.length) { console.log("Failures:"); failures.slice(0, 30).forEach((f) => console.log("  - " + f)); }
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
