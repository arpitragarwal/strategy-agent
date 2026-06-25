/**
 * Pre-flight check for SQL emitted by the quant agent. Rejects anything that
 * isn't a single read-only statement and injects a row cap if none is given.
 *
 * This is the only safety boundary today — the DuckDB connection is in-memory
 * read-write because read-only mode is incompatible with `:memory:`. See
 * `duckdb.ts`.
 */

const FORBIDDEN_KEYWORDS = [
  "DROP",
  "DELETE",
  "INSERT",
  "UPDATE",
  "TRUNCATE",
  "CREATE",
  "ALTER",
  "ATTACH",
  "DETACH",
  "COPY",
  "PRAGMA",
  "INSTALL",
  "LOAD",
  "EXPORT",
  "IMPORT",
  "SET",
  "RESET",
  "CALL",
  "VACUUM",
  "CHECKPOINT",
  "USE",
] as const;

const MAX_ROWS = 1000;

export type GuardResult =
  | { ok: true; sql: string }
  | { ok: false; error: string };

function stripStringsAndComments(sql: string): string {
  // Strip --line comments and /* block */ comments, then null-out string
  // literals so the keyword scan doesn't trip on the word DROP inside a quoted
  // value. Cheap and good enough for a guard layer; this is not a parser.
  let s = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  s = s.replace(/'(?:''|[^'])*'/g, "''");
  s = s.replace(/"(?:""|[^"])*"/g, '""');
  return s;
}

export function guardSql(rawSql: string): GuardResult {
  if (typeof rawSql !== "string" || !rawSql.trim()) {
    return { ok: false, error: "SQL is empty." };
  }
  const trimmed = rawSql.trim().replace(/;\s*$/, "");
  if (!trimmed) return { ok: false, error: "SQL is empty after trimming." };

  const scanBody = stripStringsAndComments(trimmed);

  if (scanBody.includes(";")) {
    return {
      ok: false,
      error: "Multiple statements are not allowed. Submit a single SELECT/WITH.",
    };
  }

  if (!/^\s*(SELECT|WITH)\b/i.test(scanBody)) {
    return {
      ok: false,
      error: "Only SELECT or WITH … SELECT statements are allowed.",
    };
  }

  const upper = scanBody.toUpperCase();
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`);
    if (re.test(upper)) {
      return { ok: false, error: `Forbidden keyword: ${kw}.` };
    }
  }

  // Inject a row cap if the planner forgot one. Has-LIMIT detection is
  // intentionally lax: any LIMIT keyword anywhere outside strings counts.
  const hasLimit = /\bLIMIT\b/i.test(scanBody);
  const sql = hasLimit ? trimmed : `${trimmed}\nLIMIT ${MAX_ROWS}`;
  return { ok: true, sql };
}

export const SQL_MAX_ROWS = MAX_ROWS;
