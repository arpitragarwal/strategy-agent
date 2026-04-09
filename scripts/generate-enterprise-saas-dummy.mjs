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

const STEPS = ["Landing", "Signup", "Onboarding", "First Value", "Expansion Signal"];

/** Quarters for closed opp history (aligns with NPS window). */
const HISTORICAL_QUARTERS = (() => {
  const q = [];
  for (let y = 2024; y <= 2025; y++) {
    for (let qi = 1; qi <= 4; qi++) q.push(`${y}-Q${qi}`);
  }
  return q;
})();

const LOSS_REASONS_WEIGHTED = [
  ["competitor", 0.28],
  ["price_budget", 0.22],
  ["timing_priorities", 0.18],
  ["no_decision", 0.12],
  ["product_gap", 0.1],
  ["champion_departed", 0.05],
  ["security_compliance", 0.05],
];

/** Rough count of historical closed rows (won + lost) spread across HISTORICAL_QUARTERS. */
const TARGET_CLOSED_OPPORTUNITIES = 3400;

/** Support ticket weeks (UTC Mondays) — shared by tickets + SLA rollups. */
const TICKET_SLA_WEEK_COUNT = 20;

const SLA_TARGET_HOURS = { P1: 8, P2: 24, P3: 48 };
const PRIORITY_FOR_TEAM = { L1: "P1", L2: "P2", L3: "P3" };

function quarterToIndex(q) {
  const m = String(q).match(/^(\d{4})-Q([1-4])$/);
  if (!m) return 0;
  return (parseInt(m[1], 10) - 2024) * 4 + (parseInt(m[2], 10) - 1);
}

function indexToQuarter(idx) {
  const y = 2024 + Math.floor(idx / 4);
  const qi = (idx % 4) + 1;
  return `${y}-Q${qi}`;
}

/** First quarter this account appears as a customer (anchors land / renewals). */
function customerSinceQuarterForTier(tier) {
  const maxIdx = HISTORICAL_QUARTERS.length - 1;
  if (tier === "Strategic") {
    const idx = rng() < 0.45 ? Math.floor(rng() * 3) : Math.floor(rng() * (maxIdx + 1));
    return HISTORICAL_QUARTERS[Math.min(idx, maxIdx)];
  }
  if (tier === "Enterprise") {
    return HISTORICAL_QUARTERS[Math.floor(rng() * (maxIdx + 1))];
  }
  if (tier === "Mid-Market") {
    const idx = 1 + Math.floor(rng() * maxIdx);
    return HISTORICAL_QUARTERS[Math.min(Math.max(0, idx), maxIdx)];
  }
  const idx = 3 + Math.floor(rng() * Math.max(1, maxIdx - 2));
  return HISTORICAL_QUARTERS[Math.min(idx, maxIdx)];
}

/** Quarters near subscription anniversaries (renewal cycles). */
function renewalQuarterSet(customerSinceIdx, contractYears, minIdx, maxIdx) {
  const termQ = Math.max(4, Math.round(Number(contractYears)) * 4);
  const set = new Set();
  for (let cycle = 0; cycle <= 5; cycle++) {
    const ann = customerSinceIdx + cycle * termQ;
    for (const d of [-1, 0, 1]) {
      const idx = ann + d;
      if (idx >= minIdx && idx <= maxIdx) set.add(indexToQuarter(idx));
    }
  }
  return set;
}

