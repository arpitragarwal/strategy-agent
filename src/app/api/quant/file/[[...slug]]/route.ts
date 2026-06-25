import { NextResponse } from "next/server";
import { getDatasetMeta, getProvider } from "@/lib/quant";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug?: string[] }> },
) {
  const { slug } = await ctx.params;
  const id = slug?.join("/") ?? "";
  const meta = getDatasetMeta(id);
  if (!meta) {
    return NextResponse.json({ error: "Unknown dataset" }, { status: 404 });
  }

  const provider = await getProvider();
  if (!provider.getDatasetText) {
    // Non-file backends (e.g. a real warehouse) don't expose raw downloads.
    return NextResponse.json({ error: "Dataset download not available" }, { status: 404 });
  }

  let text: string;
  try {
    text = await provider.getDatasetText(id);
  } catch {
    return NextResponse.json({ error: "Failed to read file" }, { status: 500 });
  }

  // text/plain renders in-tab; text/csv is often handled as a download by browsers.
  return new NextResponse(text, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, max-age=60",
    },
  });
}
