import { readFile } from "fs/promises";
import { isAbsolute, join } from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { getDatasetMeta, QUANT_DATASETS } from "../catalog";
import type { ColumnInfo, SelectResult, TableInfo, TableSummary } from "../types";
import type { QuantProvider } from "../provider";

/**
 * DuckDB-over-CSV provider for the synthetic prototype. One in-memory view per
 * catalog dataset (source.kind === "csv"), refreshed on cold start.
 *
 * Safety boundary: the connection is read-write (in-memory mode does not
 * support access_mode=READ_ONLY — there is no file to read from), so the SQL
 * guard (sqlGuard.ts) is the only barrier against DML/DDL. That is acceptable
 * for synthetic data with no shared mutable state. A real-warehouse provider
 * (e.g. ClickHouse) should query a least-privilege read-only service account.
 */

const ENUM_SAMPLE_LIMIT = 30;

const CSV_DATASETS = QUANT_DATASETS.filter((d) => d.source.kind === "csv");

function csvPath(relativeOrAbsolute: string): string {
  return isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : join(process.cwd(), relativeOrAbsolute);
}

type Holder = { conn: DuckDBConnection | null; ready: Promise<DuckDBConnection> | null };

const g = globalThis as unknown as { __quantDuck?: Holder };
if (!g.__quantDuck) g.__quantDuck = { conn: null, ready: null };

async function bootstrap(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  // DuckDB has no statement_timeout (Postgres-only). The data is tiny and the
  // guard injects LIMIT 1000, so a runaway query is implausible. For a larger
  // backend, wrap runSelect in a Promise.race that calls conn.interrupt().
  for (const ds of CSV_DATASETS) {
    const source = ds.source as { kind: "csv"; path: string };
    const path = csvPath(source.path).replace(/'/g, "''");
    await conn.run(
      `CREATE OR REPLACE VIEW ${ds.table} AS SELECT * FROM read_csv_auto('${path}', header=true)`,
    );
  }
  return conn;
}

async function getConn(): Promise<DuckDBConnection> {
  const holder = g.__quantDuck!;
  if (holder.conn) return holder.conn;
  if (!holder.ready) {
    holder.ready = bootstrap()
      .then((c) => {
        holder.conn = c;
        return c;
      })
      .catch((e) => {
        // Clear the cached rejection so the next caller retries bootstrap;
        // otherwise dev sessions get stuck on the first error forever.
        holder.ready = null;
        throw e;
      });
  }
  return holder.ready;
}

async function runSelect(sql: string): Promise<SelectResult> {
  const conn = await getConn();
  const reader = await conn.runAndReadAll(sql);
  const columns = reader.columnNames();
  const rowsRaw = reader.getRowObjectsJson();
  // getRowObjectsJson serialises BigInt/Date/decimal already; cast for typing.
  const rows = rowsRaw.map((r) => r as Record<string, unknown>);
  return { columns, rows };
}

async function listTables(): Promise<TableSummary[]> {
  return CSV_DATASETS.map((d) => ({
    datasetId: d.id,
    table: d.table,
    domain: d.domain,
    description: d.description,
  }));
}

/** Resolve either a catalog id ("crm/accounts") or a table name ("crm_accounts"). */
function resolveDataset(idOrTable: string): { datasetId: string; table: string } | null {
  const trimmed = idOrTable.trim();
  const meta = getDatasetMeta(trimmed);
  if (meta) return { datasetId: meta.id, table: meta.table };
  for (const d of CSV_DATASETS) {
    if (d.table === trimmed) return { datasetId: d.id, table: d.table };
  }
  return null;
}

const tableInfoCache = new Map<string, TableInfo>();

async function describeTable(idOrTable: string): Promise<TableInfo> {
  const resolved = resolveDataset(idOrTable);
  if (!resolved) {
    throw new Error(`Unknown table "${idOrTable}". Call list_tables to see valid names.`);
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
  const { rows: countRows } = await runSelect(`SELECT COUNT(*) AS n FROM ${resolved.table}`);
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
        exampleValues = distinctRows.map((d) => String(d.v)).sort((a, b) => a.localeCompare(b));
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

async function getDatasetText(datasetId: string): Promise<string> {
  const meta = getDatasetMeta(datasetId);
  if (!meta || meta.source.kind !== "csv") {
    throw new Error(`Dataset "${datasetId}" is not a CSV-backed dataset.`);
  }
  const source = meta.source as { kind: "csv"; path: string };
  return readFile(csvPath(source.path), "utf8");
}

export function createProvider(): QuantProvider {
  return {
    id: "duckdb-csv",
    dialect: "duckdb",
    runSelect,
    listTables,
    describeTable,
    getDatasetText,
  };
}
