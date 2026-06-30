import OpenAI from "openai";
import { recordTokenUsageFromGenerateResponse } from "./tokenUsage";

/**
 * GLM (Zhipu AI) backend via the z.ai OpenAI-compatible endpoint. This is a
 * direct client to z.ai — no proxy, no extra cost or rate limits beyond
 * Zhipu's own. Selected per-run when the model id starts with "glm" (see
 * getModelId() / the model picker); otherwise the Google Gemini path is used.
 *
 * Env:
 *   GLM_API_KEY    z.ai / Zhipu API key (required to use a glm-* model)
 *   GLM_BASE_URL   override the endpoint (default z.ai international)
 */

const DEFAULT_BASE_URL = "https://api.z.ai/api/paas/v4";

let client: OpenAI | null = null;

/** True when the model id should be served by GLM rather than Gemini. */
export function isGlmModel(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith("glm");
}

export function getGlmClient(): OpenAI {
  const apiKey = process.env.GLM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Missing GLM_API_KEY. Add it to .env to use a GLM model (get one at https://z.ai).",
    );
  }
  if (!client) {
    client = new OpenAI({
      apiKey,
      baseURL: process.env.GLM_BASE_URL?.trim() || DEFAULT_BASE_URL,
      // z.ai retries transient 429/5xx; a few extra attempts smooth over blips.
      maxRetries: 4,
    });
  }
  return client;
}

/** Feed OpenAI-style usage into the shared per-run token accumulator (mapped to the Gemini field names). */
export function recordGlmUsage(usage: OpenAI.CompletionUsage | null | undefined): void {
  if (!usage) return;
  recordTokenUsageFromGenerateResponse({
    usageMetadata: {
      promptTokenCount: usage.prompt_tokens,
      candidatesTokenCount: usage.completion_tokens,
      totalTokenCount: usage.total_tokens,
    },
  });
}

/** Single text (or JSON-mode) completion against GLM. */
export async function glmGenerateText(
  modelId: string,
  prompt: string,
  opts?: { json?: boolean },
): Promise<string> {
  const resp = await getGlmClient().chat.completions.create({
    model: modelId,
    temperature: opts?.json ? 0.15 : 0.35,
    max_tokens: 8192,
    ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
    messages: [{ role: "user", content: prompt }],
  });
  recordGlmUsage(resp.usage);
  const text = resp.choices[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("Empty model response (GLM).");
  return text;
}
