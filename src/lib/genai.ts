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
      temperature: 0.25,
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

export async function generateJson<T>(prompt: string): Promise<T> {
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

  const repaired = await getTextModel().generateContent(
    [
      "You were asked for a JSON object with top-level key \"roots\" (MECE issue tree).",
      "The following model output is INVALID (not parseable JSON). Reconstruct the intended tree.",
      "Reply with ONLY valid JSON. No markdown fences, no commentary. First character \"{\".",
      "",
      "Invalid output:",
      text.slice(0, 12000),
    ].join("\n"),
  );
  const fixed = repaired.response.text();
  if (!fixed) {
    throw new Error(`JSON repair got empty response. Raw (truncated): ${text.slice(0, 400)}`);
  }

  const second = attemptParse(fixed);
  if (second !== null) return second;

  throw new Error(
    `Model did not return usable JSON after repair. Raw (truncated): ${text.slice(0, 400)}`,
  );
}
