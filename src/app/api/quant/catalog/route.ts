import { NextResponse } from "next/server";
import { QUANT_DATASETS, buildDataCatalogMarkdown } from "@/lib/quant";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const contextDocsCount = await prisma.contextDocument.count().catch(() => null);
  return NextResponse.json({
    markdown: buildDataCatalogMarkdown(),
    datasets: QUANT_DATASETS,
    contextDocsCount,
  });
}
