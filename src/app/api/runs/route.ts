import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isAvailableModel } from "@/lib/models";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: {
    prompt?: string;
    mode?: string;
    usePriorRunMemory?: unknown;
    useDocumentContext?: unknown;
    modelId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const prompt = body.prompt?.trim();
  if (!prompt) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  const mode =
    body.mode === "end_to_end" || body.mode === "step_by_step" ? body.mode : "step_by_step";
  const usePriorRunMemory =
    typeof body.usePriorRunMemory === "boolean" ? body.usePriorRunMemory : true;
  const useDocumentContext =
    typeof body.useDocumentContext === "boolean" ? body.useDocumentContext : true;
  // Only persist an explicit, allowlisted pick; otherwise leave null so the run
  // uses the env default (GOOGLE_AI_MODEL) at execution time.
  const modelId = isAvailableModel(body.modelId) ? body.modelId : null;

  const run = await prisma.strategyRun.create({
    data: {
      prompt,
      companyContext: "",
      status: "pending",
      runMode: mode,
      usePriorRunMemory,
      useDocumentContext,
      modelId,
      progressLog: [],
    },
  });

  return NextResponse.json({ id: run.id });
}
