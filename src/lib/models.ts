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
  { id: "gemma-4-31b-it", label: "Gemma 4 · 31B (dense)" },
  { id: "gemma-4-26b-a4b-it", label: "Gemma 4 · 26B (MoE)" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
];

/** True when `v` is a model id the user is allowed to select. */
export function isAvailableModel(v: unknown): v is string {
  return typeof v === "string" && AVAILABLE_MODELS.some((m) => m.id === v);
}

/** Friendly label for a model id, falling back to the raw id when unknown. */
export function modelLabel(id: string): string {
  return AVAILABLE_MODELS.find((m) => m.id === id)?.label ?? id;
}
