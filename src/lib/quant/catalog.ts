import { join } from "path";

export type DatasetMeta = {
  id: string;
  /** Path under data/dummy */
  relativePath: string;
  domain: "crm" | "cx" | "finance" | "support";
  description: string;
};

/** Registry of prototype datasets (CSV under /data/dummy). */
export const QUANT_DATASETS: DatasetMeta[] = [
  {
    id: "crm/accounts",
    relativePath: "crm/accounts.csv",
    domain: "crm",
    description:
      "Customers (~626): renewals/q ramp 2025-Q1 (100) → 2026-Q1 (~150); contract_term_years (1–5; 80% are 3yr); last_deal_year = renewal fiscal year − term; arr_usd_current after renewal (0 if churned)",
  },
  {
    id: "crm/renewals",
    relativePath: "crm/renewals.csv",
    domain: "crm",
    description:
      "Renewal opportunities (row count rises by quarter: ~100 in 2025-Q1 … ~150 in 2026-Q1): last_deal_year, contract_term_years, arr_up_for_renewal_usd, outcome, loss_reason (churned only; ~half pricing-related when last_deal_year is 2023), booked_arr_usd (renewed: 1–3× expiring ARR, mean mult ~1.6×), renewal_motion; 2023 cohort ~85% revenue GRR vs ~95% newer; NRR emergent",
  },
];

const byId = new Map(QUANT_DATASETS.map((d) => [d.id, d]));

export function resolveDatasetPath(datasetId: string): string {
  const meta = byId.get(datasetId);
  if (!meta) {
    throw new Error(`Unknown datasetId "${datasetId}". Use an id from the data catalog.`);
  }
  return join(process.cwd(), "data", "dummy", meta.relativePath);
}

export function getDatasetMeta(datasetId: string): DatasetMeta | undefined {
  return byId.get(datasetId);
}

/** Valid `datasetId` strings for prompts and validation (exact catalog keys). */
export function listQuantDatasetIds(): string[] {
  return QUANT_DATASETS.map((d) => d.id);
}

/** True if primary and every `join` step references a known catalog dataset. */
export function quantPlanReferencesValidDatasets(plan: {
  datasetId: string;
  steps: unknown[];
}): boolean {
  if (!getDatasetMeta(plan.datasetId)) return false;
  for (const step of plan.steps ?? []) {
    if (!step || typeof step !== "object") continue;
    const s = step as { op?: string; rightDatasetId?: string };
    if (s.op === "join" && typeof s.rightDatasetId === "string") {
      if (!getDatasetMeta(s.rightDatasetId)) return false;
    }
  }
  return true;
}

/** Documented join paths for multi-table quant plans (FK-style and matching dimensions). */
export const QUANT_JOIN_RELATIONSHIPS = [
  "**crm/renewals** → **crm/accounts** on [[\"account_id\",\"account_id\"]] for industry, contract_term_years, and arr_usd_current.",
] as const;

export function buildDataCatalogMarkdown(): string {
  const lines = [
    "## Available quantitative datasets (CSV prototypes)",
    "",
    "Use datasetId as the **primary (left) table**. Add **join** steps to bring in other catalog tables; right-hand columns appear with **rightPrefix** (default r_). Use **project** to keep only the columns you need before **groupby** / **chart**.",
    "",
    "### Multi-table joins",
    "",
    ...QUANT_JOIN_RELATIONSHIPS.map((s) => `- ${s}`),
    "",
    "Use datasetId values exactly as listed below. Column names must exist on the table where you reference them (after joins, use prefixed names from the right table).",
    "",
  ];
  const byDomain: Record<string, DatasetMeta[]> = { crm: [], cx: [], finance: [], support: [] };
  for (const d of QUANT_DATASETS) {
    byDomain[d.domain].push(d);
  }
  for (const domain of ["crm", "cx", "finance", "support"] as const) {
    lines.push(`### ${domain.toUpperCase()}`);
    for (const d of byDomain[domain]) {
      lines.push(`- **${d.id}** — ${d.description}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
