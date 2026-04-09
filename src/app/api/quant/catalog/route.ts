import { NextResponse } from "next/server";
import {
  QUANT_DATASETS,
  QUANT_JOIN_RELATIONSHIPS,
  buildDataCatalogMarkdown,
  peekColumns,
} from "@/lib/quant";

export const dynamic = "force-dynamic";

export async function GET() {
  const datasets = QUANT_DATASETS.map((d) => {
    let columns: string[] = [];
    try {
      columns = peekColumns(d.id);
    } catch {
      columns = [];
    }
    return { ...d, columns };
  });
  return NextResponse.json({
    markdown: buildDataCatalogMarkdown(),
    joinRelationships: [...QUANT_JOIN_RELATIONSHIPS],
    datasets,
  });
}
