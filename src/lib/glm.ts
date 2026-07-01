import OpenAI from "openai";
import { recordTokenUsageFromGenerateResponse } from "./tokenUsage";

/**
 * OpenAI-compatible model backend. Selected per-run for any model id handled
 * here — GLM ids (starting with "glm") plus anything listed in
 * PROVIDER_BY_MODEL, e.g. Claude Sonnet 5 via Zenmux (see isOpenAiCompatModel()
 * / getModelId() / the model picker); otherwise the Google Gemini path is used.
 *
 * Providers are chosen by model id:
 *   - z.ai (paid, default)        — direct to Zhipu, no proxy.
 *   - Zenmux (OpenAI-compatible)  — GLM Flash (free), GLM 5.2 (paid), and
 *                                   Anthropic Claude Sonnet 5 (paid).
 * All speak the same OpenAI chat-completions API; only the base URL, API key,
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
 *
 * `noTemperature` marks upstreams that 400 on a `temperature` param (Claude
 * Sonnet 5 via Zenmux rejects it as deprecated); callers must omit temperature
 * for those. GLM models accept it, so it's left unset for them.
 */
type ModelMapping = { provider: GlmProvider; model: string; noTemperature?: true };

const PROVIDER_BY_MODEL: Record<string, ModelMapping> = {
  // Zenmux's free tier — GLM 4.7 Flash (full GLM 5.2 is not offered free anywhere).
  "glm-4.7-flash-free": { provider: "zenmux", model: "z-ai/glm-4.7-flash-free" },
  // Full GLM 5.2 via Zenmux (paid, but often cheaper than z.ai-direct).
  "glm-5.2-zenmux": { provider: "zenmux", model: "z-ai/glm-5.2" },
  // Anthropic Claude Sonnet 5 via Zenmux (paid; passthrough of Anthropic rates).
  // Rejects the `temperature` param, so it's suppressed via noTemperature.
  "sonnet-5-zenmux": { provider: "zenmux", model: "anthropic/claude-sonnet-5", noTemperature: true },
};

const clients: Partial<Record<GlmProvider, OpenAI>> = {};

/** True when the model id is a GLM model (id starts with "glm"). */
export function isGlmModel(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith("glm");
}

/**
 * True when the model id should be served by the OpenAI-compatible client here
 * (GLM ids, or any explicitly mapped id such as sonnet-5-zenmux) rather than by
 * the Google Gemini path. This is the routing pivot used by both the plain
 * completion path (genai.ts) and the agentic tool-calling loop (quant/agent.ts).
 */
export function isOpenAiCompatModel(modelId: string): boolean {
  return isGlmModel(modelId) || modelId.trim().toLowerCase() in PROVIDER_BY_MODEL;
}

function resolveProvider(modelId: string): {
  provider: GlmProvider;
  baseURL: string;
  apiKey: string | undefined;
  model: string;
  supportsTemperature: boolean;
} {
  const mapped = PROVIDER_BY_MODEL[modelId.trim().toLowerCase()];
  if (mapped?.provider === "zenmux") {
    return {
      provider: "zenmux",
      baseURL: process.env.ZENMUX_BASE_URL?.trim() || ZENMUX_BASE_URL,
      apiKey: process.env.ZENMUX_API_KEY?.trim(),
      model: mapped.model,
      supportsTemperature: !mapped.noTemperature,
    };
  }
  return {
    provider: "zai",
    baseURL: process.env.GLM_BASE_URL?.trim() || DEFAULT_BASE_URL,
    apiKey: process.env.GLM_API_KEY?.trim(),
    model: modelId,
    supportsTemperature: true,
  };
}

/**
 * Resolve the OpenAI client and upstream model id for a GLM picker model id.
 * Callers must send the returned `model` (not the picker id) to the API.
 */
export function getGlmClient(
  modelId: string,
): { client: OpenAI; model: string; supportsTemperature: boolean } {
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
  return { client: clients[r.provider]!, model: r.model, supportsTemperature: r.supportsTemperature };
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

/** Single text (or JSON-mode) completion against an OpenAI-compatible model (GLM or Zenmux Sonnet). */
export async function glmGenerateText(
  modelId: string,
  prompt: string,
  opts?: { json?: boolean },
): Promise<string> {
  const { client, model, supportsTemperature } = getGlmClient(modelId);
  const resp = await client.chat.completions.create({
    model,
    // Sonnet 5 via Zenmux 400s on `temperature`; only send it where accepted.
    ...(supportsTemperature ? { temperature: opts?.json ? 0.15 : 0.35 } : {}),
    max_tokens: 8192,
    ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
    messages: [{ role: "user", content: prompt }],
  });
  recordGlmUsage(resp.usage);
  const text = resp.choices[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("Empty model response (GLM).");
  return text;
}
