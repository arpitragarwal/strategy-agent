import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const run = await prisma.strategyRun.findUnique({ where: { id } });
  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(run);
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: { clarificationAnswers?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.clarificationAnswers !== "string") {
    return NextResponse.json(
      { error: "clarificationAnswers must be a string" },
      { status: 400 },
    );
  }

  const run = await prisma.strategyRun.findUnique({ where: { id } });
  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (
    run.status !== "awaiting_review" ||
    run.reviewCheckpoint !== "after_discovery"
  ) {
    return NextResponse.json(
      {
        error:
          "Clarifications can only be saved while paused for context & clarification (after_discovery).",
      },
      { status: 409 },
    );
  }

  await prisma.strategyRun.update({
    where: { id },
    data: { clarificationAnswers: body.clarificationAnswers },
  });

  return NextResponse.json({ ok: true });
}
