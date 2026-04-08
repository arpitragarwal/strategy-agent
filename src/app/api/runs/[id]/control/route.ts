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

  if (action !== "synthesize_now" && action !== "redirect") {
    return NextResponse.json(
      { error: 'action must be "synthesize_now" or "redirect"' },
      { status: 400 },
    );
  }

  if (action === "redirect" && !note) {
    return NextResponse.json(
      { error: "redirect requires a non-empty note" },
      { status: 400 },
    );
  }

  const run = await prisma.strategyRun.findUnique({ where: { id } });
  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (run.status !== "running") {
    return NextResponse.json(
      { error: "Controls only apply while a run is in progress (status=running)" },
      { status: 409 },
    );
  }

  await prisma.strategyRun.update({
    where: { id },
    data: {
      controlAction: action,
      controlNote: action === "redirect" ? note : note || null,
    },
  });

  return NextResponse.json({ ok: true, action });
}
