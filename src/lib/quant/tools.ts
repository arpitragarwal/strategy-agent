import { SchemaType, type FunctionDeclaration } from "@google/generative-ai";

/**
 * Tool surface presented to the quant agent. The agent picks tools to
 * progressively explore the schema, draft SQL, sample results, then commit
 * to a final query + narrative via `finalize`.
 *
 * Tool dispatch lives in `agent.ts`.
 */

export const TOOL_NAMES = {
  listTables: "list_tables",
  describeTable: "describe_table",
  sampleRows: "sample_rows",
  runSql: "run_sql",
  finalize: "finalize",
} as const;

export const QUANT_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: TOOL_NAMES.listTables,
    description:
      "List all available SQL tables with one-line descriptions. Call first if you don't already know which table is relevant.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
    },
  },
  {
    name: TOOL_NAMES.describeTable,
    description:
      "Return columns, types, and sample values for low-cardinality string columns of one table. Use this before writing SQL against an unfamiliar table.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        table: {
          type: SchemaType.STRING,
          description:
            "Table name (e.g. crm_deal_data) or catalog id (e.g. crm/deal_data).",
        },
      },
      required: ["table"],
    },
  },
  {
    name: TOOL_NAMES.sampleRows,
    description:
      "Run a single read-only SELECT/WITH statement and return up to 20 rows for inspection. Use this to validate column names, joins, or filter shapes before committing to run_sql.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        sql: {
          type: SchemaType.STRING,
          description: "A single SELECT or WITH … SELECT statement.",
        },
      },
      required: ["sql"],
    },
  },
  {
    name: TOOL_NAMES.runSql,
    description:
      "Run the SQL whose result you intend to report. Returns up to 1000 rows. The last successful run_sql call becomes the result table on the final QuantResult.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        sql: {
          type: SchemaType.STRING,
          description: "A single SELECT or WITH … SELECT statement.",
        },
        purpose: {
          type: SchemaType.STRING,
          description:
            "One sentence on what this query tests (used in the audit log).",
        },
      },
      required: ["sql", "purpose"],
    },
  },
  {
    name: TOOL_NAMES.finalize,
    description:
      "Emit the final narrative for the hypothesis and (optionally) a chart spec built from the last run_sql result. Always call this exactly once when done. After finalize is called, no further tool calls are accepted.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        narrative: {
          type: SchemaType.STRING,
          description:
            "1–3 sentences with concrete numbers from the result that bear on the hypothesis.",
        },
        chart: {
          type: SchemaType.OBJECT,
          description:
            "Optional chart config. x, y, and series must be column names that exist on the last run_sql result.",
          properties: {
            type: {
              type: SchemaType.STRING,
              description:
                "'bar' (compare categories), 'line' (trend over a time/ordered x), 'area' (cumulative/stacked trend), or 'point' (scatter, two numeric columns).",
            },
            x: { type: SchemaType.STRING, description: "Column for the x-axis (category or time)." },
            y: {
              type: SchemaType.STRING,
              description: "Column for the value axis (must be numeric).",
            },
            series: {
              type: SchemaType.STRING,
              description:
                "Optional column to split into colored series (e.g. segment, region). Omit for a single series.",
            },
            horizontal: {
              type: SchemaType.BOOLEAN,
              description: "Bars only: set true when category labels are long.",
            },
            stacked: {
              type: SchemaType.BOOLEAN,
              description: "With a series: stack bars/areas instead of grouping them.",
            },
            yFormat: {
              type: SchemaType.STRING,
              description:
                "Value-axis format: 'currency', 'percent' (expects 0–1 fractions), or 'number'. Omit to auto-detect from the column name.",
            },
            title: { type: SchemaType.STRING, description: "Short chart title." },
          },
          required: ["type", "x", "y"],
        },
      },
      required: ["narrative"],
    },
  },
];
