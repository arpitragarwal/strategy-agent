#!/usr/bin/env node
/**
 * Generates cohesive dummy CSVs under data/dummy for ~$200M ARR / ~2K customer enterprise SaaS.
 * Run: node scripts/generate-enterprise-saas-dummy.mjs
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "data", "dummy");

const TARGET_ARR_USD = 200_000_000;
const TARGET_LOGOS = 2000;

const SKUS = ["Core Suite", "Analytics Pro", "Automation Edge"];
const REGIONS = ["AMER", "EMEA", "APAC"];
/** Customer mix by region (share of logos). */
const REGION_LOGO_SHARE = { AMER: 0.52, EMEA: 0.3, APAC: 0.18 };
/** Regional list-price index vs AMER (USD equivalent). */
const REGION_PRICE_INDEX = { AMER: 1.0, EMEA: 0.92, APAC: 0.86 };
/** MoM revenue growth in PnL (APAC fastest). */
const REGION_MOM_GROWTH = { AMER: 0.022, EMEA: 0.016, APAC: 0.029 };

/** Relative win-rate proxy by region × SKU (late pipeline stages weighted higher). */
const WIN_RATE = {
  AMER: { "Core Suite": 0.32, "Analytics Pro": 0.24, "Automation Edge": 0.28 },
  EMEA: { "Core Suite": 0.24, "Analytics Pro": 0.17, "Automation Edge": 0.21 },
  APAC: { "Core Suite": 0.29, "Analytics Pro": 0.21, "Automation Edge": 0.25 },
};

const TIERS = ["Strategic", "Enterprise", "Mid-Market", "SMB"];
const TIER_SEG = { Strategic: "Enterprise", Enterprise: "Enterprise", "Mid-Market": "Mid-Market", SMB: "SMB" };

const INDUSTRIES = [
  "Financial Services",
  "Healthcare",
  "Manufacturing",
  "Retail",
  "Technology",
  "Professional Services",
  "Energy",
  "Telecommunications",
  "Public Sector",
  "Logistics",
];

const ADJ = [
  "Northwind",
  "Silverline",
  "BluePeak",
  "Cobalt",
  "Vertex",
  "Pinnacle",
  "Aurora",
  "Granite",
  "Meridian",
  "Parallel",
];
const NOUN = [
  "Labs",
  "Systems",
  "Dynamics",
  "Works",
  "Logic",
  "Cloud",
  "Bridge",
  "Point",
  "Stream",
  "Grid",
];

const ROLES = ["CFO", "VP Operations", "IT Director", "Head of Procurement", "Solutions Architect", "VP Engineering"];

const OPP_STAGES = ["Discovery", "Qualify", "Proposal", "Negotiate"];

const STEPS = ["Landing", "Signup", "Onboarding", "First Value", "Expansion Signal"];

function rng() {
  return Math.random();
}

