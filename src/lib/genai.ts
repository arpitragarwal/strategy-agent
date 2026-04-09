import {
  GoogleGenerativeAI,
  GoogleGenerativeAIError,
  GoogleGenerativeAIFetchError,
  GoogleGenerativeAIResponseError,
  type GenerativeModel,
} from "@google/generative-ai";
import { parseModelJson } from "./json";

/** Model ID for generateContent (e.g. open-weight Gemma 4 on the Google AI API). */
export function getModelId(): string {
  return (
    process.env.GOOGLE_AI_MODEL?.trim() ||
    process.env.GEMINI_MODEL?.trim() ||
    // Smaller Gemma 4 variant — confirm in AI Studio; fallback: gemma-4-31b-it
    "gemma-4-26b-a4b-it"
  );
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

async function generateContentText(model: GenerativeModel, prompt: string): Promise<string> {
  const modelId = getModelId();
  try {
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

    let text: string;
    try {
      text = response.text();
    } catch (inner) {
      throw new Error(`${formatGenAiError(inner, modelId)} (model: ${modelId}).`);
    }

    if (!text?.trim()) throw new Error("Empty model response.");
    return text;
  } catch (e) {
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
}

export async function generateText(prompt: string): Promise<string> {
  return generateContentText(getTextModel(), prompt);
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
  const text = await generateContentText(getJsonModel(), prompt);

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
      "Output ONLY a single JSON object that satisfies:",
      options.repairHint,
      "Rules: no markdown, no code fences, no commentary before or after. First character must be \"{\".",
      "",
      "Broken output:",
      text.slice(0, 12000),
    ].join("\n");

  const repaired = await generateContentText(getTextModel(), repairBlock("Repair pass 1."));
  let fixed = repaired;
  if (!fixed) {
    throw new Error(`JSON repair got empty response. Raw (truncated): ${text.slice(0, 400)}`);
  }

  let second = attemptParse(fixed);
  if (second !== null) return second;

  const repaired2 = await generateContentText(
    getTextModel(),
    repairBlock(
      "Repair pass 2 — previous fix was still not parseable JSON. Be stricter: minified JSON only.",
    ),
  );
  fixed = repaired2;
  if (fixed) {
    second = attemptParse(fixed);
    if (second !== null) return second;
  }

  throw new Error(
    `Model did not return usable JSON after repair. Hint was: ${options.repairHint.slice(0, 120)}… Raw (truncated): ${text.slice(0, 400)}`,
  );
}
