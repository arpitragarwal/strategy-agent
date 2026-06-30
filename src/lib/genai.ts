import { AsyncLocalStorage } from "node:async_hooks";
import {
  GoogleGenerativeAI,
  GoogleGenerativeAIAbortError,
  GoogleGenerativeAIError,
  GoogleGenerativeAIFetchError,
  GoogleGenerativeAIResponseError,
  type GenerativeModel,
} from "@google/generative-ai";
import { parseModelJson } from "./json";
import { glmGenerateText, isGlmModel } from "./glm";
import { recordTokenUsageFromGenerateResponse } from "./tokenUsage";

/** Per-run model override (set from the user's pick); falls back to env when unset. */
const modelOverrideStorage = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `modelId` forcing every getModelId() lookup inside it. Empty /
 * null falls through to the env default, so callers can pass the run's stored
 * choice verbatim.
 */
export function withModelId<T>(
  modelId: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const trimmed = modelId?.trim();
  if (!trimmed) return fn();
  return modelOverrideStorage.run(trimmed, fn);
}

/** Model ID for generateContent: per-run override → GOOGLE_AI_MODEL → GEMINI_MODEL → built-in default. */
export function getModelId(): string {
  const override = modelOverrideStorage.getStore();
  if (override) return override;
  return (
    process.env.GOOGLE_AI_MODEL?.trim() ||
    process.env.GEMINI_MODEL?.trim() ||
    // Gemma 4 dense 31B — override with GOOGLE_AI_MODEL if your key uses a different id.
    "gemma-4-31b-it"
  );
}

/** Max attempts per `generateContent` call (first try + retries). Override with GOOGLE_AI_MAX_RETRIES. */
function getMaxGenAiAttempts(): number {
  const raw = process.env.GOOGLE_AI_MAX_RETRIES?.trim();
  if (!raw) return 5;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 5;
  return Math.min(12, Math.max(1, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter (ms). */
function retryDelayMs(attemptIndex: number): number {
  const base = 900;
  const cap = 45_000;
  const exp = Math.min(cap, base * 2 ** (attemptIndex - 1));
  const jitter = Math.random() * 500;
  return Math.round(exp + jitter);
}

/** True when failure is likely transient (network / TLS / DNS) — safe to retry with backoff. */
function messageLooksLikeTransientNetwork(e: unknown): boolean {
  const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("load failed") ||
    msg.includes("networkerror") ||
    msg.includes("network error") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("enotfound") ||
    msg.includes("eai_again") ||
    msg.includes("ecert") ||
    msg.includes("certificate") ||
    (msg.includes("dns") && msg.includes("timeout")) ||
    (msg.includes("generativelanguage.googleapis.com") && msg.includes("fetch"))
  );
}

function isRetryableGenAiError(e: unknown): boolean {
  if (e instanceof GoogleGenerativeAIAbortError) return false;
  if (e instanceof GoogleGenerativeAIFetchError) {
    const s = e.status;
    if (s === 429 || s === 408) return true;
    if (typeof s === "number" && s >= 500 && s < 600) return true;
    // No HTTP status (or non-retryable 4xx) but the transport failed — still retry.
    if (messageLooksLikeTransientNetwork(e)) return true;
    return false;
  }
  if (e instanceof GoogleGenerativeAIResponseError) return false;
  // Base SDK error often wraps `fetch failed` without a useful status — retry those only.
  if (e instanceof GoogleGenerativeAIError) {
    return messageLooksLikeTransientNetwork(e);
  }
  if (e instanceof TypeError) {
    return /\b(failed to fetch|network|load failed|fetch)\b/i.test(e.message);
  }
  if (e instanceof Error) {
    const m = e.message.toLowerCase();
    return (
      messageLooksLikeTransientNetwork(e) ||
      m.includes("econnreset") ||
      m.includes("etimedout") ||
      m.includes("econnrefused") ||
      m.includes("socket hang up") ||
      (m.includes("dns") && m.includes("timeout"))
    );
  }
  return false;
}

function wrapGenAiFailure(e: unknown, modelId: string): never {
  if (e instanceof GoogleGenerativeAIFetchError || e instanceof GoogleGenerativeAIResponseError) {
    throw new Error(
      `${formatGenAiError(e, modelId)} — Confirm GOOGLE_AI_API_KEY and GOOGLE_AI_MODEL in .env (Google AI Studio).`,
    );
  }
  if (e instanceof GoogleGenerativeAIError) {
    throw new Error(`${formatGenAiError(e, modelId)} — Model "${modelId}".`);
  }
  throw e;
}

function formatGenAiError(err: unknown, modelId: string): string {
  if (err instanceof GoogleGenerativeAIFetchError) {
    let hint = "";
    if (err.status === 400) hint = " Invalid request — check model id and payload.";
    else if (err.status === 401 || err.status === 403) {
      hint = " API key missing, invalid, or not allowed to use this model.";
    } else if (err.status === 404) {
      hint = ` Model "${modelId}" not found for this key — set GOOGLE_AI_MODEL to an id listed in Google AI Studio for your project.`;
    } else if (err.status === 429) hint = " Rate limit or quota exceeded — retry later.";
    const http = err.status != null ? ` HTTP ${err.status}` : "";
    return `${err.message}${http}.${hint}${err.statusText ? ` (${err.statusText})` : ""}`.trim();
  }
  if (err instanceof GoogleGenerativeAIResponseError || err instanceof GoogleGenerativeAIError) {
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function getClient() {
  const key = process.env.GOOGLE_AI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Missing GOOGLE_AI_API_KEY. Add it to .env (see https://aistudio.google.com/apikey).",
    );
  }
  return new GoogleGenerativeAI(key);
}

export function getTextModel(): GenerativeModel {
  return getClient().getGenerativeModel({
    model: getModelId(),
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 8192,
    },
  });
}

export function getJsonModel(): GenerativeModel {
  return getClient().getGenerativeModel({
    model: getModelId(),
    generationConfig: {
      temperature: 0.15,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    },
  });
}

async function generateContentOnce(model: GenerativeModel, prompt: string): Promise<string> {
  const modelId = getModelId();
  const result = await model.generateContent(prompt);
  const { response } = result;

  const pf = response.promptFeedback;
  if (pf?.blockReason && pf.blockReason !== "BLOCKED_REASON_UNSPECIFIED") {
    throw new Error(
      `Prompt blocked by the API (${pf.blockReason}). Try rephrasing or shortening the goal.`,
    );
  }

  if (!response.candidates?.length) {
    throw new Error(
      "The model returned no output (no candidates). Often caused by filtering, or JSON mode not supported for this model.",
    );
  }

  recordTokenUsageFromGenerateResponse(response as { usageMetadata?: unknown });

  let text: string;
  try {
    text = response.text();
  } catch (inner) {
    throw new Error(`${formatGenAiError(inner, modelId)} (model: ${modelId}).`);
  }

  if (!text?.trim()) throw new Error("Empty model response.");
  return text;
}

async function generateContentText(model: GenerativeModel, prompt: string): Promise<string> {
  const modelId = getModelId();
  const maxAttempts = getMaxGenAiAttempts();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await generateContentOnce(model, prompt);
    } catch (e) {
      const canRetry = attempt < maxAttempts && isRetryableGenAiError(e);
      if (canRetry) {
        const delay = retryDelayMs(attempt);
        if (process.env.NODE_ENV !== "production") {
          const reason = e instanceof GoogleGenerativeAIFetchError ? `HTTP ${e.status}` : (e as Error).message;
          console.warn(
            `[genai] Attempt ${attempt}/${maxAttempts} failed (${reason.slice(0, 120)}), retrying in ${delay}ms…`,
          );
        }
        await sleep(delay);
        continue;
      }
      wrapGenAiFailure(e, modelId);
    }
  }

  throw new Error("Model request exceeded retry limit (internal error).");
}

