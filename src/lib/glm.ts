import OpenAI from "openai";
import { recordTokenUsageFromGenerateResponse } from "./tokenUsage";

/**
 * GLM (Zhipu AI) backend over an OpenAI-compatible endpoint. Selected per-run
 * when the model id starts with "glm" (see getModelId() / the model picker);
 * otherwise the Google Gemini path is used.
 *
 * Two providers are supported, chosen by model id:
 *   - z.ai (paid, default)        — direct to Zhipu, no proxy.
 *   - Zenmux (free, rate-limited) — for the "glm-5.2-free" picker entry.
 * Both speak the same OpenAI chat-completions API; only the base URL, API key,
 * and the upstream model id differ (resolved by resolveProvider()).
 *
 * Env:
 *   GLM_API_KEY      z.ai / Zhipu API key (required for the paid glm-* models)
 *   GLM_BASE_URL     override the z.ai endpoint (default z.ai international)
 *   ZENMUX_API_KEY   Zenmux API key (required for the free glm-5.2-free model)
 *   ZENMUX_BASE_URL  override the Zenmux endpoint (default https://zenmux.ai/api/v1)
 */

const DEFAULT_BASE_URL = "https://api.z.ai/api/paas/v4";
const ZENMUX_BASE_URL = "https://zenmux.ai/api/v1";

type GlmProvider = "zai" | "zenmux";

/**
 * Picker model id → upstream provider + the model id that provider expects.
 * Anything not listed defaults to z.ai with the picker id passed through
 * unchanged (so the existing glm-5.2 / glm-4.6 / glm-4.5-flash entries keep
 * hitting z.ai exactly as before).
 */
const PROVIDER_BY_MODEL: Record<string, { provider: GlmProvider; model: string }> = {
  // Zenmux's free tier — GLM 4.7 Flash (full GLM 5.2 is not offered free anywhere).
  "glm-4.7-flash-free": { provider: "zenmux", model: "z-ai/glm-4.7-flash-free" },
  // Full GLM 5.2 via Zenmux (paid, but often cheaper than z.ai-direct).
  "glm-5.2-zenmux": { provider: "zenmux", model: "z-ai/glm-5.2" },
};

const clients: Partial<Record<GlmProvider, OpenAI>> = {};

/** True when the model id should be served by GLM rather than Gemini. */
export function isGlmModel(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith("glm");
}

function resolveProvider(modelId: string): {
  provider: GlmProvider;
  baseURL: string;
  apiKey: string | undefined;
  model: string;
} {
  const mapped = PROVIDER_BY_MODEL[modelId.trim().toLowerCase()];
  if (mapped?.provider === "zenmux") {
    return {
      provider: "zenmux",
      baseURL: process.env.ZENMUX_BASE_URL?.trim() || ZENMUX_BASE_URL,
      apiKey: process.env.ZENMUX_API_KEY?.trim(),
      model: mapped.model,
    };
  }
  return {
    provider: "zai",
    baseURL: process.env.GLM_BASE_URL?.trim() || DEFAULT_BASE_URL,
    apiKey: process.env.GLM_API_KEY?.trim(),
    model: modelId,
  };
}

/**
 * Resolve the OpenAI client and upstream model id for a GLM picker model id.
 * Callers must send the returned `model` (not the picker id) to the API.
 */
export function getGlmClient(modelId: string): { client: OpenAI; model: string } {
  const r = resolveProvider(modelId);
  if (!r.apiKey) {
    const envName = r.provider === "zenmux" ? "ZENMUX_API_KEY" : "GLM_API_KEY";
    const where = r.provider === "zenmux" ? "https://zenmux.ai" : "https://z.ai";
    throw new Error(
      `Missing ${envName}. Add it to .env to use ${modelId} (get one at ${where}).`,
    );
  }
  if (!clients[r.provider]) {
    clients[r.provider] = new OpenAI({
      apiKey: r.apiKey,
      baseURL: r.baseURL,
      // Providers retry transient 429/5xx; a few extra attempts smooth over blips
      // (and Zenmux's free tier is rate-limited, so retries help there too).
      maxRetries: 4,
    });
  }
  return { client: clients[r.provider]!, model: r.model };
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
  const { client, model } = getGlmClient(modelId);
  const resp = await client.chat.completions.create({
    model,
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
