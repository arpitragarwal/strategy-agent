import { NextResponse } from "next/server";
import { QUANT_DATASETS, buildDataCatalogMarkdown } from "@/lib/quant";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    markdown: buildDataCatalogMarkdown(),
    datasets: QUANT_DATASETS,
  });
}