function pick(arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function gaussian(mean, sd) {
  const u = 1 - rng();
  const v = rng();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return mean + z * sd;
}

function assignRegion() {
  const x = rng();
  if (x < REGION_LOGO_SHARE.AMER) return "AMER";
  if (x < REGION_LOGO_SHARE.AMER + REGION_LOGO_SHARE.EMEA) return "EMEA";
  return "APAC";
}

function tierForLogo(i) {
  const x = rng();
  if (x < 0.045) return "Strategic";
  if (x < 0.16) return "Enterprise";
  if (x < 0.44) return "Mid-Market";
  return "SMB";
}

function skuForAccount(region) {
  const w = rng() + (region === "APAC" ? 0.08 : 0) + (region === "EMEA" ? -0.03 : 0);
  if (w < 0.42) return "Core Suite";
  if (w < 0.78) return "Analytics Pro";
  return "Automation Edge";
}

function contractYears(tier) {
  const x = rng();
  if (tier === "Strategic" || tier === "Enterprise") {
    if (x < 0.15) return 1;
    if (x < 0.35) return 2;
    if (x < 0.6) return 3;
    if (x < 0.85) return 4;
    return 5;
  }
  if (x < 0.35) return 1;
  if (x < 0.65) return 2;
  if (x < 0.85) return 3;
  if (x < 0.95) return 4;
  return 5;
}

function baseArrForTier(tier) {
  const logMean = tier === "Strategic" ? 15.2 : tier === "Enterprise" ? 13.8 : tier === "Mid-Market" ? 12.2 : 10.5;
  const logSd = tier === "Strategic" ? 0.55 : tier === "Enterprise" ? 0.65 : tier === "Mid-Market" ? 0.75 : 0.9;
  return Math.exp(gaussian(logMean, logSd));
}

function stageFromWinRate(region, sku) {
  const wr = WIN_RATE[region][sku];
  const r = rng();
  /** Higher win rate → more mass on later stages. */
  const pNeg = 0.08 + wr * 0.35;
  const pProp = 0.18 + wr * 0.25;
  const pQual = 0.28 + wr * 0.1;
  const pDisc = 1 - pNeg - pProp - pQual;
  let u = rng();
  if (u < pDisc) return "Discovery";
  u -= pDisc;
  if (u < pQual) return "Qualify";
  u -= pQual;
  if (u < pProp) return "Proposal";
  return "Negotiate";
}

/** ~200% NRR and ~95% GRR with per-row noise (cohort reporting / sampling). */
function noisyRetentionPct() {
  const nrr_pct = Math.round(Math.max(172, Math.min(228, 200 + gaussian(0, 6))));
  const grr_pct =
    Math.round(Math.max(90.5, Math.min(98, 95 + gaussian(0, 0.95))) * 10) / 10;
  return { nrr_pct, grr_pct };
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, headers) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return lines.join("\n") + "\n";
}

