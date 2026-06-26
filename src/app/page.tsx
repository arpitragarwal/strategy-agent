import { StrategyConsole } from "@/components/StrategyConsole";
import { getModelId } from "@/lib/genai";

export default function Home() {
  // Resolved server-side (no per-run override here) so the picker can name the env default.
  return <StrategyConsole defaultModelId={getModelId()} />;
}
