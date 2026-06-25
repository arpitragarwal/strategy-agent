import { QUANT_DATASETS, getDatasetMeta } from "./catalog";
import { runSelect, tableNameFor } from "./duckdb";

export type ColumnInfo = {
  name: string;
  type: string;
  /** Up to ~30 distinct values for low-cardinality string columns; null otherwise. */
  exampleValues: string[] | null;
};

export type TableInfo = {
  datasetId: string;
  table: string;
  domain: string;
  description: string;
  rowCount: number;
  columns: ColumnInfo[];
};

const tableInfoCache = new Map<string, TableInfo>();

const ENUM_SAMPLE_LIMIT = 30;

/** Returns a one-liner table list for the agent's first turn. */
export async function listTables(): Promise<
  Array<{ datasetId: string; table: string; domain: string; description: string }>
> {
  return QUANT_DATASETS.map((d) => ({
    datasetId: d.id,
    table: tableNameFor(d.id),
    domain: d.domain,
    description: d.description,
  }));
}

/** Resolve either the catalog id ("crm/accounts") or the table name ("crm_accounts"). */
function resolveDataset(idOrTable: string): { datasetId: string; table: string } | null {
  const trimmed = idOrTable.trim();
  const meta = getDatasetMeta(trimmed);
  if (meta) return { datasetId: meta.id, table: tableNameFor(meta.id) };
  // Try matching by sanitised table name (the agent will mostly use these).
  for (const d of QUANT_DATASETS) {
    if (tableNameFor(d.id) === trimmed) return { datasetId: d.id, table: tableNameFor(d.id) };
  }
  return null;
}

/**
 * Returns column names, DuckDB types, and sample values for low-cardinality
 * string columns. Cached after first call (schema does not change at runtime).
 */
export async function describeTable(idOrTable: string): Promise<TableInfo> {
  const resolved = resolveDataset(idOrTable);
  if (!resolved) {
    throw new Error(
      `Unknown table "${idOrTable}". Call list_tables to see valid names.`,
    );
  }
  const cached = tableInfoCache.get(resolved.table);
  if (cached) return cached;

  const meta = getDatasetMeta(resolved.datasetId)!;
  const { rows: colRows } = await runSelect(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_name = '${resolved.table}'
     ORDER BY ordinal_position`,
  );
  const { rows: countRows } = await runSelect(
    `SELECT COUNT(*) AS n FROM ${resolved.table}`,
  );
  const rowCount = Number((countRows[0]?.n as number | string | bigint) ?? 0);

  const columns: ColumnInfo[] = [];
  for (const r of colRows) {
    const name = String(r.column_name);
    const type = String(r.data_type);
    const isString = /VARCHAR|TEXT|CHAR/i.test(type);
    let exampleValues: string[] | null = null;
    if (isString) {
      // Only emit examples for low-cardinality columns (probable enums).
      const { rows: distinctRows } = await runSelect(
        `SELECT DISTINCT "${name}" AS v
         FROM ${resolved.table}
         WHERE "${name}" IS NOT NULL AND "${name}" <> ''
         LIMIT ${ENUM_SAMPLE_LIMIT + 1}`,
      );
      if (distinctRows.length <= ENUM_SAMPLE_LIMIT) {
        exampleValues = distinctRows
          .map((d) => String(d.v))
          .sort((a, b) => a.localeCompare(b));
      }
    }
    columns.push({ name, type, exampleValues });
  }

  const info: TableInfo = {
    datasetId: resolved.datasetId,
    table: resolved.table,
    domain: meta.domain,
    description: meta.description,
    rowCount,
    columns,
  };
  tableInfoCache.set(resolved.table, info);
  return info;
}

/** Lightweight markdown rendering of all tables — used as system context for the agent. */
export async function tableCatalogMarkdown(): Promise<string> {
  const lines: string[] = ["## Available tables", ""];
  const tables = await listTables();
  for (const t of tables) {
    lines.push(`- **${t.table}** (${t.domain}) — ${t.description}`);
  }
  lines.push(
    "",
    "Use `describe_table(table)` to fetch columns, types, and enum values before writing SQL.",
    "All tables are SELECT-only views. Statements that aren't a single SELECT/WITH are rejected.",
  );
  return lines.join("\n");
}
