import { join } from "path";

export type DatasetMeta = {
  id: string;
  /** Path under data/dummy_data */
  relativePath: string;
  domain: "crm" | "cx" | "finance" | "support";
  description: string;
};

/**
 * Exact categorical literals in prototype CSVs (matches `scripts/generate-enterprise-saas-dummy.mjs`).
 * Quant `filter` with `cmp: "eq"` / `"neq"` is case-sensitive — use these strings, not synonyms.
 */
export const PROTOTYPE_FISCAL_QUARTERS = [
  "2025-Q1",
  "2025-Q2",
  "2025-Q3",
  "2025-Q4",
  "2026-Q1",
] as const;

export const PROTOTYPE_REGIONS = ["AMER", "EMEA", "APAC"] as const;

export const PROTOTYPE_PRODUCT_LINES = ["Platform", "Security", "Analytics"] as const;

export const PROTOTYPE_INDUSTRIES = [
  "Financial Services",
  "Healthcare",
  "Manufacturing",
  "Technology",
  "Retail",
  "Professional Services",
] as const;

export const PROTOTYPE_DEAL_TYPES = ["land", "expand", "renew"] as const;

export const PROTOTYPE_OUTCOMES = ["won", "lost"] as const;

export const PROTOTYPE_COMPANY_SIZE_BANDS = ["SMB", "Enterprise"] as const;

export const PROTOTYPE_DEAL_SOURCES = [
  "inbound",
  "partner",
  "sales_outbound",
  "csm_expansion",
  "event",
] as const;

/** Same literals as churn `loss_reason` in generated deal_data (lost rows). */
export const PROTOTYPE_PRIMARY_LOSS_REASONS = [
  "Pricing — budget freeze or cuts",
  "Pricing — rejected renewal uplift",
  "Pricing — lower competitive quote",
  "Commercial — payment or term mismatch",
  "Value — ROI / business case not approved",
  "Competitor — won evaluation",
  "Product — capability or roadmap gap",
  "Stakeholder — champion departed / reorg",
  "Timing — deprioritized / no decision",
  "Risk — security or compliance",
  "Adoption — low usage or failed rollout",
  "Procurement — vendor consolidation",
] as const;

export const PROTOTYPE_USAGE_TIERS = [
  "no_usage",
  "minimal_usage",
  "high_usage",
  "power_usage",
] as const;

/** contract_term_years in crm/deal_data and crm/accounts (integers 1–5 in prototype data). */
export const PROTOTYPE_CONTRACT_TERM_YEARS = [1, 2, 3, 4, 5] as const;

/**
 * Published allowed values per dataset for agent filters (string columns).
 * Numeric columns: use `gt`/`gte`/`lt`/`lte` with numbers — e.g. csat_score 1–5, nps_score −100…100.
 */
export const QUANT_ENUMS_BY_DATASET: Record<string, Record<string, readonly string[]>> = {
  "crm/deal_data": {
    fiscal_quarter: [...PROTOTYPE_FISCAL_QUARTERS],
    deal_type: [...PROTOTYPE_DEAL_TYPES],
    outcome: [...PROTOTYPE_OUTCOMES],
    product_line: [...PROTOTYPE_PRODUCT_LINES],
    region: [...PROTOTYPE_REGIONS],
    /** Same value set as `crm/accounts.industry`. */
    account_vertical: [...PROTOTYPE_INDUSTRIES],
    deal_source: [...PROTOTYPE_DEAL_SOURCES],
    primary_loss_reason: [...PROTOTYPE_PRIMARY_LOSS_REASONS],
  },
  "crm/accounts": {
    region: [...PROTOTYPE_REGIONS],
    industry: [...PROTOTYPE_INDUSTRIES],
    renewal_fiscal_quarter: [...PROTOTYPE_FISCAL_QUARTERS],
    company_size_band: [...PROTOTYPE_COMPANY_SIZE_BANDS],
  },
  "cx/product_usage": {
    fiscal_quarter: [...PROTOTYPE_FISCAL_QUARTERS],
    product_line: [...PROTOTYPE_PRODUCT_LINES],
    usage_tier: [...PROTOTYPE_USAGE_TIERS],
  },
  "cx/customer_satisfaction": {
    fiscal_quarter: [...PROTOTYPE_FISCAL_QUARTERS],
    product_line: [...PROTOTYPE_PRODUCT_LINES],
  },
  "finance/finance_summary": {
    fiscal_quarter: [...PROTOTYPE_FISCAL_QUARTERS],
  },
  "finance/arr_by_account_quarter": {
    fiscal_quarter: [...PROTOTYPE_FISCAL_QUARTERS],
  },
  "support/support_summary": {
    fiscal_quarter: [...PROTOTYPE_FISCAL_QUARTERS],
  },
};

