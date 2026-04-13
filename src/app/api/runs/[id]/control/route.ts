import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: { action?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = body.action?.trim();
  const note = typeof body.note === "string" ? body.note.trim() : "";

  if (action !== "synthesize_now") {
    return NextResponse.json(
      { error: 'action must be "synthesize_now"' },
      { status: 400 },
    );
  }

  const run = await prisma.strategyRun.findUnique({ where: { id } });
  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (run.status !== "running" && run.status !== "awaiting_review") {
    return NextResponse.json(
      {
        error:
          "Controls apply while the pipeline is running or paused for review (status running or awaiting_review)",
      },
      { status: 409 },
    );
  }

  await prisma.strategyRun.update({
    where: { id },
    data: {
      controlAction: action,
      controlNote: note || null,
    },
  });

  return NextResponse.json({ ok: true, action });
}
