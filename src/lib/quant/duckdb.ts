import { join } from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { QUANT_DATASETS } from "./catalog";

/**
 * In-memory DuckDB connection with one view per prototype CSV.
 *
 * Safety boundary: the connection is read-write (in-memory mode does not
 * support `access_mode=READ_ONLY` — there is no file to read from), so
 * `sqlGuard.ts` is the only barrier against DML/DDL. That is acceptable
 * for the synthetic prototype: views regenerate on cold start and there is
 * no shared mutable state. Replace this with a persistent .duckdb file +
 * read-only connection if/when this points at real data.
 *
 * Table-name convention: catalog id `crm/accounts` is exposed as the
 * SQL view `crm_accounts` so the agent never has to quote slashes.
 */

/** SQL identifier for a catalog dataset id (e.g. "crm/accounts" → "crm_accounts"). */
export function tableNameFor(datasetId: string): string {
  return datasetId.replace(/[^a-zA-Z0-9_]/g, "_");
}

type Holder = { conn: DuckDBConnection | null; ready: Promise<DuckDBConnection> | null };

const g = globalThis as unknown as { __quantDuck?: Holder };
if (!g.__quantDuck) g.__quantDuck = { conn: null, ready: null };

async function bootstrap(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  // DuckDB has no statement_timeout setting (Postgres-only). The data is tiny
  // (~1.25k accounts; <10k deal rows), and sqlGuard injects LIMIT 1000, so a
  // runaway query is implausible. If this points at a larger dataset later,
  // wrap runSelect in a Promise.race that calls conn.interrupt() on timeout.
  const dataDir = join(process.cwd(), "data", "dummy_data");
  for (const ds of QUANT_DATASETS) {
    const view = tableNameFor(ds.id);
    const path = join(dataDir, ds.relativePath).replace(/'/g, "''");
    await conn.run(
      `CREATE OR REPLACE VIEW ${view} AS SELECT * FROM read_csv_auto('${path}', header=true)`,
    );
  }
  return conn;
}

export async function getQuantDuck(): Promise<DuckDBConnection> {
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

/** Run a single SELECT/WITH statement and return rows as plain JS objects. */
export async function runSelect(
  sql: string,
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const conn = await getQuantDuck();
  const reader = await conn.runAndReadAll(sql);
  const columns = reader.columnNames();
  const rowsRaw = reader.getRowObjectsJson();
  // getRowObjectsJson returns BigInt/Date/decimal as serialisable forms already,
  // but the type is Json — cast to unknown for downstream typing.
  const rows = rowsRaw.map((r) => r as Record<string, unknown>);
  return { columns, rows };
}
