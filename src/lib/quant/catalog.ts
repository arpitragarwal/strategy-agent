import { readFileSync } from "fs";
import { isAbsolute, join } from "path";
import type { DatasetMeta } from "./types";

/**
 * The dataset catalog is data, not code: it is loaded from a JSON file chosen
 * by the CATALOG_FILE env var (default: the synthetic prototype catalog). A
 * private deployment points CATALOG_FILE at its own catalog (real warehouse
 * tables) without forking this module. Keep the JSON shape stable — the agent
 * prompt, SQL guard, and providers all assume `{ datasets: DatasetMeta[] }`.
 */

const DEFAULT_CATALOG_FILE = "config/catalog.dummy.json";

function loadCatalog(): DatasetMeta[] {
  const configured = process.env.CATALOG_FILE?.trim() || DEFAULT_CATALOG_FILE;
  const path = isAbsolute(configured) ? configured : join(process.cwd(), configured);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(
      `Failed to read catalog file "${path}" (CATALOG_FILE=${process.env.CATALOG_FILE ?? "<unset>"}). ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  let parsed: { datasets?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Catalog file "${path}" is not valid JSON. ${e instanceof Error ? e.message : String(e)}`);
  }
  const datasets = parsed.datasets;
  if (!Array.isArray(datasets) || datasets.length === 0) {
    throw new Error(`Catalog file "${path}" must contain a non-empty "datasets" array.`);
  }
  for (const d of datasets as DatasetMeta[]) {
    if (!d.id || !d.table || !d.domain || !d.source?.kind) {
      throw new Error(
        `Catalog file "${path}" has a dataset missing required fields (id, table, domain, source.kind): ${JSON.stringify(d)}`,
      );
    }
  }
  return datasets as DatasetMeta[];
}

/** Registry of catalog datasets, loaded once at module init from CATALOG_FILE. */
export const QUANT_DATASETS: DatasetMeta[] = loadCatalog();

const byId = new Map(QUANT_DATASETS.map((d) => [d.id, d]));

export function getDatasetMeta(datasetId: string): DatasetMeta | undefined {
  return byId.get(datasetId);
}

/**
 * SQL identifier for a dataset. Prefers the catalog's explicit `table`; falls
 * back to sanitising the id (slash → underscore) for callers that pass an id
 * not in the catalog.
 */
export function tableNameFor(datasetId: string): string {
  return byId.get(datasetId)?.table ?? datasetId.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Catalog ids — used as the canonical list for prompts and audit display. */
export function listQuantDatasetIds(): string[] {
  return QUANT_DATASETS.map((d) => d.id);
}

/**
 * Lightweight catalog for prompts that surface a dataset list to the user
 * (synthesis, manager review). Enum literals and join recipes are not spelled
 * out here — the SQL agent discovers them via describe_table.
 */
export function buildDataCatalogMarkdown(): string {
  const lines = [
    "## Datasets (SELECT-only)",
    "",
    "Catalog id appears in agent audit logs; the table name is what SQL queries against.",
    "",
  ];
  // Group by domain in first-seen order so the markdown follows the catalog file.
  const byDomain = new Map<string, DatasetMeta[]>();
  for (const d of QUANT_DATASETS) {
    const list = byDomain.get(d.domain) ?? [];
    list.push(d);
    byDomain.set(d.domain, list);
  }
  for (const [domain, datasets] of byDomain) {
    lines.push(`### ${domain.toUpperCase()}`);
    for (const d of datasets) {
      lines.push(`- **${d.id}** — ${d.description}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
