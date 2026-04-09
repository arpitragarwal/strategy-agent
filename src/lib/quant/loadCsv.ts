import { readFileSync } from "fs";
import Papa from "papaparse";
import { resolveDatasetPath } from "./catalog";

export function loadCsvAsObjects(datasetId: string): Record<string, unknown>[] {
  const path = resolveDatasetPath(datasetId);
  const text = readFileSync(path, "utf8").trim();
  if (!text) {
    return [];
  }
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  });
  if (parsed.errors.length) {
    throw new Error(`CSV parse error: ${parsed.errors[0]?.message ?? "unknown"}`);
  }
  return parsed.data.filter((row) => Object.values(row).some((v) => v !== "" && v != null));
}

export function peekColumns(datasetId: string): string[] {
  const rows = loadCsvAsObjects(datasetId);
  if (!rows.length) return [];
  return Object.keys(rows[0]!);
}