function buildQuantEnumMarkdown(): string {
  const lines: string[] = [
    "### Filter literals (exact strings)",
    "",
    "For `filter` with `cmp: \"eq\"` or `\"neq\"`, use **only** the values below for these columns (case-sensitive). Do **not** use `Lost`, `Won`, `Renewal`, title case, or other CRM synonyms.",
    "",
    "- **crm/accounts** — `renewal_fiscal_quarter` may also be empty (`\"\"`) on some rows (e.g. new logos); omit filter or allow empty if you need those accounts.",
    "- **crm/deal_data** — `primary_loss_reason` is empty on **won** rows; on **lost** rows use the literals below (or copy from joined renewal context). `discount_pct` is numeric (0–100, ~50 prototype mean).",
    "- **finance/arr_by_account_quarter** — `account_id` matches **crm/accounts** (generated ids); not enumerated here.",
    "- **support/support_summary** — `account_id` matches **crm/accounts** / **cx/*** (generated ids such as `ACC-000001`); not enumerated here.",
    "- **cx/customer_satisfaction** — `csat_score` and `nps_score` are numeric; use range compares, not string `eq`, unless comparing to a number.",
    "",
  ];
  const ids = [
    "crm/deal_data",
    "crm/accounts",
    "cx/product_usage",
    "cx/customer_satisfaction",
    "finance/finance_summary",
    "finance/arr_by_account_quarter",
    "support/support_summary",
  ] as const;
  for (const id of ids) {
    const cols = QUANT_ENUMS_BY_DATASET[id];
    if (!cols) continue;
    lines.push(`- **${id}**`);
    for (const [col, vals] of Object.entries(cols)) {
      lines.push(`  - \`${col}\`: ${vals.map((v) => `\`${v}\``).join(", ")}`);
    }
  }
  lines.push("");
  lines.push(
    `- **Numeric enums** — \`contract_term_years\` on **crm/deal_data** / **crm/accounts**: integers ${PROTOTYPE_CONTRACT_TERM_YEARS.join(", ")}; **crm/accounts.logo_acquisition_year**, **crm/deal_data.logo_acquisition_year** (same value per \`account_id\` as accounts), and **crm/deal_data.discount_pct** are numeric (not string \`eq\`).`,
  );
  lines.push("");
  return lines.join("\n");
}