/** One completion routed to the active provider (GLM when the model id is glm-*, else Gemini). */
async function generateRaw(prompt: string, json: boolean): Promise<string> {
  const modelId = getModelId();
  if (isGlmModel(modelId)) {
    return glmGenerateText(modelId, prompt, { json });
  }
  return generateContentText(json ? getJsonModel() : getTextModel(), prompt);
}

export async function generateText(prompt: string): Promise<string> {
  return generateRaw(prompt, false);
}

export type GenerateJsonOptions = {
  /**
   * Required context for the repair pass when the model ignores JSON mode (common on Gemma).
   * Describe the exact JSON shape expected — repair was wrongly hard-coded to MECE roots only.
   */
  repairHint: string;
};

export async function generateJson<T>(
  prompt: string,
  options: GenerateJsonOptions,
): Promise<T> {
  const text = await generateRaw(prompt, true);

  const attemptParse = (raw: string): T | null => {
    try {
      return parseModelJson<T>(raw);
    } catch {
      return null;
    }
  };

  const first = attemptParse(text);
  if (first !== null) return first;

  const repairBlock = (label: string) =>
    [
      label,
      "The following text is NOT valid JSON (or has extra prose).",
      "If it looks like comma-separated themes, bullet topics, or short phrases, you MUST turn them into a full nested object per the hint (add ids, titles, questions, children arrays).",
      "If it looks like markdown (lines starting with *, #, or sections such as \"User Goal\" / \"Manager Feedback\"), that is WRONG — discard it and output ONLY the JSON object per the hint.",
      "Output ONLY a single JSON object that satisfies:",
      options.repairHint,
      "Rules: no markdown, no code fences, no commentary before or after. First character must be \"{\".",
      "",
      "Broken output:",
      text.slice(0, 12000),
    ].join("\n");

  const repaired = await generateRaw(repairBlock("Repair pass 1."), false);
  let fixed = repaired;
  if (!fixed) {
    throw new Error(`JSON repair got empty response. Raw (truncated): ${text.slice(0, 400)}`);
  }

  let second = attemptParse(fixed);
  if (second !== null) return second;

  const repaired2 = await generateRaw(
    repairBlock(
      "Repair pass 2 — previous fix was still not parseable JSON. Be stricter: minified JSON only.",
    ),
    false,
  );
  fixed = repaired2;
  if (fixed) {
    second = attemptParse(fixed);
    if (second !== null) return second;
  }

  // Pass 3: JSON MIME model — helps when the first call returned prose (e.g. comma-separated themes, no "{").
  const repaired3 = await generateRaw(
    [
      "Repair pass 3 (strict JSON output mode).",
      "The following text is NOT valid JSON. It may be a comma-separated list of themes, short phrases, partial outline, or markdown notes — you MUST convert it into ONE valid JSON object.",
      "Do NOT echo headings like User Goal or Manager Feedback; emit only the JSON tree.",
      "Output ONLY that object. Satisfy:",
      options.repairHint,
      "Rules: first character \"{\", last \"}\". No markdown fences, no commentary.",
      "",
      "Broken / prose output to convert:",
      text.slice(0, 12000),
    ].join("\n"),
    true,
  );
  if (repaired3?.trim()) {
    const third = attemptParse(repaired3);
    if (third !== null) return third;
  }

  throw new Error(
    `Model did not return usable JSON after repair. Hint was: ${options.repairHint.slice(0, 120)}… Raw (truncated): ${text.slice(0, 400)}`,
  );
}
