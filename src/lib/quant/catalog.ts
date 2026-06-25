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
      "Customers (~1.25k): renewals/q ramp 2025-Q1 (~200) → 2026-Q1 (~300); contract_term_years (1–5; 80% are 3yr); logo_acquisition_cohort (calendar year of initial logo / prior anchor, used as cohort id); renewal_fiscal_quarter (when the account renews in the window); arr_usd_current after renewal (0 if churned); company_size_band (SMB | Enterprise).",
  },
  {
    id: "crm/deal_data",
    relativePath: "crm/deal_data.csv",
    domain: "crm",
    description:
      "Unified deal fact table for the window (renew + land + expand): logo_acquisition_cohort (same integer as crm/accounts for that account_id), fiscal_quarter (2025-Q1…2026-Q1), created_date (opportunity created; ~6 month mean sales cycle before close_date), close_date, account_vertical (consistent with accounts.industry), product_line (Platform/Security/Analytics), deal_type (land|expand|renew), outcome (won|lost), contract_term_years, acv_usd, tcv_usd, deal_source, primary_loss_reason (empty if won; else churn/loss category).",
  },
  {
    id: "cx/product_usage",
    relativePath: "cx/product_usage.csv",
    domain: "cx",
    description:
      "Quarterly product engagement by SKU line: account_id, fiscal_quarter, product_line (Platform|Security|Analytics), usage_tier (no_usage|minimal_usage|high_usage|power_usage). One row per account × fiscal_quarter × product_line while subscribed in the window; churned accounts have no rows after their renewal quarter.",
  },
  {
    id: "cx/customer_satisfaction",
    relativePath: "cx/customer_satisfaction.csv",
    domain: "cx",
    description:
      "Quarterly satisfaction at product line grain (matches cx/product_usage): account_id, fiscal_quarter, product_line, csat_score (1–5 Likert), nps_score (−100…100). CSAT/NPS correlate weakly with that line's usage_tier in the generator.",
  },
  {
    id: "finance/finance_summary",
    relativePath: "finance/finance_summary.csv",
    domain: "finance",
    description:
      "Quarterly finance rollup derived from deal_data + accounts: fiscal_quarter, won/lost deals, ACV won/lost, billings_tcv, recognized_revenue, COGS, gross_profit, opex buckets, EBITDA, active_accounts. No account_id (already aggregated).",
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
      "Quarterly support metrics per account: account_id, fiscal_quarter, ticket_count, avg_days_to_resolution. One row per account × fiscal_quarter while the subscription is active (same logic as cx/product_usage); churned accounts have no rows after their renewal quarter.",
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

/** Catalog ids — used as the canonical list for prompts and audit display. */
export function listQuantDatasetIds(): string[] {
  return QUANT_DATASETS.map((d) => d.id);
}

/**
 * Lightweight catalog for prompts that surface a dataset list to the user
 * (synthesis, manager review). Enum literals and join recipes are no longer
 * spelled out here — the SQL agent discovers them via describe_table.
 */
export function buildDataCatalogMarkdown(): string {
  const lines = [
    "## Prototype datasets (synthetic CSV; SELECT-only via DuckDB views)",
    "",
    "Catalog id appears in agent audit logs; the table name (slash → underscore) is what SQL queries against.",
    "",
  ];
  const byDomain: Record<string, DatasetMeta[]> = { crm: [], cx: [], finance: [], support: [] };
  for (const d of QUANT_DATASETS) byDomain[d.domain].push(d);
  for (const domain of ["crm", "cx", "finance", "support"] as const) {
    lines.push(`### ${domain.toUpperCase()}`);
    for (const d of byDomain[domain]) {
      lines.push(`- **${d.id}** — ${d.description}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