/** Registry of prototype datasets (CSV under /data/dummy_data). */
export const QUANT_DATASETS: DatasetMeta[] = [
  {
    id: "crm/accounts",
    relativePath: "crm/accounts.csv",
    domain: "crm",
    description:
      "Customers (~626): renewals/q ramp 2025-Q1 (100) → 2026-Q1 (~150); contract_term_years (1–5; 80% are 3yr); logo_acquisition_year (calendar year of initial logo / prior anchor); renewal_fiscal_quarter (when the account renews in the window); arr_usd_current after renewal (0 if churned); company_size_band (SMB | Enterprise).",
  },
  {
    id: "crm/deal_data",
    relativePath: "crm/deal_data.csv",
    domain: "crm",
    description:
      "Unified deal fact table for the window (renew + land + expand): logo_acquisition_year (same integer as **crm/accounts** for that account_id), fiscal_quarter (2025-Q1…2026-Q1, same label as CX), created_date (opportunity created; ~6 month mean sales cycle before close_date), close_date, account_vertical (consistent with accounts.industry), product_line (Platform/Security/Analytics), deal_type, outcome (won/lost), contract_term_years, acv_usd, tcv_usd, deal_source, discount_pct (0–100; prototype mean ~50), primary_loss_reason (empty if won; else churn/loss category).",
  },
  {
    id: "cx/product_usage",
    relativePath: "cx/product_usage.csv",
    domain: "cx",
    description:
      "Quarterly product engagement by SKU line: account_id, fiscal_quarter, product_line (Platform | Security | Analytics), usage_tier ∈ {no_usage, minimal_usage, high_usage, power_usage}. One row per account × fiscal_quarter × product_line while subscribed in the window; churned accounts have no rows after their renewal quarter.",
  },
  {
    id: "cx/customer_satisfaction",
    relativePath: "cx/customer_satisfaction.csv",
    domain: "cx",
    description:
      "Quarterly satisfaction at product line grain (matches cx/product_usage): account_id, fiscal_quarter, product_line (Platform | Security | Analytics), csat_score (1–5 Likert), nps_score (−100…100). CSAT/NPS correlate weakly with that line’s usage_tier in the generator.",
  },
  {
    id: "finance/finance_summary",
    relativePath: "finance/finance_summary.csv",
    domain: "finance",
    description:
      "Quarterly finance rollup derived from deal_data + accounts: fiscal_quarter, won/lost deals, ACV won/lost, billings_tcv, recognized_revenue, COGS, gross_profit, opex buckets, EBITDA, active_accounts.",
  },
  {
    id: "finance/arr_by_account_quarter",
    relativePath: "finance/arr_by_account_quarter.csv",
    domain: "finance",
    description:
      "End-of-quarter ARR run-rate per customer: account_id, fiscal_quarter, arr_usd. Computed from CRM deal_data (cumulative won land/expand ACV) plus renewal cohort fields (arr_up_for_renewal_usd before renewal quarter, booked_arr_usd on renew, 0 after churn); one row per active account × quarter in the renewal window.",
  },
  {
    id: "support/support_summary",
    relativePath: "support/support_summary.csv",
    domain: "support",
    description:
      "Quarterly support metrics per account: account_id, fiscal_quarter, ticket_count, avg_days_to_resolution. One row per account × fiscal_quarter while the subscription is active in the window (same logic as cx/product_usage); churned accounts have no rows after their renewal quarter.",
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
  "**support/support_summary** → **crm/accounts** on [[\"account_id\",\"account_id\"]] for region, industry, renewal slot.",
  "**support/support_summary** → **cx/product_usage** on [[\"account_id\",\"account_id\"],[\"fiscal_quarter\",\"fiscal_quarter\"]] (matches up to three rows per quarter by product_line on the right).",
  "**finance/arr_by_account_quarter** → **crm/accounts** on [[\"account_id\",\"account_id\"]]; → **crm/deal_data** on [[\"account_id\",\"account_id\"],[\"fiscal_quarter\",\"fiscal_quarter\"]] to reconcile with booked deals.",
  "**support/support_summary** — aggregate to one row per **fiscal_quarter** (e.g. sum ticket_count) before joining to **finance/finance_summary** on [[\"fiscal_quarter\",\"fiscal_quarter\"]] (finance has no account_id).",
  "**cx/product_usage** → **crm/deal_data** on [[\"account_id\",\"account_id\"],[\"fiscal_quarter\",\"fiscal_quarter\"],[\"product_line\",\"product_line\"]] when tying usage to booked product; account + quarter only is valid for account-level cuts.",
  "**cx/customer_satisfaction** → **cx/product_usage** on [[\"account_id\",\"account_id\"],[\"fiscal_quarter\",\"fiscal_quarter\"],[\"product_line\",\"product_line\"]] for usage_tier with csat_score / nps_score.",
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
    "Use datasetId values exactly as listed below. **Time bucket column is always `fiscal_quarter`** (string like 2025-Q1) on deal_data, CX, finance_summary, finance/arr_by_account_quarter, and support_summary. Column names must exist on the table where you reference them (after joins, use prefixed names from the right table).",
    "",
    "**Join naming:** If `on` includes `[\"product_line\",\"product_line\"]` (same name both sides), the merged row has a single **`product_line`** column — not `r_product_line`. Right-only fields (e.g. `usage_tier` from CX when the left table is `crm/deal_data`) appear as **`r_usage_tier`**.",
    "",
    buildQuantEnumMarkdown(),
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
