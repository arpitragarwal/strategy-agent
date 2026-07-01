/**
 * Models the user may pick for a run (Google AI / Gemini API).
 *
 * Importable from both client and server — it must NOT read process.env so it
 * stays safe in the browser bundle. The actual default lives in env
 * (GOOGLE_AI_MODEL) and is resolved server-side by getModelId(); the UI offers a
 * "Default" choice that sends no modelId so the server falls back to env.
 */

export type ModelOption = {
  /** Exact model id sent to the Google AI API. */
  id: string;
  /** Short human label for the picker. */
  label: string;
};

export const AVAILABLE_MODELS: ModelOption[] = [
  { id: "gemma-4-31b-it", label: "Gemma 4 32B" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  // GLM (Zhipu) via the z.ai endpoint — requires GLM_API_KEY.
  { id: "glm-5.2", label: "GLM 5.2" },
  { id: "glm-4.6", label: "GLM 4.6" },
  { id: "glm-4.5-flash", label: "GLM 4.5 (free)" },
  // Zenmux's OpenAI-compatible endpoint — requires ZENMUX_API_KEY. There is no
  // free GLM 5.2, so the free pick is GLM 4.7 Flash; full 5.2 is paid (cheaper than z.ai).
  { id: "glm-4.7-flash-free", label: "GLM 4.7 Flash (free)" },
  { id: "glm-5.2-zenmux", label: "GLM 5.2 (Zenmux, paid)" },
  // Claude Sonnet 5 via Zenmux (paid). Zenmux passes Anthropic's list rates
  // through unchanged ($2/MTok in, $10/MTok out); it's here for one-key access
  // alongside the GLM models, not for a discount.
  { id: "sonnet-5-zenmux", label: "Sonnet 5 (Zenmux, paid)" },
];

/** True when `v` is a model id the user is allowed to select. */
export function isAvailableModel(v: unknown): v is string {
  return typeof v === "string" && AVAILABLE_MODELS.some((m) => m.id === v);
}

/** Friendly label for a model id, falling back to the raw id when unknown. */
export function modelLabel(id: string): string {
  return AVAILABLE_MODELS.find((m) => m.id === id)?.label ?? id;
}