function sampleUniqueQuarters(pool, n) {
  const copy = [...pool];
  const out = [];
  const take = Math.min(n, copy.length);
  for (let i = 0; i < take; i++) {
    const idx = Math.floor(rng() * copy.length);
    out.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return out;
}

function skuForDealType(a, deal_type) {
  if (deal_type === "renewal") {
    return rng() < 0.93 ? a.primary_sku : pick(SKUS);
  }
  if (deal_type === "land") {
    return rng() < 0.78 ? a.primary_sku : pick(SKUS);
  }
  const alt = SKUS.filter((s) => s !== a.primary_sku);
  if (alt.length && rng() < 0.65) return pick(alt);
  return a.primary_sku;
}

/** Deal size vs current account ARR — land largest slice, renewal near book, expand add-on. */
function amountForDealType(a, deal_type, isClosed) {
  const base = a.arr_usd;
  if (deal_type === "renewal") {
    const f = isClosed ? 0.84 + rng() * 0.22 : 0.7 + rng() * 0.28;
    return Math.round(base * f);
  }
  if (deal_type === "land") {
    const f = isClosed ? 0.1 + rng() * 0.34 : 0.08 + rng() * 0.48;
    return Math.round(base * f);
  }
  const f = isClosed ? 0.045 + rng() * 0.2 : 0.055 + rng() * 0.22;
  return Math.round(base * f);
}

function openPipelineDealType() {
  const x = rng();
  if (x < 0.2) return "renewal";
  if (x < 0.68) return "expand";
  return "land";
}

function rng() {
  return Math.random();
}

function pick(arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function pickLossReason() {
  const x = rng();
  let c = 0;
  for (const [reason, w] of LOSS_REASONS_WEIGHTED) {
    c += w;
    if (x < c) return reason;
  }
  return "no_decision";
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
    const customer_since_quarter = customerSinceQuarterForTier(tier);
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
      customer_since_quarter,
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
    "customer_since_quarter",
    "regional_price_index",
  ]));

  const countByRegion = { AMER: 0, EMEA: 0, APAC: 0 };
  const countBySegmentRegion = new Map();
  const primarySkuLogoCount = {};
  for (const a of accounts) {
    countByRegion[a.region]++;
    const seg = TIER_SEG[a.tier];
    const srKey = `${seg}|${a.region}`;
    countBySegmentRegion.set(srKey, (countBySegmentRegion.get(srKey) ?? 0) + 1);
    primarySkuLogoCount[a.primary_sku] = (primarySkuLogoCount[a.primary_sku] ?? 0) + 1;
  }
  const totalLogos = accounts.length;

  const ticketWeekStarts = [];
  for (let w = 0; w < TICKET_SLA_WEEK_COUNT; w++) {
    const d = new Date(Date.UTC(2025, 1, 3 + w * 7));
    ticketWeekStarts.push(d.toISOString().slice(0, 10));
  }

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
      const deal_type = openPipelineDealType();
      const sku = skuForDealType(a, deal_type);
      const stage = stageFromWinRate(a.region, sku);
      const seg = TIER_SEG[a.tier];
      let amount = amountForDealType(a, deal_type, false);
      amount = Math.round(amount * (sku === "Analytics Pro" ? 1.06 : sku === "Automation Edge" ? 1.03 : 1));
      opps.push({
        opportunity_id: `O${String(oid).padStart(6, "0")}`,
        account_id: a.account_id,
        account_name: a.account_name,
        stage,
        amount,
        segment: seg,
        owner_region: a.region,
        sku,
        deal_type,
        close_quarter: "",
        loss_reason: "",
      });
    }
  }

  let closedBudget = TARGET_CLOSED_OPPORTUNITIES;
  const qIdxMin = 0;
  const qIdxMax = HISTORICAL_QUARTERS.length - 1;
  const accShuffled = [...accounts].sort(() => rng() - 0.5);

  for (const a of accShuffled) {
    if (closedBudget <= 0) break;
    const custIdx = quarterToIndex(a.customer_since_quarter);
    const pool = HISTORICAL_QUARTERS.filter((q) => quarterToIndex(q) >= custIdx);
    if (!pool.length) continue;

    const renewSet = renewalQuarterSet(custIdx, a.contract_term_years, qIdxMin, qIdxMax);
    const maxN = Math.min(5, closedBudget, pool.length);
    if (maxN < 1) continue;
    const nDesired = 1 + Math.floor(rng() * maxN);
    const picks = sampleUniqueQuarters(pool, nDesired).sort(
      (q1, q2) => quarterToIndex(q1) - quarterToIndex(q2),
    );
    closedBudget -= picks.length;

    picks.forEach((close_quarter, ord) => {
      oid++;
      let deal_type;
      if (ord === 0) {
        deal_type = "land";
      } else if (renewSet.has(close_quarter) && rng() < 0.84) {
        deal_type = "renewal";
      } else if (rng() < 0.74) {
        deal_type = "expand";
      } else {
        deal_type = rng() < 0.52 ? "land" : "renewal";
      }

      const sku = skuForDealType(a, deal_type);
      const wr = WIN_RATE[a.region][sku];
      const winProb = Math.max(0.12, Math.min(0.48, wr + gaussian(0, 0.04)));
      const won = rng() < winProb;
      const seg = TIER_SEG[a.tier];
      let amount = amountForDealType(a, deal_type, true);
      amount = Math.round(amount * (sku === "Analytics Pro" ? 1.06 : sku === "Automation Edge" ? 1.03 : 1));

      opps.push({
        opportunity_id: `O${String(oid).padStart(6, "0")}`,
        account_id: a.account_id,
        account_name: a.account_name,
        stage: won ? "Closed Won" : "Closed Lost",
        amount,
        segment: seg,
        owner_region: a.region,
        sku,
        deal_type,
        close_quarter,
        loss_reason: won ? "" : pickLossReason(),
      });
    });
  }

  writeFileSync(
    join(OUT, "crm", "opportunities.csv"),
    toCsv(opps, [
      "opportunity_id",
      "account_id",
      "account_name",
      "stage",
      "amount",
      "segment",
      "owner_region",
      "sku",
      "deal_type",
      "close_quarter",
      "loss_reason",
    ]),
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
        const logosInCell = countBySegmentRegion.get(`${segment}|${region}`) ?? 0;
        const respondents = Math.max(
          6,
          Math.round(
            logosInCell *
              (0.1 + rng() * 0.28) *
              (0.78 + rng() * 0.35) *
              (region === "AMER" ? 1.08 : region === "EMEA" ? 0.96 : 1.02) *
              (segment === "SMB" ? 1.15 : segment === "Mid-Market" ? 1.05 : 1),
          ),
        );
        npsRows.push({ segment, quarter, region, nps_score, respondents });
      }
    }
  }
  writeFileSync(join(OUT, "cx", "survey_nps.csv"), toCsv(npsRows, ["segment", "quarter", "region", "nps_score", "respondents"]));

  const journeyRows = [];
  for (let w = 0; w < 16; w++) {
    const week = ticketWeekStarts[w];
    for (const region of REGIONS) {
      const regShare = countByRegion[region] / totalLogos;
      let prev =
        6500 + Math.round((regShare * 24000 + rng() * 1800) * (1 + w * 0.012));
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
      const chFactor = channel === "Chat" ? 1.25 : channel === "In-app" ? 1.12 : channel === "Phone" ? 0.85 : 1;
      const sample_size = Math.max(
        24,
        Math.round(countByRegion[region] * (0.32 + rng() * 0.38) * chFactor),
      );
      csatRows.push({ channel, region, csat_score, sample_size });
    }
  }
  writeFileSync(join(OUT, "cx", "csats.csv"), toCsv(csatRows, ["channel", "region", "csat_score", "sample_size"]));

  /** Regional ARR from CRM — P&amp;L MRR ends aligned to account roll-forward. */
  const arrByRegion = { AMER: 0, EMEA: 0, APAC: 0 };
  for (const a of accounts) {
    arrByRegion[a.region] += a.arr_usd;
  }

  const pnlRows = [];
  const months = [];
  for (let y = 2024; y <= 2025; y++) {
    for (let m = 1; m <= 12; m++) months.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  const nM = months.length;
  for (let mi = 0; mi < nM; mi++) {
    const month = months[mi];
    for (const region of REGIONS) {
      const targetMrrEnd = arrByRegion[region] / 12;
      const g = REGION_MOM_GROWTH[region];
      const mrrStart = targetMrrEnd / Math.pow(1 + g, nM - 1);
      const revenue = Math.round(mrrStart * Math.pow(1 + g, mi));
      const cogs = Math.round(revenue * (0.34 + rng() * 0.06));
      const opex = Math.round(revenue * (0.22 + rng() * 0.05));
      pnlRows.push({ month, region, revenue, cogs, opex });
    }
  }
  writeFileSync(join(OUT, "finance", "pnl_monthly.csv"), toCsv(pnlRows, ["month", "region", "revenue", "cogs", "opex"]));

  function monthToQuarterKey(monthStr) {
    const [ys, ms] = monthStr.split("-");
    const y = parseInt(ys, 10);
    const m = parseInt(ms, 10);
    const q = Math.floor((m - 1) / 3) + 1;
    return `${y}-Q${q}`;
  }

  const cfQuarterOrder = ["2024-Q3", "2024-Q4", "2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4"];
  const cfSums = Object.fromEntries(cfQuarterOrder.map((q) => [q, 0]));
  for (const row of pnlRows) {
    const qk = monthToQuarterKey(row.month);
    if (qk in cfSums) {
      cfSums[qk] += row.revenue - row.cogs - row.opex;
    }
  }
  const cfRows = cfQuarterOrder.map((quarter) => ({
    quarter,
    operating_cash_flow_musd: Math.round((cfSums[quarter] / 1_000_000) * 10) / 10,
  }));
  writeFileSync(join(OUT, "finance", "cash_flow.csv"), toCsv(cfRows, ["quarter", "operating_cash_flow_musd"]));

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

  const tickets = [];
  let tid = 0;
  for (let i = 0; i < 8500; i++) {
    const a = accounts[Math.floor(rng() * accounts.length)];
    tid++;
    const product = rng() < 0.7 ? a.primary_sku : pick(SKUS);
    const priority = rng() < 0.08 ? "P1" : rng() < 0.35 ? "P2" : "P3";
    const baseHours = priority === "P1" ? 6 : priority === "P2" ? 18 : 36;
    const resolution_hours = Math.round((baseHours * (0.5 + rng()) * (a.region === "EMEA" ? 1.05 : 1)) * 10) / 10;
    const week_start = pick(ticketWeekStarts);
    tickets.push({
      ticket_id: `T${String(tid).padStart(6, "0")}`,
      account_id: a.account_id,
      tier: a.tier,
      priority,
      product,
      region: a.region,
      resolution_hours,
      week_start,
    });
  }
  writeFileSync(
    join(OUT, "support", "tickets.csv"),
    toCsv(tickets, [
      "ticket_id",
      "account_id",
      "tier",
      "priority",
      "product",
      "region",
      "resolution_hours",
      "week_start",
    ]),
  );

  const teams = ["L1", "L2", "L3"];
  const slaRows = [];
  for (const week_start of ticketWeekStarts) {
    for (const team of teams) {
      for (const region of REGIONS) {
        const pri = PRIORITY_FOR_TEAM[team];
        const subset = tickets.filter(
          (t) => t.week_start === week_start && t.region === region && t.priority === pri,
        );
        let breach_rate_pct;
        if (subset.length < 3) {
          breach_rate_pct =
            Math.round(
              (2.0 + (team === "L2" ? 1.4 : team === "L3" ? 2.4 : 0) + (rng() - 0.5) * 2.2) * 10,
            ) / 10;
        } else {
          const target = SLA_TARGET_HOURS[pri];
          const breaches = subset.filter((t) => t.resolution_hours > target).length;
          breach_rate_pct = Math.round(((100 * breaches) / subset.length) * 10) / 10;
        }
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
    const nSku = primarySkuLogoCount[related_sku] ?? 0;
    kbRows.push({
      article_slug: slug,
      views: Math.round(320 + nSku * (90 + rng() * 50) + rng() * 2100),
      deflection_proxy: Math.round(110 + nSku * (26 + rng() * 16) + rng() * 480),
      related_sku,
    });
  }
  writeFileSync(
    join(OUT, "support", "knowledge_base_hits.csv"),
    toCsv(kbRows, ["article_slug", "views", "deflection_proxy", "related_sku"]),
  );

  const realizedArr = accounts.reduce((s, a) => s + a.arr_usd, 0);
  const closedWon = opps.filter((o) => o.stage === "Closed Won").length;
  const closedLost = opps.filter((o) => o.stage === "Closed Lost").length;
  const openOpps = opps.length - closedWon - closedLost;
  console.log(`Wrote CSVs under ${OUT}`);
  console.log(`Accounts: ${accounts.length}, total arr_usd: ${realizedArr} (target ${TARGET_ARR_USD})`);
  console.log(
    `Contacts: ${contacts.length}, Opportunities: ${opps.length} (${openOpps} open, ${closedWon} won, ${closedLost} lost), Tickets: ${tickets.length}`,
  );
}

main();
