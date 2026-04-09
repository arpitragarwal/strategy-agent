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
    description: "Contacts with account, role, region",
  },
  {
    id: "crm/opportunities",
    relativePath: "crm/opportunities.csv",
    domain: "crm",
    description: "Open pipeline by stage, amount, segment",
  },
  {
    id: "crm/accounts",
    relativePath: "crm/accounts.csv",
    domain: "crm",
    description: "Account firmographics and tier",
  },
  {
    id: "cx/survey_nps",
    relativePath: "cx/survey_nps.csv",
    domain: "cx",
    description: "NPS scores by segment and quarter",
  },
  {
    id: "cx/journey_events",
    relativePath: "cx/journey_events.csv",
    domain: "cx",
    description: "Digital journey funnel events and conversions",
  },
  {
    id: "cx/csats",
    relativePath: "cx/csats.csv",
    domain: "cx",
    description: "CX transaction CSAT by channel",
  },
  {
    id: "finance/pnl_monthly",
    relativePath: "finance/pnl_monthly.csv",
    domain: "finance",
    description: "Monthly revenue, COGS, OpEx by region",
  },
  {
    id: "finance/arr_by_segment",
    relativePath: "finance/arr_by_segment.csv",
    domain: "finance",
    description: "ARR and logo count by customer segment",
  },
  {
    id: "finance/cash_flow",
    relativePath: "finance/cash_flow.csv",
    domain: "finance",
    description: "Operating cash flow by quarter",
  },
  {
    id: "support/tickets",
    relativePath: "support/tickets.csv",
    domain: "support",
    description: "Support tickets: priority, product, resolution time",
  },
  {
    id: "support/sla_metrics",
    relativePath: "support/sla_metrics.csv",
    domain: "support",
    description: "SLA breach rate by team and week",
  },
  {
    id: "support/knowledge_base_hits",
    relativePath: "support/knowledge_base_hits.csv",
    domain: "support",
    description: "KB article views and deflection proxy",
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

export function buildDataCatalogMarkdown(): string {
  const lines = [
    "## Available quantitative datasets (CSV prototypes)",
    "",
    "Use `datasetId` exactly as listed. Design `steps` using only columns that exist in that file.",
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