function main() {
  mkdirSync(join(OUT, "crm"), { recursive: true });
  mkdirSync(join(OUT, "cx"), { recursive: true });
  mkdirSync(join(OUT, "finance" ), { recursive: true });
  mkdirSync(join(OUT, "support"), { recursive: true });

  const accounts = [];
  for (let i = 0; i < TARGET_LOGOS; i++) {
    const account_id = `A${String(i + 1).padStart(5, "0")}`;
    const region = assignRegion();
    const tier = tierForLogo(i);
    const primary_sku = skuForAccount(region);
    let arr_usd = baseArrForTier(tier) * REGION_PRICE_INDEX[region];
    const contract_term_years = contractYears(tier);
    const employees = Math.max(
      12,
      Math.round((Math.sqrt(arr_usd / 1200) + rng() * 40) * (tier === "Strategic" ? 2.2 : tier === "SMB" ? 0.85 : 1)),
    );
    const name = `${pick(ADJ)} ${pick(NOUN)}${rng() < 0.35 ? " Inc" : rng() < 0.5 ? " Ltd" : ""}`;
    accounts.push({
      account_id,
      account_name: name,
      industry: pick(INDUSTRIES),
      tier,
      region,
      employees,
      primary_sku,
      arr_usd,
      contract_term_years,
      regional_price_index: REGION_PRICE_INDEX[region],
    });
  }

  const arrSum = accounts.reduce((s, a) => s + a.arr_usd, 0);
  const scale = TARGET_ARR_USD / arrSum;
  for (const a of accounts) {
    a.arr_usd = Math.round(a.arr_usd * scale);
  }
  const drift = TARGET_ARR_USD - accounts.reduce((s, a) => s + a.arr_usd, 0);
  if (drift !== 0) {
    accounts.sort((x, y) => y.arr_usd - x.arr_usd);
    accounts[0].arr_usd += drift;
  }

  writeFileSync(join(OUT, "crm", "accounts.csv"), toCsv(accounts, [
    "account_id",
    "account_name",
    "industry",
    "tier",
    "region",
    "employees",
    "primary_sku",
    "arr_usd",
    "contract_term_years",
    "regional_price_index",
  ]));

  const contacts = [];
  let cid = 0;
  for (const a of accounts) {
    const n =
      a.tier === "Strategic" ? 2 + Math.floor(rng() * 4)
      : a.tier === "Enterprise" ? 2 + Math.floor(rng() * 3)
      : a.tier === "Mid-Market" ? 1 + Math.floor(rng() * 3)
      : 1 + Math.floor(rng() * 2);
    for (let k = 0; k < n; k++) {
      cid++;
      contacts.push({
        contact_id: `C${String(cid).padStart(6, "0")}`,
        account_id: a.account_id,
        account_name: a.account_name,
        role: pick(ROLES),
        region: a.region,
      });
    }
  }
  writeFileSync(join(OUT, "crm", "contacts.csv"), toCsv(contacts, ["contact_id", "account_id", "account_name", "role", "region"]));

  const opps = [];
  let oid = 0;
  for (const a of accounts) {
    if (rng() > 0.58) continue;
    const numOpps = 1 + Math.floor(rng() * (a.tier === "Strategic" ? 4 : a.tier === "SMB" ? 2 : 3));
    for (let k = 0; k < numOpps; k++) {
      oid++;
      const sku = rng() < 0.72 ? a.primary_sku : pick(SKUS);
      const stage = stageFromWinRate(a.region, sku);
      const seg = TIER_SEG[a.tier];
      const acvProxy = a.arr_usd * (0.08 + rng() * 0.55) * (sku === "Analytics Pro" ? 1.15 : sku === "Automation Edge" ? 1.08 : 1);
      const amount = Math.round(acvProxy * (0.85 + rng() * 0.35));
      opps.push({
        opportunity_id: `O${String(oid).padStart(6, "0")}`,
        account_id: a.account_id,
        account_name: a.account_name,
        stage,
        amount,
        segment: seg,
        owner_region: a.region,
        sku,
      });
    }
  }
  writeFileSync(
    join(OUT, "crm", "opportunities.csv"),
    toCsv(opps, ["opportunity_id", "account_id", "account_name", "stage", "amount", "segment", "owner_region", "sku"]),
  );

  const quarters = [];
  for (let y = 2024; y <= 2025; y++) {
    for (let q = 1; q <= 4; q++) quarters.push(`${y}-Q${q}`);
  }

  const segments = ["Enterprise", "Mid-Market", "SMB"];
  const npsRows = [];
  for (const segment of segments) {
    for (const quarter of quarters) {
      for (const region of REGIONS) {
        const base =
          region === "AMER" ? 48
          : region === "EMEA" ? 28
          : 33;
        const segAdj = segment === "Enterprise" ? 8 : segment === "Mid-Market" ? 0 : -6;
        const nps_score = Math.round(Math.max(-40, Math.min(75, base + segAdj + gaussian(0, 6))));
        const respondents = Math.round(
          (segment === "SMB" ? 520 : segment === "Mid-Market" ? 220 : 95) * (region === "AMER" ? 1.1 : region === "EMEA" ? 0.95 : 1.0) * (0.9 + rng() * 0.25),
        );
        npsRows.push({ segment, quarter, region, nps_score, respondents });
      }
    }
  }
  writeFileSync(join(OUT, "cx", "survey_nps.csv"), toCsv(npsRows, ["segment", "quarter", "region", "nps_score", "respondents"]));

  const journeyRows = [];
  const monday = (d) => {
    const dt = new Date(d);
    const day = dt.getUTCDay();
    const diff = (day + 6) % 7;
    dt.setUTCDate(dt.getUTCDate() - diff);
    return dt.toISOString().slice(0, 10);
  };
  for (let w = 0; w < 16; w++) {
    const start = new Date(Date.UTC(2025, 0, 6 + w * 7));
    const week = monday(start);
    for (const region of REGIONS) {
      let prev = 12000 + Math.round((REGION_LOGO_SHARE[region] * 8000 + rng() * 2000) * (1 + w * 0.012));
      for (let si = 0; si < STEPS.length; si++) {
        const step = STEPS[si];
        const baseConv =
          region === "AMER" ? 0.42
          : region === "APAC" ? 0.38
          : 0.35;
        const conversion_rate = Math.min(0.92, Math.max(0.12, baseConv - si * 0.04 + (rng() - 0.5) * 0.06));
        const event_count = Math.round(prev);
        prev = event_count * conversion_rate;
        journeyRows.push({
          step,
          event_count,
          conversion_rate: Math.round(conversion_rate * 1000) / 1000,
          week,
          region,
        });
      }
    }
  }
  writeFileSync(join(OUT, "cx", "journey_events.csv"), toCsv(journeyRows, ["step", "event_count", "conversion_rate", "week", "region"]));

  const channels = ["Email", "Chat", "Phone", "In-app"];
  const csatRows = [];
  for (const channel of channels) {
    for (const region of REGIONS) {
      const base = region === "AMER" ? 4.55 : region === "APAC" ? 4.35 : 4.25;
      const chAdj = channel === "Chat" ? 0.12 : channel === "In-app" ? 0.08 : channel === "Phone" ? 0 : -0.08;
      const csat_score = Math.round((base + chAdj + (rng() - 0.5) * 0.15) * 10) / 10;
      const sample_size = Math.round((400 + rng() * 600) * REGION_LOGO_SHARE[region] * 3);
      csatRows.push({ channel, region, csat_score, sample_size });
    }
  }
  writeFileSync(join(OUT, "cx", "csats.csv"), toCsv(csatRows, ["channel", "region", "csat_score", "sample_size"]));

  const pnlRows = [];
  const months = [];
  for (let y = 2024; y <= 2025; y++) {
    for (let m = 1; m <= 12; m++) months.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  const mrr0 = {
    AMER: (TARGET_ARR_USD / 12) * REGION_LOGO_SHARE.AMER,
    EMEA: (TARGET_ARR_USD / 12) * REGION_LOGO_SHARE.EMEA,
    APAC: (TARGET_ARR_USD / 12) * REGION_LOGO_SHARE.APAC,
  };
  for (let mi = 0; mi < months.length; mi++) {
    const month = months[mi];
    for (const region of REGIONS) {
      const growth = Math.pow(1 + REGION_MOM_GROWTH[region], mi);
      const revenue = Math.round(mrr0[region] * growth * (0.97 + rng() * 0.04));
      const cogs = Math.round(revenue * (0.34 + rng() * 0.06));
      const opex = Math.round(revenue * (0.22 + rng() * 0.05));
      pnlRows.push({ month, region, revenue, cogs, opex });
    }
  }
  writeFileSync(join(OUT, "finance", "pnl_monthly.csv"), toCsv(pnlRows, ["month", "region", "revenue", "cogs", "opex"]));

  const arrAgg = {};
  for (const a of accounts) {
    const seg = TIER_SEG[a.tier];
    const key = `${seg}|${a.region}`;
    if (!arrAgg[key]) arrAgg[key] = { arr_usd: 0, logo_count: 0 };
    arrAgg[key].arr_usd += a.arr_usd;
    arrAgg[key].logo_count += 1;
  }
  const arrRows = [];
  for (const [key, v] of Object.entries(arrAgg)) {
    const [segment, region] = key.split("|");
    const { nrr_pct, grr_pct } = noisyRetentionPct();
    arrRows.push({
      segment,
      region,
      arr_usd: Math.round(v.arr_usd),
      logo_count: v.logo_count,
      nrr_pct,
      grr_pct,
    });
  }
  arrRows.sort((a, b) => a.segment.localeCompare(b.segment) || a.region.localeCompare(b.region));
  writeFileSync(
    join(OUT, "finance", "arr_by_segment.csv"),
    toCsv(arrRows, ["segment", "region", "arr_usd", "logo_count", "nrr_pct", "grr_pct"]),
  );

  const cfRows = [];
  for (const quarter of ["2024-Q3", "2024-Q4", "2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4"]) {
    const operating_cash_flow_musd = Math.round((11 + rng() * 5 + (quarter.startsWith("2025") ? 2.2 : 0)) * 10) / 10;
    cfRows.push({ quarter, operating_cash_flow_musd });
  }
  writeFileSync(join(OUT, "finance", "cash_flow.csv"), toCsv(cfRows, ["quarter", "operating_cash_flow_musd"]));

  const tickets = [];
  let tid = 0;
  for (let i = 0; i < 8500; i++) {
    const a = accounts[Math.floor(rng() * accounts.length)];
    tid++;
    const product = rng() < 0.7 ? a.primary_sku : pick(SKUS);
    const priority = rng() < 0.08 ? "P1" : rng() < 0.35 ? "P2" : "P3";
    const baseHours = priority === "P1" ? 6 : priority === "P2" ? 18 : 36;
    const resolution_hours = Math.round((baseHours * (0.5 + rng()) * (a.region === "EMEA" ? 1.05 : 1)) * 10) / 10;
    tickets.push({
      ticket_id: `T${String(tid).padStart(6, "0")}`,
      priority,
      product,
      region: a.region,
      resolution_hours,
    });
  }
  writeFileSync(
    join(OUT, "support", "tickets.csv"),
    toCsv(tickets, ["ticket_id", "priority", "product", "region", "resolution_hours"]),
  );

  const teams = ["L1", "L2", "L3"];
  const slaRows = [];
  for (let w = 0; w < 20; w++) {
    const d = new Date(Date.UTC(2025, 1, 3 + w * 7));
    const week_start = d.toISOString().slice(0, 10);
    for (const team of teams) {
      for (const region of REGIONS) {
        const baseBreach = team === "L1" ? 2.2 : team === "L2" ? 3.8 : 5.2;
        const regAdj = region === "APAC" ? 0.4 : region === "EMEA" ? 0.2 : 0;
        const breach_rate_pct = Math.round((baseBreach + regAdj + (rng() - 0.5) * 1.2) * 10) / 10;
        slaRows.push({ team, week_start, region, breach_rate_pct });
      }
    }
  }
  writeFileSync(join(OUT, "support", "sla_metrics.csv"), toCsv(slaRows, ["team", "week_start", "region", "breach_rate_pct"]));

  const kbArticles = [
    ["sso-setup-enterprise", "Core Suite"],
    ["analytics-pro-embed-api", "Analytics Pro"],
    ["workflow-automation-triggers", "Automation Edge"],
    ["core-suite-user-provisioning", "Core Suite"],
    ["analytics-data-export-governance", "Analytics Pro"],
    ["invoice-and-tax-regions", "Core Suite"],
  ];
  const kbRows = [];
  for (const [slug, related_sku] of kbArticles) {
    kbRows.push({
      article_slug: slug,
      views: Math.round(800 + rng() * 6200),
      deflection_proxy: Math.round(200 + rng() * 1400),
      related_sku,
    });
  }
  writeFileSync(
    join(OUT, "support", "knowledge_base_hits.csv"),
    toCsv(kbRows, ["article_slug", "views", "deflection_proxy", "related_sku"]),
  );

  const realizedArr = accounts.reduce((s, a) => s + a.arr_usd, 0);
  console.log(`Wrote CSVs under ${OUT}`);
  console.log(`Accounts: ${accounts.length}, total arr_usd: ${realizedArr} (target ${TARGET_ARR_USD})`);
  console.log(`Contacts: ${contacts.length}, Opportunities: ${opps.length}, Tickets: ${tickets.length}`);
}

main();
