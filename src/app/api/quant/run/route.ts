import { NextResponse } from "next/server";
import type { QuantPlan } from "@/lib/quant";
import { executeQuantPlan } from "@/lib/quant";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { plan?: QuantPlan };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const plan = body.plan;
  if (!plan?.datasetId || !Array.isArray(plan.steps)) {
    return NextResponse.json(
      { error: "plan with datasetId and steps[] is required" },
      { status: 400 },
    );
  }

  const result = executeQuantPlan(plan);
  return NextResponse.json(result);
}
