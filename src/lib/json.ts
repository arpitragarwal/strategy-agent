/** Pull first top-level `{ ... }` from text, respecting strings. */
export function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function tryParse<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/** Strict: fenced block or full string parse. */
export function extractJsonObject<T = unknown>(raw: string): T {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(trimmed);
  const body = fence ? fence[1].trim() : trimmed;
  const result = tryParse<T>(body);
  if (result === null) throw new SyntaxError("JSON.parse failed");
  return result;
}

/**
 * Lenient: fence, whole trim, or first balanced `{...}`.
 * Use after LLM calls that may prepend chatter despite JSON mime type.
 */
export function parseModelJson<T = unknown>(raw: string): T {
  const trimmed = raw.trim();
  if (!trimmed) throw new SyntaxError("empty model output");

  const multilineFence =
    /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (multilineFence) {
    const inner = tryParse<T>(multilineFence[1].trim());
    if (inner !== null) return inner;
  }

  const whole = tryParse<T>(trimmed);
  if (whole !== null) return whole;

  const slice = extractFirstJsonObject(trimmed);
  if (slice) {
    const nested = tryParse<T>(slice);
    if (nested !== null) return nested;
  }

  throw new SyntaxError(
    `Could not parse JSON (preview): ${trimmed.slice(0, 200)}${trimmed.length > 200 ? "…" : ""}`,
  );
}
