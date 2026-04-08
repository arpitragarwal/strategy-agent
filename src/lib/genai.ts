import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";
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

function getClient() {
  const key = process.env.GOOGLE_AI_API_KEY;
  if (!key) throw new Error("Missing GOOGLE_AI_API_KEY");
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

export async function generateText(prompt: string): Promise<string> {
  const res = await getTextModel().generateContent(prompt);
  const text = res.response.text();
  if (!text) throw new Error("Empty model response");
  return text;
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
  const res = await getJsonModel().generateContent(prompt);
  const text = res.response.text();
  if (!text) throw new Error("Empty model response");

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

  const repaired = await getTextModel().generateContent(repairBlock("Repair pass 1."));
  let fixed = repaired.response.text();
  if (!fixed) {
    throw new Error(`JSON repair got empty response. Raw (truncated): ${text.slice(0, 400)}`);
  }

  let second = attemptParse(fixed);
  if (second !== null) return second;

  const repaired2 = await getTextModel().generateContent(
    repairBlock(
      "Repair pass 2 — previous fix was still not parseable JSON. Be stricter: minified JSON only.",
    ),
  );
  fixed = repaired2.response.text();
  if (fixed) {
    second = attemptParse(fixed);
    if (second !== null) return second;
  }

  throw new Error(
    `Model did not return usable JSON after repair. Hint was: ${options.repairHint.slice(0, 120)}… Raw (truncated): ${text.slice(0, 400)}`,
  );
}
