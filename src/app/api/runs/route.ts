import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { prompt?: string; mode?: string };
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

  const run = await prisma.strategyRun.create({
    data: {
      prompt,
      companyContext: "",
      status: "pending",
      runMode: mode,
      progressLog: [],
    },
  });

  return NextResponse.json({ id: run.id });
}
