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
    id: "crm/contacts",
    relativePath: "crm/contacts.csv",
    domain: "crm",
    description: "Contacts with account, role, region (AMER/EMEA/APAC)",
  },
  {
    id: "crm/opportunities",
    relativePath: "crm/opportunities.csv",
    domain: "crm",
    description:
      "Pipeline: deal_type land | expand | renewal (chronology + anniversaries); Closed Won/Lost; close_quarter, loss_reason",
  },
  {
    id: "crm/accounts",
    relativePath: "crm/accounts.csv",
    domain: "crm",
    description:
      "Accounts: tier, region, primary_sku, arr_usd, contract_term_years, customer_since_quarter, price index",
  },
  {
    id: "cx/survey_nps",
    relativePath: "cx/survey_nps.csv",
    domain: "cx",
    description:
      "NPS by segment (aligns with account tier→segment), quarter, region; respondents scale with logo count",
  },
  {
    id: "cx/journey_events",
    relativePath: "cx/journey_events.csv",
    domain: "cx",
    description:
      "Funnel by week (same Mon weeks as support tickets) and region; volumes scale with regional logo share",
  },
  {
    id: "cx/csats",
    relativePath: "cx/csats.csv",
    domain: "cx",
    description: "CSAT by channel and region; sample_size scales with accounts in region",
  },
  {
    id: "finance/pnl_monthly",
    relativePath: "finance/pnl_monthly.csv",
    domain: "finance",
    description:
      "Monthly revenue, COGS, OpEx by region — revenue path ties to crm/accounts regional ARR (end MRR = ARR÷12, MoM growth)",
  },
  {
    id: "finance/arr_by_segment",
    relativePath: "finance/arr_by_segment.csv",
    domain: "finance",
    description: "ARR and logos by segment and region; nrr_pct / grr_pct company KPIs",
  },
  {
    id: "finance/cash_flow",
    relativePath: "finance/cash_flow.csv",
    domain: "finance",
    description:
      "Quarterly operating cash flow (MUSD) derived from pnl_monthly: sum(revenue−cogs−opex) per quarter",
  },
  {
    id: "support/tickets",
    relativePath: "support/tickets.csv",
    domain: "support",
    description:
      "Tickets: account_id, tier, priority, product (SKU), region, resolution_hours, week_start (UTC Mon)",
  },
  {
    id: "support/sla_metrics",
    relativePath: "support/sla_metrics.csv",
    domain: "support",
    description:
      "SLA breach % by team (L1/L2/L3↔P1/P2/P3), week, region — aggregated from tickets vs hour targets",
  },
  {
    id: "support/knowledge_base_hits",
    relativePath: "support/knowledge_base_hits.csv",
    domain: "support",
    description: "KB views/deflection scale with primary_sku adoption (accounts.primary_sku counts)",
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

/** Documented join paths for multi-table quant plans (FK-style and matching dimensions). */
export const QUANT_JOIN_RELATIONSHIPS = [
  "**account_id** — crm/opportunities, crm/contacts, support/tickets → join to **crm/accounts** on [[\"account_id\",\"account_id\"]] for tier, arr_usd, industry, region, primary_sku, etc.",
  "**Segment + region** — crm/opportunities has segment and owner_region; **cx/survey_nps** has segment and region — use [[\"segment\",\"segment\"],[\"owner_region\",\"region\"]] (column names differ on the left).",
  "**Tickets + accounts** — support/tickets → crm/accounts on account_id for ARR / tier / SKU context.",
  "**Chained joins** — start from one datasetId, then multiple join steps. Use distinct **rightPrefix** values (e.g. acc_, sup_) if you join more than one table so column names do not overwrite each other.",
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
