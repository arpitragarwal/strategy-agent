import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const items = await prisma.memoryArtifact.findMany({
    orderBy: { createdAt: "desc" },
    take: 25,
    select: {
      id: true,
      createdAt: true,
      title: true,
      runId: true,
    },
  });
  return NextResponse.json({ items });
}
