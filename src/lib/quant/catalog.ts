import { join } from "path";

export type DatasetMeta = {
  id: string;
  /** Path under data/dummy_data */
  relativePath: string;
  domain: "crm" | "cx" | "finance" | "support";
  description: string;
};

/** Registry of prototype datasets (CSV under /data/dummy_data). */
export const QUANT_DATASETS: DatasetMeta[] = [
  {
    id: "crm/accounts",
    relativePath: "crm/accounts.csv",
    domain: "crm",
    description:
      "Customers (~626): renewals/q ramp 2025-Q1 (100) → 2026-Q1 (~150); contract_term_years (1–5; 80% are 3yr); last_deal_year = renewal fiscal year − term; arr_usd_current after renewal (0 if churned)",
  },
  {
    id: "crm/deal_data",
    relativePath: "crm/deal_data.csv",
    domain: "crm",
    description:
      "Unified deal fact table for the window (renew + land + expand): close_date, account_vertical (consistent with accounts.industry), product_line (Platform/Security/Analytics), deal_type, outcome (won/lost), contract_term_years, acv_usd, tcv_usd.",
  },
  {
    id: "cx/product_usage",
    relativePath: "cx/product_usage.csv",
    domain: "cx",
    description:
      "Quarterly product engagement for active subscribers: account_id, fiscal_quarter (2025-Q1…2026-Q1), usage_tier ∈ {no_usage, minimal_usage, high_usage, power_usage}. One row per account per quarter they had an active subscription in the window; churned accounts have no rows after their renewal quarter.",
  },
  {
    id: "cx/customer_satisfaction",
    relativePath: "cx/customer_satisfaction.csv",
    domain: "cx",
    description:
      "Quarterly satisfaction aligned to cx/product_usage rows: account_id, fiscal_quarter, csat_score (1–5 Likert), nps_score (−100…100). CSAT/NPS correlate weakly with usage_tier in the generator.",
  },
  {
    id: "finance/finance_summary",
    relativePath: "finance/finance_summary.csv",
    domain: "finance",
    description:
      "Quarterly finance rollup derived from deal_data + accounts: won/lost deals, ACV won/lost, billings_tcv, recognized_revenue, COGS, gross_profit, opex buckets, EBITDA, active_accounts.",
  },
  {
    id: "support/support_summary",
    relativePath: "support/support_summary.csv",
    domain: "support",
    description:
      "Quarterly support rollup derived from deal/account activity: ticket_count and avg_days_to_resolution for each quarter.",
  },
];

const byId = new Map(QUANT_DATASETS.map((d) => [d.id, d]));

export function resolveDatasetPath(datasetId: string): string {
  const meta = byId.get(datasetId);
  if (!meta) {
    throw new Error(`Unknown datasetId "${datasetId}". Use an id from the data catalog.`);
  }
  return join(process.cwd(), "data", "dummy_data", meta.relativePath);
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
    const s = step as { op?: string; rightDatasetId?: unknown };
    if (s.op === "join") {
      if (typeof s.rightDatasetId !== "string" || !s.rightDatasetId.trim()) {
        return false;
      }
      if (!getDatasetMeta(s.rightDatasetId)) return false;
    }
  }
  return true;
}

/** Documented join paths for multi-table quant plans (FK-style and matching dimensions). */
export const QUANT_JOIN_RELATIONSHIPS = [
  "**crm/deal_data** → **crm/accounts** on [[\"account_id\",\"account_id\"]] for industry, region consistency checks, and account attributes.",
  "**finance/finance_summary** is already aggregated by quarter; join to CRM/CX only on quarter-level summaries if needed.",
  "**support/support_summary** is quarter-aggregated; combine with finance/finance_summary by quarter for service load vs unit economics.",
  "**cx/product_usage** → **crm/deal_data** on [[\"account_id\",\"account_id\"]] (attribute usage by account to deal_type/outcome).",
  "**cx/customer_satisfaction** → **cx/product_usage** on [[\"account_id\",\"account_id\"],[\"fiscal_quarter\",\"fiscal_quarter\"]] for usage_tier with csat_score / nps_score.",
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
