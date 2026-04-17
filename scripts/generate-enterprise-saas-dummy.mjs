#!/usr/bin/env node
/**
 * Enterprise SaaS prototype: logos up for renewal ramp 2025-Q1 (100) → 2026-Q1 (~150) across five Qs.
 * Contract terms 1–5 years (~80% are 3 years). Renewed deals: booked ARR = 1–3× prior ARR (E[×] ≈ 1.6); NRR is emergent.
 * Prior deal year = renewal calendar year − contract_term_years (~80% are 3yr → ~80%/Q are “3 years ago”).
 * Revenue GRR: last_deal_year === 2023 → ~85%; otherwise ~95%.
 * Also writes cx/product_usage.csv (usage_tier per account × fiscal_quarter × product_line),
 * cx/customer_satisfaction.csv (CSAT + NPS at the same grain),
 * merged crm/deal_data.csv (renewals + new ACV + account_vertical), finance/finance_summary.csv,
 * finance/arr_by_account_quarter.csv (ARR run-rate from CRM + renewal cohort),
 * support/support_summary.csv (account × fiscal_quarter ticket metrics), plus deal-data-dashboard.html.
 *
 * Run: node scripts/generate-enterprise-saas-dummy.mjs
 * Or: npm run data:generate
 */

import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_ROOT = join(ROOT, "data");
const OUT = join(DATA_ROOT, "dummy_data");
const LEGACY_OUT = join(DATA_ROOT, "dummy");

/** All renewal periods included in the export. */
const RENEWAL_QUARTERS = ["2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4", "2026-Q1"];
/** Logos up for renewal in first Q (2025-Q1) and last Q (2026-Q1); middle Qs linearly interpolated. */
const LOGOS_UP_FIRST_Q = 100;
const LOGOS_UP_LAST_Q = 150;
const NEW_DEALS_WON_FIRST_Q = 400;
const NEW_DEALS_WON_LAST_Q = 500;
const NEW_ACV_LOGO_SCALE = 0.25;
const NEW_ACV_EXPAND_LOGO_SCALE = 1.0;
const DEAL_SIZE_SCALE = 0.5;
const NEW_ACV_LAND_SHARE = 0.6;
const NEW_ACV_LAND_SHARE_NOISE = 0.08;
const NEW_ACV_DEAL_COUNT_NOISE = 18;

function logosUpByQuarter() {
  const n = RENEWAL_QUARTERS.length;
  if (n < 2) return [LOGOS_UP_FIRST_Q];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.round(LOGOS_UP_FIRST_Q + ((LOGOS_UP_LAST_Q - LOGOS_UP_FIRST_Q) * i) / (n - 1)));
  }
  return out;
}

const LOGOS_UP_BY_QUARTER = logosUpByQuarter();
const NEW_DEALS_WON_BY_QUARTER = (() => {
  const n = RENEWAL_QUARTERS.length;
  if (n < 2) return [NEW_DEALS_WON_FIRST_Q];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(
      Math.round(
        NEW_DEALS_WON_FIRST_Q +
          ((NEW_DEALS_WON_LAST_Q - NEW_DEALS_WON_FIRST_Q) * i) / (n - 1),
      ),
    );
  }
  return out;
})();
const NEW_ACV_TARGETS_BY_QUARTER = NEW_DEALS_WON_BY_QUARTER.map((n) =>
  Math.max(1, Math.round(n * NEW_ACV_LOGO_SCALE)),
);
const CUSTOMER_COUNT = LOGOS_UP_BY_QUARTER.reduce((s, c) => s + c, 0);
/** Revenue GRR when last deal year is not 2023. */
const TARGET_GRR = 0.95;
/** Revenue GRR for 2023 deal cohort (~85% renewal / GRR). */
const GRR_LAST_DEAL_2023 = 0.85;
const RNG_SEED = 42;
/** Renewed row: booked = arr × mult, mult ∈ [MIN, MAX], E[mult] = MEAN (power transform on uniform). */
const RENEWAL_MULT_MIN = 1;
const RENEWAL_MULT_MAX = 3;
const RENEWAL_MULT_MEAN = 1.6;
const RENEWAL_MULT_POWER =
  (RENEWAL_MULT_MAX - RENEWAL_MULT_MIN) / (RENEWAL_MULT_MEAN - RENEWAL_MULT_MIN) - 1;
/** Share of deals with a 3-year term (remainder spread across 1, 2, 4, 5). */
const TERM_THREE_YEAR_SHARE = 0.8;

const REGIONS = ["AMER", "EMEA", "APAC"];
const PRODUCT_LINES = ["Platform", "Security", "Analytics"];
const INDUSTRIES = [
  "Financial Services",
  "Healthcare",
  "Manufacturing",
  "Technology",
  "Retail",
  "Professional Services",
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
const NOUN = ["Labs", "Systems", "Dynamics", "Works", "Logic", "Cloud", "Bridge", "Grid"];

const TERM_NON_THREE = [1, 2, 4, 5];

/** Enterprise SaaS churn — pricing / commercial (2023 cohort assigns ~half from this pool). */
const LOSS_REASONS_PRICING = [
  "Pricing — budget freeze or cuts",
  "Pricing — rejected renewal uplift",
  "Pricing — lower competitive quote",
  "Commercial — payment or term mismatch",
  "Value — ROI / business case not approved",
];

/** Other typical churn drivers (non–2023-only; also second half of 2023 churn). */
const LOSS_REASONS_OTHER = [
  "Competitor — won evaluation",
  "Product — capability or roadmap gap",
  "Stakeholder — champion departed / reorg",
  "Timing — deprioritized / no decision",
  "Risk — security or compliance",
  "Adoption — low usage or failed rollout",
  "Procurement — vendor consolidation",
];

const LOSS_REASONS_ALL = [...LOSS_REASONS_PRICING, ...LOSS_REASONS_OTHER];

function shuffleIndices(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** ~50% pricing for churned rows with last_deal_year === 2023; uniform mix for other churned. */
function assignChurnLossReasons(renewals, rnd) {
  const idx2023Churn = [];
  const idxOtherChurn = [];
  for (let i = 0; i < renewals.length; i++) {
    const r = renewals[i];
    if (r.outcome !== "churned") continue;
    if (r.last_deal_year === 2023) idx2023Churn.push(i);
    else idxOtherChurn.push(i);
  }

  shuffleIndices(idx2023Churn, rnd);
  const half = Math.floor(idx2023Churn.length / 2);
  for (let j = 0; j < idx2023Churn.length; j++) {
    const pool = j < half ? LOSS_REASONS_PRICING : LOSS_REASONS_OTHER;
    renewals[idx2023Churn[j]].loss_reason = pick(pool, rnd);
  }

  for (const i of idxOtherChurn) {
    renewals[i].loss_reason = pick(LOSS_REASONS_ALL, rnd);
  }
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toCsv(rows, headers) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => esc(row[h])).join(","));
  }
  return lines.join("\n") + "\n";
}

/** Skewed enterprise deal sizes (USD). */
function sampleArrUsd(rnd) {
  const u = Math.pow(rnd(), 1.65);
  return Math.max(1000, Math.round(((22_000 + u * 520_000) * DEAL_SIZE_SCALE) / 1000) * 1000);
}

/** New ACV sizes (USD), enterprise-skewed with average close to ~$200k. */
function sampleNewAcvUsd(rnd) {
  const u = Math.pow(rnd(), 2.3);
  return Math.max(1000, Math.round(((25_000 + u * 575_000) * DEAL_SIZE_SCALE) / 1000) * 1000);
}

/** Total contract value from ACV, rounded to nearest $1k (minimum $1k). */
function acvToTcvUsd(acvUsd, contractTermYears) {
  const y = Math.max(1, contractTermYears);
  return Math.max(1000, Math.round((acvUsd * y) / 1000) * 1000);
}

function pick(arr, rnd) {
  return arr[Math.floor(rnd() * arr.length)];
}

function sampleContractTermYears(rnd) {
  return rnd() < TERM_THREE_YEAR_SHARE
    ? 3
    : TERM_NON_THREE[Math.floor(rnd() * TERM_NON_THREE.length)];
}

/**
 * Calendar year of the prior deal that this renewal supersedes:
 * renewal fiscal year minus term length (e.g. 2025-Q* + 3yr term → 2022).
 */
function priorDealYear(renewalQuarter, contractTermYears) {
  const m = String(renewalQuarter).match(/^(\d{4})-Q[1-4]$/);
  if (!m) return 2022;
  return parseInt(m[1], 10) - contractTermYears;
}

function shiftQuarterByYears(quarter, yearsBack) {
  const m = String(quarter).match(/^(\d{4})-(Q[1-4])$/);
  if (!m) return null;
  return `${parseInt(m[1], 10) - yearsBack}-${m[2]}`;
}

function sampleCloseDateInQuarter(quarter, rnd) {
  const m = String(quarter).match(/^(\d{4})-Q([1-4])$/);
  if (!m) return "2025-01-15";
  const year = parseInt(m[1], 10);
  const qn = parseInt(m[2], 10);
  const monthStart = (qn - 1) * 3;
  const monthOffset = Math.floor(rnd() * 3);
  const month = monthStart + monthOffset + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const day = 1 + Math.floor(rnd() * daysInMonth);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function maxAccountIndex(rows) {
  let max = 0;
  for (const r of rows) {
    const m = String(r.account_id || "").match(/^A(\d+)$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

function weightedPick(items, rnd, weightFn) {
  if (!items.length) return null;
  const weights = items.map((x) => Math.max(0, weightFn(x)));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return items[Math.floor(rnd() * items.length)];
  let u = rnd() * total;
  for (let i = 0; i < items.length; i++) {
    u -= weights[i];
    if (u <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** Same pattern as CRM accounts: `A` + zero-padded index (new logos continue after existing customers). */
function accountIdAtIndex(oneBasedIndex, idPad) {
  return `A${String(oneBasedIndex).padStart(idPad, "0")}`;
}

function noisyDealTarget(baseTarget, rnd) {
  let target = baseTarget + Math.round((rnd() * 2 - 1) * NEW_ACV_DEAL_COUNT_NOISE);
  if (target % 25 === 0) {
    target += rnd() < 0.5 ? -1 : 1;
  } else if (target % 10 === 0) {
    target += rnd() < 0.5 ? -1 : 1;
  }
  return Math.max(1, target);
}

function noisyLandShare(rnd) {
  return Math.max(
    0.45,
    Math.min(0.75, NEW_ACV_LAND_SHARE + (rnd() * 2 - 1) * NEW_ACV_LAND_SHARE_NOISE),
  );
}

function buildWonNewDeals(allRenewals, rnd, customerCount, idPad) {
  const wonNewDeals = [];
  let seq = 1;
  let inferredExpandCount = 0;

  const byAccount = new Map();
  for (const r of allRenewals) {
    if (!byAccount.has(r.account_id)) {
      byAccount.set(r.account_id, {
        account_id: r.account_id,
        account_name: r.account_name,
        region: r.region,
        contract_term_years: r.contract_term_years,
      });
    }
  }
  const existingProfiles = Array.from(byAccount.values());
  const inferredExpandByQuarter = new Map(
    RENEWAL_QUARTERS.map((q) => [q, []]),
  );

  for (const r of allRenewals) {
    if (r.outcome !== "renewed") continue;
    const startQuarter = shiftQuarterByYears(
      r.renewal_fiscal_quarter,
      r.contract_term_years,
    );
    if (!startQuarter || !RENEWAL_QUARTERS.includes(startQuarter)) continue;
    const acv = sampleNewAcvUsd(rnd);
    inferredExpandByQuarter.get(startQuarter).push({
      account_id: r.account_id,
      account_name: r.account_name,
      fiscal_quarter: startQuarter,
      region: r.region,
      contract_term_years: r.contract_term_years,
      acv_usd: acv,
      tcv_usd: acvToTcvUsd(acv, r.contract_term_years),
      new_acv_motion: "expand",
    });
  }

  let landCount = 0;
  let expandCount = 0;
  for (let qi = 0; qi < RENEWAL_QUARTERS.length; qi++) {
    const q = RENEWAL_QUARTERS[qi];
    const target = noisyDealTarget(NEW_ACV_TARGETS_BY_QUARTER[qi], rnd);
    const landShare = noisyLandShare(rnd);
    let landTarget = Math.round(target * landShare);
    if (target > 1 && landTarget * 5 === target * 3) {
      landTarget += rnd() < 0.5 ? -1 : 1;
    }
    landTarget = Math.max(0, Math.min(target, landTarget));
    const expandTarget = Math.max(
      0,
      Math.round((target - landTarget) * NEW_ACV_EXPAND_LOGO_SCALE),
    );

    const inferred = inferredExpandByQuarter.get(q) || [];
    const useInferred = inferred.slice(0, expandTarget);
    inferredExpandCount += useInferred.length;
    wonNewDeals.push(...useInferred);
    expandCount += useInferred.length;

    const remainingExpand = expandTarget - useInferred.length;
    for (let j = 0; j < remainingExpand; j++) {
      const profile = pick(existingProfiles, rnd);
      const term = profile.contract_term_years;
      const acv = sampleNewAcvUsd(rnd);
      wonNewDeals.push({
        account_id: profile.account_id,
        account_name: profile.account_name,
        fiscal_quarter: q,
        region: profile.region,
        contract_term_years: term,
        acv_usd: acv,
        tcv_usd: acvToTcvUsd(acv, term),
        new_acv_motion: "expand",
      });
      expandCount += 1;
    }

    for (let j = 0; j < landTarget; j++) {
      const id = accountIdAtIndex(customerCount + seq, idPad);
      seq += 1;
      const term = sampleContractTermYears(rnd);
      const acv = sampleNewAcvUsd(rnd);
      wonNewDeals.push({
        account_id: id,
        account_name: `${pick(ADJ, rnd)} ${pick(NOUN, rnd)}${rnd() < 0.45 ? " Inc" : ""}`,
        fiscal_quarter: q,
        region: pick(REGIONS, rnd),
        contract_term_years: term,
        acv_usd: acv,
        tcv_usd: acvToTcvUsd(acv, term),
        new_acv_motion: "land",
      });
      landCount += 1;
    }
  }

  const avgAcvUsd =
    wonNewDeals.length > 0
      ? Math.round(
          wonNewDeals.reduce((s, d) => s + d.acv_usd, 0) / wonNewDeals.length,
        )
      : 0;

  wonNewDeals.sort(
    (a, b) =>
      RENEWAL_QUARTERS.indexOf(a.fiscal_quarter) -
      RENEWAL_QUARTERS.indexOf(b.fiscal_quarter),
  );

  return {
    wonNewDeals,
    avgAcvUsd,
    inferredExpandCount,
    landCount,
    expandCount,
  };
}

function buildUnifiedBookingsRows(allRenewals, wonNewDeals, accountsRows, rnd, idPad) {
  const accountsById = new Map(accountsRows.map((a) => [a.account_id, a]));
  const renewalRowsFull = allRenewals.map((r) => ({
    account_id: r.account_id,
    account_name: r.account_name,
    fiscal_quarter: r.renewal_fiscal_quarter,
    close_date: sampleCloseDateInQuarter(r.renewal_fiscal_quarter, rnd),
    region: r.region,
    account_vertical: accountsById.get(r.account_id)?.industry || "Technology",
    product_line: pick(PRODUCT_LINES, rnd),
    deal_type: "renew",
    outcome: r.outcome === "renewed" ? "won" : "lost",
    contract_term_years: r.contract_term_years,
    acv_usd:
      r.outcome === "renewed" ? r.booked_arr_usd || 0 : r.arr_up_for_renewal_usd || 0,
    tcv_usd:
      (r.outcome === "renewed" ? r.booked_arr_usd || 0 : r.arr_up_for_renewal_usd || 0) *
      Math.max(1, r.contract_term_years),
  }));

  const renewalRows = [];
  for (const q of RENEWAL_QUARTERS) {
    const inQuarter = renewalRowsFull.filter((r) => r.fiscal_quarter === q);
    const pickCount = Math.max(1, Math.floor(inQuarter.length * 0.5));
    for (let i = inQuarter.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [inQuarter[i], inQuarter[j]] = [inQuarter[j], inQuarter[i]];
    }
    renewalRows.push(...inQuarter.slice(0, pickCount));
  }

  const newAcvRows = wonNewDeals.map((d) => ({
    account_id: d.account_id,
    account_name: d.account_name,
    fiscal_quarter: d.fiscal_quarter,
    close_date: sampleCloseDateInQuarter(d.fiscal_quarter, rnd),
    region: d.region,
    account_vertical: accountsById.get(d.account_id)?.industry || "Technology",
    product_line: pick(PRODUCT_LINES, rnd),
    deal_type: d.new_acv_motion === "land" ? "land" : "expand",
    outcome: "won",
    contract_term_years: d.contract_term_years,
    acv_usd: d.acv_usd || 0,
    tcv_usd: d.tcv_usd || acvToTcvUsd(d.acv_usd || 0, d.contract_term_years),
  }));

  let nextAccountIdx = maxAccountIndex(accountsRows) + 1;
  const heavyIndustries = new Set(["Professional Services", "Retail", "Manufacturing"]);
  const heavyQuarters = new Set(["2025-Q4", "2026-Q1"]);

  const winRateFor = (dealType, quarter) => {
    const heavyQ = heavyQuarters.has(quarter);
    if (dealType === "land") return heavyQ ? 0.2 : 0.3;
    if (dealType === "expand") return heavyQ ? 0.4 : 0.6;
    return 0.9;
  };

  const buildLostLandAccount = (quarter) => {
    const heavyQ = heavyQuarters.has(quarter);
    const region =
      heavyQ
        ? weightedPick(REGIONS, rnd, (r) => (r === "EMEA" ? 5 : 1))
        : pick(REGIONS, rnd);
    const nonHeavyIndustries = INDUSTRIES.filter((x) => !heavyIndustries.has(x));
    const industry =
      heavyQ
        ? rnd() < 0.75
          ? pick(Array.from(heavyIndustries), rnd)
          : pick(nonHeavyIndustries, rnd)
        : pick(INDUSTRIES, rnd);
    const account_id = accountIdAtIndex(nextAccountIdx, idPad);
    nextAccountIdx += 1;
    const account_name = `${pick(ADJ, rnd)} ${pick(NOUN, rnd)}${rnd() < 0.45 ? " Inc" : ""}`;
    const contract_term_years = sampleContractTermYears(rnd);
    const row = {
      account_id,
      account_name,
      region,
      industry,
      contract_term_years,
      last_deal_year: priorDealYear(quarter, contract_term_years),
      renewal_fiscal_quarter: "",
      arr_usd_current: 0,
    };
    accountsRows.push(row);
    accountsById.set(account_id, row);
    return row;
  };

  const buildLostExpandAccount = (quarter) => {
    const heavyQ = heavyQuarters.has(quarter);
    const candidates = accountsRows;
    return weightedPick(candidates, rnd, (a) => {
      if (!heavyQ) return 1;
      let w = 1;
      if (a.region === "EMEA") w += 2;
      if (heavyIndustries.has(a.industry)) w += 2;
      return w;
    });
  };

  const lostNewAcvRows = [];
  for (const q of RENEWAL_QUARTERS) {
    for (const dealType of ["land", "expand"]) {
      const wonRows = newAcvRows.filter(
        (d) =>
          d.fiscal_quarter === q && d.deal_type === dealType && d.outcome === "won",
      );
      const wonCount = wonRows.length;
      const winRate = winRateFor(dealType, q);
      const totalTarget = Math.max(wonCount, Math.round(wonCount / winRate));
      const lostNeeded = Math.max(0, totalTarget - wonCount);
      for (let i = 0; i < lostNeeded; i++) {
        const base = wonRows.length ? wonRows[Math.floor(rnd() * wonRows.length)] : null;
        const term = base?.contract_term_years || sampleContractTermYears(rnd);
        const acv = base?.acv_usd || sampleNewAcvUsd(rnd);
        if (dealType === "land") {
          const a = buildLostLandAccount(q);
          lostNewAcvRows.push({
            account_id: a.account_id,
            account_name: a.account_name,
            fiscal_quarter: q,
            close_date: sampleCloseDateInQuarter(q, rnd),
            region: a.region,
            account_vertical: a.industry || "Technology",
            product_line: pick(PRODUCT_LINES, rnd),
            deal_type: "land",
            outcome: "lost",
            contract_term_years: term,
            acv_usd: acv,
            tcv_usd: acvToTcvUsd(acv, term),
          });
        } else {
          const a = buildLostExpandAccount(q) || buildLostLandAccount(q);
          lostNewAcvRows.push({
            account_id: a.account_id,
            account_name: a.account_name,
            fiscal_quarter: q,
            close_date: sampleCloseDateInQuarter(q, rnd),
            region: a.region,
            account_vertical: a.industry || "Technology",
            product_line: pick(PRODUCT_LINES, rnd),
            deal_type: "expand",
            outcome: "lost",
            contract_term_years: a.contract_term_years || term,
            acv_usd: acv,
            tcv_usd: acvToTcvUsd(acv, a.contract_term_years || term),
          });
        }
      }
    }
  }

  return [...renewalRows, ...newAcvRows, ...lostNewAcvRows].sort(
    (a, b) =>
      RENEWAL_QUARTERS.indexOf(a.fiscal_quarter) -
      RENEWAL_QUARTERS.indexOf(b.fiscal_quarter),
  );
}

function buildFinanceSummaryRows(dealRows, accountsRows) {
  const cogsRateByProduct = {
    Platform: 0.22,
    Security: 0.28,
    Analytics: 0.25,
  };
  const byQ = Object.fromEntries(
    RENEWAL_QUARTERS.map((q) => [
      q,
      {
        fiscal_quarter: q,
        won_deals: 0,
        lost_deals: 0,
        won_deal_acv_usd: 0,
        lost_deal_acv_usd: 0,
        billings_tcv_usd: 0,
        recognized_revenue_usd: 0,
        cogs_usd: 0,
        gross_profit_usd: 0,
        sales_marketing_opex_usd: 0,
        rnd_opex_usd: 0,
        gna_opex_usd: 0,
        ebitda_usd: 0,
        active_accounts: 0,
        account_base_count: accountsRows.length,
      },
    ]),
  );

  for (const d of dealRows) {
    const q = byQ[d.fiscal_quarter];
    if (!q) continue;
    const acv = d.acv_usd || 0;
    const tcv = d.tcv_usd || acv * Math.max(1, d.contract_term_years || 1);
    if (d.outcome === "won") {
      q.won_deals += 1;
      q.won_deal_acv_usd += acv;
      q.billings_tcv_usd += tcv;
    } else if (d.outcome === "lost") {
      q.lost_deals += 1;
      q.lost_deal_acv_usd += acv;
    }
  }

  for (const d of dealRows) {
    if (d.outcome !== "won") continue;
    const start = RENEWAL_QUARTERS.indexOf(d.fiscal_quarter);
    if (start < 0) continue;
    const durationQ = Math.max(1, (d.contract_term_years || 1) * 4);
    const revPerQuarter = (d.acv_usd || 0) / 4;
    const cogsRate = cogsRateByProduct[d.product_line] || 0.25;
    for (let qi = start; qi < Math.min(RENEWAL_QUARTERS.length, start + durationQ); qi++) {
      const b = byQ[RENEWAL_QUARTERS[qi]];
      b.recognized_revenue_usd += revPerQuarter;
      b.cogs_usd += revPerQuarter * cogsRate;
    }
  }

  const activeWonAccounts = new Set();
  const wonByQuarter = Object.fromEntries(RENEWAL_QUARTERS.map((q) => [q, []]));
  for (const d of dealRows) {
    if (d.outcome === "won" && wonByQuarter[d.fiscal_quarter]) {
      wonByQuarter[d.fiscal_quarter].push(d);
    }
  }
  for (const q of RENEWAL_QUARTERS) {
    for (const d of wonByQuarter[q]) {
      activeWonAccounts.add(d.account_id);
    }
    byQ[q].active_accounts = activeWonAccounts.size;
  }

  for (const q of RENEWAL_QUARTERS) {
    const b = byQ[q];
    b.gross_profit_usd = b.recognized_revenue_usd - b.cogs_usd;
    b.sales_marketing_opex_usd = 2_200_000 + b.won_deals * 9_000 + b.lost_deals * 4_500;
    b.rnd_opex_usd = 1_400_000 + b.active_accounts * 350;
    b.gna_opex_usd = 700_000 + b.account_base_count * 120;
    b.ebitda_usd =
      b.gross_profit_usd -
      b.sales_marketing_opex_usd -
      b.rnd_opex_usd -
      b.gna_opex_usd;
  }

  return RENEWAL_QUARTERS.map((q) => {
    const b = byQ[q];
    const intFields = [
      "won_deals",
      "lost_deals",
      "won_deal_acv_usd",
      "lost_deal_acv_usd",
      "billings_tcv_usd",
      "recognized_revenue_usd",
      "cogs_usd",
      "gross_profit_usd",
      "sales_marketing_opex_usd",
      "rnd_opex_usd",
      "gna_opex_usd",
      "ebitda_usd",
      "active_accounts",
      "account_base_count",
    ];
    const row = { ...b };
    for (const f of intFields) row[f] = Math.round(row[f]);
    return row;
  });
}

/**
 * End-of-quarter ARR run-rate per account from CRM: baseline `arr_up_for_renewal_usd` before renewal,
 * plus cumulative won land/expand ACV from deal_data; at renewal quarter `booked_arr_usd` if renewed
 * else 0; after renewal, further won expand/land ACV adds on.
 * @param {Array<{account_id: string, fiscal_quarter: string, deal_type: string, outcome: string, acv_usd: number}>} dealRows
 * @param {Array<{account_id: string, renewal_fiscal_quarter: string}>} accounts
 * @param {Map<string, {outcome: string, arr_up_for_renewal_usd: number, booked_arr_usd: number}>} byAccountRenewal
 */
function buildAccountArrByQuarterRows(dealRows, accounts, byAccountRenewal) {
  const elByAccountQ = new Map();
  for (const d of dealRows) {
    if (d.outcome !== "won") continue;
    if (d.deal_type !== "expand" && d.deal_type !== "land") continue;
    const fq = d.fiscal_quarter;
    if (!RENEWAL_QUARTERS.includes(fq)) continue;
    const k = `${d.account_id}|${fq}`;
    elByAccountQ.set(k, (elByAccountQ.get(k) || 0) + (d.acv_usd || 0));
  }

  const rows = [];
  for (const a of accounts) {
    if (!String(a.renewal_fiscal_quarter || "").trim()) continue;
    const r = byAccountRenewal.get(a.account_id);
    if (!r) continue;
    const renewed = r.outcome === "renewed";
    const churned = r.outcome === "churned";
    const ir = RENEWAL_QUARTERS.indexOf(a.renewal_fiscal_quarter);
    if (ir < 0) continue;
    const baseArr = Math.round(r.arr_up_for_renewal_usd || 0);

    let cumEl = 0;
    let postRenew = 0;

    for (let qi = 0; qi < RENEWAL_QUARTERS.length; qi++) {
      const q = RENEWAL_QUARTERS[qi];
      if (!isActiveInQuarter(a.renewal_fiscal_quarter, q, renewed)) continue;

      const elAdd = elByAccountQ.get(`${a.account_id}|${q}`) || 0;
      let arrUsd;

      if (qi < ir) {
        cumEl += elAdd;
        arrUsd = baseArr + cumEl;
      } else if (qi === ir) {
        cumEl += elAdd;
        if (churned) {
          arrUsd = 0;
          postRenew = 0;
        } else {
          arrUsd = Math.round(r.booked_arr_usd || 0) + elAdd;
          postRenew = arrUsd;
        }
      } else {
        postRenew += elAdd;
        arrUsd = postRenew;
      }

      rows.push({
        account_id: a.account_id,
        fiscal_quarter: q,
        arr_usd: Math.round(arrUsd),
      });
    }
  }
  return rows.sort(
    (x, y) =>
      x.account_id.localeCompare(y.account_id) ||
      RENEWAL_QUARTERS.indexOf(x.fiscal_quarter) - RENEWAL_QUARTERS.indexOf(y.fiscal_quarter),
  );
}

/**
 * Account × fiscal_quarter support metrics (same active window as CX usage).
 * @param {Array<{account_id: string, renewal_fiscal_quarter: string}>} accounts
 * @param {Map<string, {outcome: string, arr_up_for_renewal_usd: number, booked_arr_usd: number}>} byAccountRenewal
 */
function buildSupportSummaryRows(accounts, byAccountRenewal, rnd) {
  const rows = [];
  for (const a of accounts) {
    if (!String(a.renewal_fiscal_quarter || "").trim()) continue;
    const r = byAccountRenewal.get(a.account_id);
    if (!r) continue;
    const renewed = r.outcome === "renewed";
    const churned = r.outcome === "churned";
    const ir = RENEWAL_QUARTERS.indexOf(a.renewal_fiscal_quarter);
    const arrScale = Math.min(2.2, Math.max(0.35, (r.arr_up_for_renewal_usd || 50_000) / 180_000));

    for (let qi = 0; qi < RENEWAL_QUARTERS.length; qi++) {
      const q = RENEWAL_QUARTERS[qi];
      if (!isActiveInQuarter(a.renewal_fiscal_quarter, q, renewed)) continue;

      const lateQ = q === "2025-Q4" || q === "2026-Q1";
      const renewalPressure = ir >= 0 ? Math.max(0, qi - Math.max(0, ir - 2)) * 0.35 : 0;
      const churnSpike = churned && ir >= 0 && qi >= ir ? 2.2 + rnd() * 4 : 0;
      const baseTickets = 0.8 + rnd() * 4.5 + renewalPressure + churnSpike;
      const ticket_count = Math.max(0, Math.round(baseTickets * arrScale * (lateQ ? 1.12 : 1)));

      const noiseDays = (rnd() * 2 - 1) * 1.1;
      const avg_days_to_resolution = Math.max(
        1.0,
        Math.round(
          (3.8 + (lateQ ? 2.4 : 0) + (churned && qi >= ir ? 2.8 : 0) + ticket_count * 0.09 + noiseDays) * 10,
        ) / 10,
      );

      rows.push({
        account_id: a.account_id,
        fiscal_quarter: q,
        ticket_count,
        avg_days_to_resolution,
      });
    }
  }
  return rows;
}

function listFilesRecursive(dir, baseDir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFilesRecursive(full, baseDir));
      continue;
    }
    out.push({
      path: full.slice(baseDir.length + 1).replace(/\\/g, "/"),
      bytes: st.size,
    });
  }
  return out;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatUsd(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function formatPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

/** Sample renewal multiplier: support [MIN, MAX], mean MEAN (before $1k rounding). */
function sampleRenewalMultiplier(rnd) {
  const span = RENEWAL_MULT_MAX - RENEWAL_MULT_MIN;
  const u = rnd();
  return RENEWAL_MULT_MIN + span * Math.pow(u, RENEWAL_MULT_POWER);
}

/**
 * Pick churned cohort indices so churned ARR ≈ churnDollarTarget (subset sum closest to target).
 * @param {number[]} segmentIndices — indices into `cohort`
 */
function pickChurnIndicesForSegment(cohort, segmentIndices, churnDollarTarget, rnd) {
  const m = segmentIndices.length;
  const out = /** @type {Set<number>} */ (new Set());
  if (m === 0 || churnDollarTarget <= 0) return out;

  let best = /** @type {Set<number>} */ (new Set());
  let bestDiff = Infinity;
  const attempts = Math.max(20_000, m * 400);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const k = Math.min(m, Math.max(1, 1 + Math.floor(rnd() * m)));
    const chosen = new Set();
    while (chosen.size < k) {
      chosen.add(segmentIndices[Math.floor(rnd() * m)]);
    }
    let sum = 0;
    for (const i of chosen) {
      sum += cohort[i].arr_up_for_renewal_usd;
    }
    const diff = Math.abs(sum - churnDollarTarget);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = new Set(chosen);
    }
  }
  return best;
}

/**
 * Simulate one renewal cohort (GRR targets; NRR emerges from per-deal renewal multipliers).
 * @param {Array<{account_id: string, account_name: string, region: string, industry: string, contract_term_years: number, last_deal_year: number, arr_up_for_renewal_usd: number, renewal_fiscal_quarter: string}>} cohort
 */
function simulateRenewalCohort(cohort, rnd) {
  const n = cohort.length;
  if (n === 0) return [];

  const idx2023 = cohort.map((_, i) => i).filter((i) => cohort[i].last_deal_year === 2023);
  const idxOther = cohort.map((_, i) => i).filter((i) => cohort[i].last_deal_year !== 2023);

  const sumArr2023 = idx2023.reduce((s, i) => s + cohort[i].arr_up_for_renewal_usd, 0);
  const sumArrOther = idxOther.reduce((s, i) => s + cohort[i].arr_up_for_renewal_usd, 0);
  const target2023 = sumArr2023 * (1 - GRR_LAST_DEAL_2023);
  const targetOther = sumArrOther * (1 - TARGET_GRR);

  const churn2023 = pickChurnIndicesForSegment(cohort, idx2023, target2023, rnd);
  const churnOther = pickChurnIndicesForSegment(cohort, idxOther, targetOther, rnd);
  const churnSet = new Set([...churn2023, ...churnOther]);

  const renewals = [];
  for (let i = 0; i < n; i++) {
    const a = cohort[i];
    const churned = churnSet.has(i);

    let booked_arr_usd = 0;
    let renewal_motion = "";
    let outcome = "";

    if (churned) {
      outcome = "churned";
      renewal_motion = "";
    } else {
      outcome = "renewed";
      const base = a.arr_up_for_renewal_usd;
      const mult = sampleRenewalMultiplier(rnd);
      let b = Math.round((base * mult) / 1000) * 1000;
      b = Math.max(base, Math.min(3 * base, b));
      booked_arr_usd = b;
      const ratio = booked_arr_usd / base;
      renewal_motion = ratio >= 1.02 ? "expansion" : "flat";
    }

    renewals.push({
      account_id: a.account_id,
      account_name: a.account_name,
      renewal_fiscal_quarter: a.renewal_fiscal_quarter,
      region: a.region,
      contract_term_years: a.contract_term_years,
      last_deal_year: a.last_deal_year,
      arr_up_for_renewal_usd: a.arr_up_for_renewal_usd,
      outcome,
      loss_reason: "",
      booked_arr_usd,
      renewal_motion,
    });
  }

  return renewals;
}

const USAGE_TIERS = ["no_usage", "minimal_usage", "high_usage", "power_usage"];

/** Cumulative weights for USAGE_TIERS (no, minimal, high, power). */
function sampleUsageTier(rnd, opts = {}) {
  const { churned, quartersUntilRenewal } = opts;
  let wNo = 0.1;
  let wMin = 0.34;
  let wHigh = 0.42;
  let wPow = 0.14;
  if (churned && quartersUntilRenewal != null && quartersUntilRenewal <= 1) {
    wNo = 0.28;
    wMin = 0.45;
    wHigh = 0.22;
    wPow = 0.05;
  } else if (churned && quartersUntilRenewal === 2) {
    wNo = 0.18;
    wMin = 0.4;
    wHigh = 0.32;
    wPow = 0.1;
  }
  const u = rnd() * (wNo + wMin + wHigh + wPow);
  if (u < wNo) return USAGE_TIERS[0];
  if (u < wNo + wMin) return USAGE_TIERS[1];
  if (u < wNo + wMin + wHigh) return USAGE_TIERS[2];
  return USAGE_TIERS[3];
}

/** Map usage tier to base CSAT 1–5 mean (ordinal). */
function tierCsatMean(tier) {
  if (tier === "no_usage") return 2.4;
  if (tier === "minimal_usage") return 3.2;
  if (tier === "high_usage") return 3.9;
  return 4.35;
}

/** Integer CSAT 1–5 with noise; clamped. */
function sampleCsat(rnd, tier) {
  const m = tierCsatMean(tier);
  const x = m + (rnd() - 0.5) * 1.35 + (rnd() - 0.5) * 0.6;
  return Math.max(1, Math.min(5, Math.round(x)));
}

/** NPS-style −100..100 from CSAT and noise. */
function sampleNps(rnd, csat) {
  const base = (csat - 3) * 35 + (rnd() - 0.5) * 45;
  return Math.max(-100, Math.min(100, Math.round(base)));
}

/** Subscription still open in `quarter` given renewal quarter and outcome. */
function isActiveInQuarter(renewalQuarter, quarter, renewed) {
  const iq = RENEWAL_QUARTERS.indexOf(quarter);
  const ir = RENEWAL_QUARTERS.indexOf(renewalQuarter);
  if (iq === -1 || ir === -1) return false;
  if (iq < ir) return true;
  if (iq === ir) return true;
  return renewed;
}

function quarterSummary(rows) {
  const totalUp = rows.reduce((s, r) => s + r.arr_up_for_renewal_usd, 0);
  const churnedUp = rows
    .filter((r) => r.outcome === "churned")
    .reduce((s, r) => s + r.arr_up_for_renewal_usd, 0);
  const totalBooked = rows.reduce((s, r) => s + r.booked_arr_usd, 0);
  const grr = totalUp > 0 ? 1 - churnedUp / totalUp : 0;
  const nrr = totalUp > 0 ? totalBooked / totalUp : 0;
  return { totalUp, totalBooked, grr, nrr, logos: rows.length };
}

/** Revenue GRR among rows with last_deal_year === 2023 (logo renewal rate in .logoRenewPct). */
function cohort2023Metrics(rows) {
  const sub = rows.filter((r) => r.last_deal_year === 2023);
  if (!sub.length) return null;
  const totalUp = sub.reduce((s, r) => s + r.arr_up_for_renewal_usd, 0);
  const churnedUp = sub
    .filter((r) => r.outcome === "churned")
    .reduce((s, r) => s + r.arr_up_for_renewal_usd, 0);
  const renewedLogos = sub.filter((r) => r.outcome === "renewed").length;
  const grr = totalUp > 0 ? 1 - churnedUp / totalUp : 0;
  return { n: sub.length, grr, logoRenewPct: renewedLogos / sub.length, totalUp };
}

/** Local-only preview (open in a browser). Not part of the Next.js app. */
function writeRenewalsDashboardHtml(allRenewals, outPath) {
  const byQ = {};
  for (const q of RENEWAL_QUARTERS) {
    byQ[q] = [];
  }
  for (const r of allRenewals) {
    if (byQ[r.renewal_fiscal_quarter]) byQ[r.renewal_fiscal_quarter].push(r);
  }

  const rollup = quarterSummary(allRenewals);
  const rollup2023 = cohort2023Metrics(allRenewals);
  const maxBar = Math.max(rollup.totalUp, rollup.totalBooked, 1);
  const upPct = (rollup.totalUp / maxBar) * 100;
  const bookedPct = (rollup.totalBooked / maxBar) * 100;

  const summaryRowsHtml = RENEWAL_QUARTERS.map((q) => {
    const rows = byQ[q];
    const s = quarterSummary(rows);
    const m23 = cohort2023Metrics(rows);
    const c23 =
      m23 != null
        ? `<td class="num">${m23.n}</td><td class="num">${escapeHtml(formatPct(m23.grr))}</td>`
        : `<td class="num">—</td><td class="num">—</td>`;
    return `<tr>
      <td><strong>${escapeHtml(q)}</strong></td>
      <td class="num">${rows.length}</td>
      ${c23}
      <td class="num">${escapeHtml(formatUsd(s.totalUp))}</td>
      <td class="num">${escapeHtml(formatUsd(s.totalBooked))}</td>
      <td class="num">${escapeHtml(formatPct(s.grr))}</td>
      <td class="num">${escapeHtml(formatPct(s.nrr))}</td>
    </tr>`;
  }).join("\n");

  let maxAcrossQuarters = 1;
  for (const q of RENEWAL_QUARTERS) {
    const s = quarterSummary(byQ[q]);
    maxAcrossQuarters = Math.max(maxAcrossQuarters, s.totalUp, s.totalBooked);
  }

  const quarterTilesHtml = RENEWAL_QUARTERS.map((q) => {
    const rows = byQ[q];
    const s = quarterSummary(rows);
    const m23 = cohort2023Metrics(rows);
    const line23 =
      m23 != null
        ? ` · 2023 deals: ${m23.n} logos, rev. GRR ${escapeHtml(formatPct(m23.grr))}`
        : "";
    const upW = (s.totalUp / maxAcrossQuarters) * 100;
    const bkW = (s.totalBooked / maxAcrossQuarters) * 100;
    return `<div class="q-tile" id="tile-${escapeHtml(q)}">
      <h3 class="q-tile-title">${escapeHtml(q)}</h3>
      <p class="q-tile-meta">${rows.length} logos · GRR ${escapeHtml(formatPct(s.grr))} · NRR ${escapeHtml(formatPct(s.nrr))}${line23}</p>
      <p class="q-tile-amounts"><span class="q-amt-label">Up</span> ${escapeHtml(formatUsd(s.totalUp))}</p>
      <div class="track q-track"><div class="fill fill-muted" style="width:${Math.min(100, upW)}%"></div></div>
      <p class="q-tile-amounts"><span class="q-amt-label">Booked</span> ${escapeHtml(formatUsd(s.totalBooked))}</p>
      <div class="track q-track"><div class="fill fill-accent" style="width:${Math.min(100, bkW)}%"></div></div>
    </div>`;
  }).join("\n");

  const sorted = [...allRenewals].sort((a, b) => {
    const qi = RENEWAL_QUARTERS.indexOf(a.renewal_fiscal_quarter) - RENEWAL_QUARTERS.indexOf(b.renewal_fiscal_quarter);
    if (qi !== 0) return qi;
    return b.arr_up_for_renewal_usd - a.arr_up_for_renewal_usd;
  });

  function detailRowsForQuarter(q) {
    const quarterRows = sorted.filter((r) => r.renewal_fiscal_quarter === q);
    return quarterRows
      .map((r) => {
        const bookedCell =
          r.outcome === "churned" ? "—" : escapeHtml(formatUsd(r.booked_arr_usd));
        const outcomeHtml =
          r.outcome === "churned"
            ? '<span class="pill pill-churn">Churned</span>'
            : `<span class="pill pill-renew">Renewed</span><span class="pill-sub">${
                r.renewal_motion === "expansion" ? "Expansion" : "Flat"
              }</span>`;
        return `<tr>
        <td><span class="acct">${escapeHtml(r.account_name)}</span><span class="mono">${escapeHtml(r.account_id)}</span></td>
        <td class="num">${r.last_deal_year}</td>
        <td class="num">${r.contract_term_years}</td>
        <td class="muted">${escapeHtml(r.region)}</td>
        <td class="num">${escapeHtml(formatUsd(r.arr_up_for_renewal_usd))}</td>
        <td class="num strong">${bookedCell}</td>
        <td>${outcomeHtml}</td>
        <td class="muted loss-reason">${r.outcome === "churned" ? escapeHtml(r.loss_reason) : "—"}</td>
      </tr>`;
      })
      .join("\n");
  }

  const detailByQuarterHtml = RENEWAL_QUARTERS.map((q) => {
    const body = detailRowsForQuarter(q);
    return `<div class="q-detail-block" id="detail-${escapeHtml(q)}">
      <h3 class="q-detail-heading"><a href="#tile-${escapeHtml(q)}" class="q-anchor">${escapeHtml(q)}</a></h3>
      <div style="overflow-x:auto">
        <table>
          <thead><tr>
            <th>Account</th><th class="num">Last deal</th><th class="num">Term (yr)</th><th>Region</th><th class="num">Up for renewal</th><th class="num">Booked</th><th>Outcome</th><th>Loss reason</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Renewals 2025 &amp; Q1'26 (local preview)</title>
  <style>
    :root { --muted: #71717a; --border: #e4e4e7; --surface: #f8fafc; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: var(--surface); color: #18181b; }
    .wrap { max-width: 64rem; margin: 0 auto; padding: 2.5rem 1rem; }
    .eyebrow { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); }
    h1 { font-size: 1.5rem; font-weight: 600; margin: 0.25rem 0 0; }
    .sub { font-size: 0.875rem; color: var(--muted); margin: 0.35rem 0 0; }
    .note { font-size: 0.75rem; color: var(--muted); margin: 1.5rem 0 0; padding: 0.75rem 1rem; background: #fffbeb; border: 1px solid #fde68a; border-radius: 0.5rem; }
    .kpis { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); margin-top: 2rem; }
    .kpi { border: 1px solid var(--border); border-radius: 0.75rem; padding: 0.75rem 1rem; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 0.04); }
    .kpi.accent { border-color: #a7f3d0; background: #ecfdf5; }
    .kpi .lbl { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
    .kpi .val { font-size: 1.125rem; font-weight: 600; margin-top: 0.25rem; font-variant-numeric: tabular-nums; }
    .kpi.accent .val { color: #065f46; }
    .kpi .hint { font-size: 0.75rem; color: var(--muted); margin-top: 0.125rem; }
    .card { margin-top: 2rem; border: 1px solid var(--border); border-radius: 0.75rem; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 0.04); overflow: hidden; }
    .card.pad { padding: 1.25rem 1.5rem; }
    .card h2 { font-size: 0.875rem; font-weight: 600; margin: 0; }
    .card .cap { font-size: 0.75rem; color: var(--muted); margin: 0.25rem 0 0; }
    .bar-block { margin-top: 1rem; }
    .bar-row { display: flex; justify-content: space-between; font-size: 0.875rem; margin-bottom: 0.25rem; }
    .track { height: 0.75rem; border-radius: 9999px; background: #f4f4f5; overflow: hidden; }
    .fill { height: 100%; border-radius: 9999px; }
    .fill-muted { background: #a1a1aa; }
    .fill-accent { background: #059669; }
    .thead { padding: 0.75rem 1rem; background: rgb(244 244 245 / 0.8); border-bottom: 1px solid #f4f4f5; }
    table { width: 100%; font-size: 0.875rem; border-collapse: collapse; }
    th { text-align: left; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 500; padding: 0.5rem 1rem; border-bottom: 1px solid #f4f4f5; }
    th.num, td.num { text-align: right; }
    td { padding: 0.5rem 1rem; border-bottom: 1px solid #fafafa; vertical-align: top; }
    tr:hover td { background: #fafafa; }
    .acct { font-weight: 500; display: block; }
    .mono { font-size: 0.75rem; color: #71717a; font-family: ui-monospace, monospace; }
    .muted { color: #52525b; }
    .strong { font-weight: 500; }
    .pill { display: inline-flex; align-items: center; border-radius: 9999px; padding: 0.125rem 0.5rem; font-size: 0.75rem; font-weight: 500; }
    .pill-churn { background: #fef2f2; color: #991b1b; }
    .pill-renew { background: #ecfdf5; color: #065f46; }
    .pill-sub { font-size: 0.75rem; color: var(--muted); margin-left: 0.35rem; }
    .q-grid { display: grid; gap: 0.75rem; grid-template-columns: repeat(5, minmax(0, 1fr)); margin-top: 1rem; }
    @media (max-width: 1100px) { .q-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 520px) { .q-grid { grid-template-columns: 1fr; } }
    .q-tile { border: 1px solid var(--border); border-radius: 0.65rem; padding: 0.75rem 0.85rem; background: #fafafa; }
    .q-tile-title { margin: 0; font-size: 0.9375rem; font-weight: 700; color: #18181b; letter-spacing: -0.02em; }
    .q-tile-meta { margin: 0.35rem 0 0; font-size: 0.6875rem; color: var(--muted); line-height: 1.35; }
    .q-tile-amounts { margin: 0.65rem 0 0.2rem; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
    .q-amt-label { color: var(--muted); font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.04em; margin-right: 0.25rem; }
    .q-track { margin-bottom: 0.15rem; }
    .q-detail-block { padding: 1rem 1rem 1.25rem; border-bottom: 1px solid #f4f4f5; }
    .q-detail-block:last-child { border-bottom: none; }
    .q-detail-heading { margin: 0 0 0.75rem; font-size: 1rem; font-weight: 600; }
    .q-anchor { color: #047857; text-decoration: none; }
    .q-anchor:hover { text-decoration: underline; }
    .loss-reason { font-size: 0.8125rem; max-width: 14rem; }
  </style>
</head>
<body>
  <div class="wrap">
    <p class="eyebrow">Enterprise SaaS · Renewal cohorts (dev preview)</p>
    <h1>Renewal dashboard</h1>
    <p class="sub">2025-Q1 through 2026-Q1 — ARR up for renewal vs booked. Customers with <strong>last deal in 2023</strong> use a lower revenue GRR target (~85%). Regenerated by <code>npm run data:generate</code>.</p>
    <p class="note">This file is for local use only. Open it directly in your browser. It is not served by the Next.js app.</p>

    <div class="kpis">
      <div class="kpi"><div class="lbl">Up for renewal (all)</div><div class="val">${escapeHtml(formatUsd(rollup.totalUp))}</div><div class="hint">All cohorts</div></div>
      <div class="kpi accent"><div class="lbl">Renewals booked (all)</div><div class="val">${escapeHtml(formatUsd(rollup.totalBooked))}</div><div class="hint">Sum of booked ARR</div></div>
      <div class="kpi"><div class="lbl">GRR (revenue)</div><div class="val">${escapeHtml(formatPct(rollup.grr))}</div><div class="hint">Blended across cohorts</div></div>
      <div class="kpi"><div class="lbl">NRR (revenue)</div><div class="val">${escapeHtml(formatPct(rollup.nrr))}</div><div class="hint">Emergent (1–3× on wins, ~1.6× mean before rounding)</div></div>
      ${
        rollup2023
          ? `<div class="kpi"><div class="lbl">GRR (2023 deals)</div><div class="val">${escapeHtml(formatPct(rollup2023.grr))}</div><div class="hint">${rollup2023.n} logos · last deal year 2023</div></div>
      <div class="kpi"><div class="lbl">Logo renewal (2023)</div><div class="val">${escapeHtml(formatPct(rollup2023.logoRenewPct))}</div><div class="hint">Share of 2023 deals renewed</div></div>`
          : ""
      }
    </div>

    <div class="card pad">
      <h2>Up for renewal vs booked (rollup)</h2>
      <p class="cap">Bar length is to scale (max = larger of the two totals).</p>
      <div class="bar-block">
        <div class="bar-row"><span>Up for renewal</span><span class="strong">${escapeHtml(formatUsd(rollup.totalUp))}</span></div>
        <div class="track"><div class="fill fill-muted" style="width:${Math.min(100, upPct)}%"></div></div>
      </div>
      <div class="bar-block">
        <div class="bar-row"><span>Renewals booked</span><span class="strong">${escapeHtml(formatUsd(rollup.totalBooked))}</span></div>
        <div class="track"><div class="fill fill-accent" style="width:${Math.min(100, bookedPct)}%"></div></div>
      </div>
    </div>

    <div class="card pad" style="margin-top:2rem">
      <h2>All five quarters</h2>
      <p class="cap">Each tile is one cohort. Bar widths use the same scale across quarters (max = ${escapeHtml(formatUsd(maxAcrossQuarters))} — largest single value of “up” or “booked” in any quarter).</p>
      <div class="q-grid">
        ${quarterTilesHtml}
      </div>
    </div>

    <div class="card" style="margin-top:2rem">
      <div class="thead">
        <h2>By quarter (table)</h2>
        <p class="cap">Each quarter is its own simulation (${RENEWAL_QUARTERS.map((q, i) => `${q} ${LOGOS_UP_BY_QUARTER[i]}`).join(" · ")} logos). 2023 deal cohort ~85% revenue GRR; 2024–25 ~95%. Wins: booked ARR 1–3× expiring ARR (mean mult ~1.6×); NRR is whatever results.</p>
      </div>
      <div style="overflow-x:auto">
        <table>
          <thead><tr>
            <th>Quarter</th><th class="num">Logos</th><th class="num">#2023</th><th class="num">GRR ’23</th><th class="num">Up for renewal</th><th class="num">Booked</th><th class="num">GRR</th><th class="num">NRR</th>
          </tr></thead>
          <tbody>${summaryRowsHtml}</tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-top:2rem">
      <div class="thead">
        <h2>Deal detail by quarter</h2>
        <p class="cap">Five sections — same order as the tiles above. Within each quarter, deals sorted by ARR up for renewal (high to low).</p>
      </div>
      ${detailByQuarterHtml}
    </div>
  </div>
</body>
</html>`;

  writeFileSync(outPath, html, "utf8");
}

/** Local-only preview for unified deal data (renewals + new ACV). */
function writeDealDataDashboardHtml(dealRows, outPath) {
  const dealsJson = JSON.stringify(dealRows);
  const quartersJson = JSON.stringify(RENEWAL_QUARTERS);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Deal data dashboard — local preview</title>
  <style>
    :root { --muted: #71717a; --border: #e4e4e7; --surface: #f8fafc; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: var(--surface); color: #18181b; }
    .wrap { max-width: 72rem; margin: 0 auto; padding: 2rem 1rem; }
    h1 { font-size: 1.5rem; font-weight: 600; margin: 0; }
    .sub { font-size: 0.875rem; color: var(--muted); margin: 0.35rem 0 0; }
    .note { font-size: 0.75rem; color: var(--muted); margin: 1.25rem 0 0; padding: 0.75rem 1rem; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 0.5rem; }
    .filters { display: flex; flex-wrap: wrap; gap: 0.75rem 1rem; align-items: flex-end; margin-top: 1.5rem; padding: 1rem; background: #fff; border: 1px solid var(--border); border-radius: 0.75rem; }
    .field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 8rem; }
    .field label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    select, input[type="search"] { font-size: 0.875rem; padding: 0.35rem 0.5rem; border: 1px solid var(--border); border-radius: 0.375rem; background: #fff; }
    button { font-size: 0.8125rem; padding: 0.4rem 0.75rem; border-radius: 0.375rem; border: 1px solid var(--border); background: #fff; cursor: pointer; }
    button:hover { background: #f4f4f5; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: 0.75rem; margin-top: 1.25rem; }
    .kpi { border: 1px solid var(--border); border-radius: 0.65rem; padding: 0.75rem 1rem; background: #fff; }
    .kpi .lbl { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    .kpi .val { font-size: 1.125rem; font-weight: 600; margin-top: 0.2rem; font-variant-numeric: tabular-nums; }
    .card { margin-top: 1.25rem; border: 1px solid var(--border); border-radius: 0.75rem; background: #fff; overflow: hidden; }
    .card h2 { margin: 0; padding: 0.75rem 1rem; font-size: 0.9375rem; font-weight: 600; background: #fafafa; border-bottom: 1px solid #f4f4f5; }
    .chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); gap: 0.9rem; margin-top: 1.25rem; }
    .chart-grid .card { margin-top: 0; }
    .bars { padding: 0.8rem 1rem 0.95rem; }
    .bar-row { display: grid; grid-template-columns: 4.75rem 1fr auto; gap: 0.6rem; align-items: center; margin: 0.45rem 0; }
    .bar-lbl { font-size: 0.78rem; color: var(--muted); font-variant-numeric: tabular-nums; }
    .bar-track { height: 0.72rem; background: #f4f4f5; border-radius: 999px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 999px; display: flex; overflow: hidden; }
    .bar-fill .seg { height: 100%; }
    .bar-fill .seg.type-land { background: #22c55e; }
    .bar-fill .seg.type-expand { background: #8b5cf6; }
    .bar-fill .seg.type-renew { background: #0ea5e9; }
    .bar-val { font-size: 0.78rem; color: #27272a; min-width: 4.5rem; text-align: right; font-variant-numeric: tabular-nums; }
    .chart-legend { margin: 0.55rem 1rem 0.2rem; font-size: 0.74rem; color: var(--muted); display: flex; gap: 1rem; }
    .chip { display: inline-block; width: 0.65rem; height: 0.65rem; border-radius: 999px; margin-right: 0.3rem; vertical-align: -0.05rem; }
    .chip.type-land { background: #22c55e; }
    .chip.type-expand { background: #8b5cf6; }
    .chip.type-renew { background: #0ea5e9; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
    th { text-align: left; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; padding: 0.5rem 0.75rem; border-bottom: 1px solid #f4f4f5; }
    td { padding: 0.45rem 0.75rem; border-bottom: 1px solid #fafafa; vertical-align: top; }
    th.num, td.num { text-align: right; }
    tbody tr:hover td { background: #fafafa; }
    .mono { font-family: ui-monospace, monospace; font-size: 0.75rem; color: #52525b; }
    .acct { font-weight: 500; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Deal data (renewals + new ACV)</h1>
    <p class="sub">Unified view of renewal outcomes and new ACV deals by quarter. Regenerated by <code>npm run data:generate</code>.</p>
    <p class="note">Open this file directly in your browser. It is not served by the Next.js app. Data source is merged <code>crm/deal_data.csv</code>.</p>

    <div class="filters">
      <div class="field">
        <label for="fQuarter">Quarter</label>
        <select id="fQuarter"></select>
      </div>
      <div class="field">
        <label for="fRegion">Region</label>
        <select id="fRegion"></select>
      </div>
      <div class="field">
        <label for="fTerm">Term (years)</label>
        <select id="fTerm"></select>
      </div>
      <div class="field">
        <label for="fOutcome">Outcome</label>
        <select id="fOutcome"></select>
      </div>
      <div class="field" style="flex:1;min-width:12rem">
        <label for="fSearch">Search</label>
        <input id="fSearch" type="search" placeholder="Account id or name…" autocomplete="off" />
      </div>
      <button type="button" id="btnReset">Reset filters</button>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="lbl">Deals (filtered)</div><div class="val" id="kpiAccounts">—</div></div>
      <div class="kpi"><div class="lbl">ACV (filtered)</div><div class="val" id="kpiBooked">—</div></div>
      <div class="kpi"><div class="lbl">Avg ACV / deal</div><div class="val" id="kpiAvg">—</div></div>
      <div class="kpi"><div class="lbl">Land deals</div><div class="val" id="kpiLand">—</div></div>
      <div class="kpi"><div class="lbl">Expand + renew deals</div><div class="val" id="kpiExpandRenew">—</div></div>
    </div>

    <div class="chart-grid">
      <div class="card">
        <h2># Deals by quarter</h2>
        <p class="chart-legend" id="legendCount"></p>
        <div id="chartCount" class="bars"></div>
      </div>
      <div class="card">
        <h2>$ ACV by quarter</h2>
        <p class="chart-legend" id="legendAmount"></p>
        <div id="chartAmount" class="bars"></div>
      </div>
    </div>

    <div class="card">
      <h2>Unified detail (filtered)</h2>
      <div style="overflow-x:auto; max-height: min(60vh, 28rem); overflow-y: auto;">
        <table>
          <thead><tr>
            <th>Account</th><th>Quarter</th><th>Close date</th><th>Outcome</th><th>Deal type</th><th>Vertical</th><th>Product</th><th>Region</th><th class="num">Term</th><th class="num">ACV</th><th class="num">TCV</th>
          </tr></thead>
          <tbody id="tblDeals"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    const DEALS = ${dealsJson};
    const QUARTERS = ${quartersJson};
    const REGIONS = ["AMER", "EMEA", "APAC"];
    const TERMS = [1, 2, 3, 4, 5];
    const DEAL_TYPES = ["land", "expand", "renew"];
    const DEAL_TYPE_LABEL = { land: "Land", expand: "Expand", renew: "Renew" };
    const OUTCOMES = Array.from(new Set(DEALS.map((d) => d.outcome).filter(Boolean))).sort();

    const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

    function fillSelect(sel, labelAll, values) {
      sel.innerHTML = "";
      const o0 = document.createElement("option");
      o0.value = "";
      o0.textContent = labelAll;
      sel.appendChild(o0);
      for (const v of values) {
        const o = document.createElement("option");
        o.value = String(v);
        o.textContent = String(v);
        sel.appendChild(o);
      }
    }

    function visibleDeals() {
      const fq = document.getElementById("fQuarter").value;
      const fr = document.getElementById("fRegion").value;
      const ft = document.getElementById("fTerm").value;
      const fo = document.getElementById("fOutcome").value;
      const q = document.getElementById("fSearch").value.trim().toLowerCase();
      return DEALS.filter((d) => {
        if (fq && d.fiscal_quarter !== fq) return false;
        if (fr && d.region !== fr) return false;
        if (ft && String(d.contract_term_years) !== ft) return false;
        if (fo && d.outcome !== fo) return false;
        if (q) {
          const hay = (d.account_id + " " + d.account_name).toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    }

    function render() {
      const rows = visibleDeals();
      const bookingRows = rows.filter(
        (d) =>
          (d.acv_usd || 0) > 0 &&
          d.deal_type &&
          DEAL_TYPES.includes(d.deal_type),
      );
      const n = bookingRows.length;
      const sum = bookingRows.reduce((s, d) => s + (d.acv_usd || 0), 0);
      const avg = n ? Math.round(sum / n) : 0;
      const landN = bookingRows.reduce((c, d) => c + (d.deal_type === "land" ? 1 : 0), 0);
      const expandN = bookingRows.reduce((c, d) => c + (d.deal_type === "expand" ? 1 : 0), 0);
      const renewN = bookingRows.reduce((c, d) => c + (d.deal_type === "renew" ? 1 : 0), 0);
      const landPct = n ? Math.round((landN * 1000) / n) / 10 : 0;
      const expandRenewPct = n ? Math.round(((expandN + renewN) * 1000) / n) / 10 : 0;

      document.getElementById("kpiAccounts").textContent = String(n);
      document.getElementById("kpiBooked").textContent = money.format(sum);
      document.getElementById("kpiAvg").textContent = n ? money.format(avg) : "—";
      document.getElementById("kpiLand").textContent =
        n ? String(landN) + " (" + landPct.toFixed(1) + "%)" : "—";
      document.getElementById("kpiExpandRenew").textContent =
        n ? String(expandN + renewN) + " (" + expandRenewPct.toFixed(1) + "%)" : "—";

      const byQ = Object.fromEntries(
        QUARTERS.map((q) => [
          q,
          {
            n: 0,
            sum: 0,
            byTypeN: Object.fromEntries(DEAL_TYPES.map((t) => [t, 0])),
            byTypeSum: Object.fromEntries(DEAL_TYPES.map((t) => [t, 0])),
          },
        ]),
      );
      for (const d of bookingRows) {
        const b = byQ[d.fiscal_quarter];
        if (!b) continue;
        b.n += 1;
        const amount = d.acv_usd || 0;
        const bt = d.deal_type;
        if (bt && bt in b.byTypeN) {
          b.byTypeN[bt] += 1;
          b.byTypeSum[bt] += amount;
        }
        b.sum += amount;
      }
      const countMax = Math.max(0, ...QUARTERS.map((q) => byQ[q].n));
      const amountMax = Math.max(0, ...QUARTERS.map((q) => byQ[q].sum));
      const chartCount = document.getElementById("chartCount");
      const chartAmount = document.getElementById("chartAmount");
      chartCount.innerHTML = "";
      chartAmount.innerHTML = "";
      for (const q of QUARTERS) {
        const b = byQ[q];
        const countWidth = countMax ? (b.n * 100) / countMax : 0;
        const amountWidth = amountMax ? (b.sum * 100) / amountMax : 0;
        const countSegs = DEAL_TYPES.map((t) => {
          const pct = b.n ? (b.byTypeN[t] * 100) / b.n : 0;
          return '<div class="seg type-' + t + '" style="width:' + pct.toFixed(1) + '%"></div>';
        }).join("");
        const amountSegs = DEAL_TYPES.map((t) => {
          const pct = b.sum ? (b.byTypeSum[t] * 100) / b.sum : 0;
          return '<div class="seg type-' + t + '" style="width:' + pct.toFixed(1) + '%"></div>';
        }).join("");

        const rc = document.createElement("div");
        rc.className = "bar-row";
        rc.innerHTML =
          '<div class="bar-lbl">' + q + "</div>" +
          '<div class="bar-track"><div class="bar-fill count" style="width:' + countWidth.toFixed(1) + '%">' + countSegs + "</div></div>" +
          '<div class="bar-val">' + b.n + "</div>";
        chartCount.appendChild(rc);

        const ra = document.createElement("div");
        ra.className = "bar-row";
        ra.innerHTML =
          '<div class="bar-lbl">' + q + "</div>" +
          '<div class="bar-track"><div class="bar-fill amount" style="width:' + amountWidth.toFixed(1) + '%">' + amountSegs + "</div></div>" +
          '<div class="bar-val">' + money.format(b.sum) + "</div>";
        chartAmount.appendChild(ra);
      }

      const tbD = document.getElementById("tblDeals");
      tbD.innerHTML = "";
      const sorted = [...rows].sort((a, b) => {
        const i =
          QUARTERS.indexOf(a.fiscal_quarter) - QUARTERS.indexOf(b.fiscal_quarter);
        if (i !== 0) return i;
        return (b.acv_usd || 0) - (a.acv_usd || 0);
      });
      for (const d of sorted) {
        const tr = document.createElement("tr");
        const esc = (s) =>
          String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
        tr.innerHTML =
          '<td><span class="acct">' +
          esc(d.account_name) +
          '</span><span class="mono">' +
          esc(d.account_id) +
          "</span></td>" +
          "<td>" +
          esc(d.fiscal_quarter) +
          "</td>" +
          "<td>" +
          esc(d.close_date || "") +
          "</td>" +
          "<td>" +
          esc(d.outcome || "") +
          "</td>" +
          "<td>" +
          esc(DEAL_TYPE_LABEL[d.deal_type] || d.deal_type || "") +
          "</td>" +
          "<td>" +
          esc(d.account_vertical || "") +
          "</td>" +
          "<td>" +
          esc(d.product_line || "") +
          "</td>" +
          "<td>" +
          esc(d.region) +
          "</td>" +
          '<td class="num">' +
          d.contract_term_years +
          "</td>" +
          '<td class="num">' +
          money.format(d.acv_usd || 0) +
          "</td>" +
          '<td class="num">' +
          money.format(d.tcv_usd || 0) +
          "</td>";
        tbD.appendChild(tr);
      }
    }

    document.addEventListener("DOMContentLoaded", () => {
      fillSelect(document.getElementById("fQuarter"), "All quarters", QUARTERS);
      fillSelect(document.getElementById("fRegion"), "All regions", REGIONS);
      fillSelect(document.getElementById("fTerm"), "All terms", TERMS);
      fillSelect(document.getElementById("fOutcome"), "All outcomes", OUTCOMES);

      const legendHtml = DEAL_TYPES.map((t) => '<span><span class="chip type-' + t + '"></span>' + (DEAL_TYPE_LABEL[t] || t) + "</span>").join("");
      document.getElementById("legendCount").innerHTML = legendHtml;
      document.getElementById("legendAmount").innerHTML = legendHtml;

      ["fQuarter", "fRegion", "fTerm", "fOutcome"].forEach((id) => {
        document.getElementById(id).addEventListener("change", render);
      });
      let t;
      document.getElementById("fSearch").addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(render, 120);
      });
      document.getElementById("btnReset").addEventListener("click", () => {
        document.getElementById("fQuarter").value = "";
        document.getElementById("fRegion").value = "";
        document.getElementById("fTerm").value = "";
        document.getElementById("fOutcome").value = "";
        document.getElementById("fSearch").value = "";
        render();
      });
      render();
    });
  </script>
</body>
</html>`;

  writeFileSync(outPath, html, "utf8");
}

function main() {
  const rnd = mulberry32(RNG_SEED);

  if (existsSync(OUT)) {
    rmSync(OUT, { recursive: true });
  }
  if (existsSync(LEGACY_OUT)) {
    rmSync(LEGACY_OUT, { recursive: true });
  }
  mkdirSync(join(OUT, "crm"), { recursive: true });
  mkdirSync(join(OUT, "cx"), { recursive: true });
  mkdirSync(join(OUT, "finance"), { recursive: true });
  mkdirSync(join(OUT, "support"), { recursive: true });

  const idPad = Math.max(4, String(CUSTOMER_COUNT).length);
  const accounts = [];
  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    const account_id = accountIdAtIndex(i + 1, idPad);
    const name = `${pick(ADJ, rnd)} ${pick(NOUN, rnd)}${rnd() < 0.4 ? " Inc" : ""}`;
    accounts.push({
      account_id,
      account_name: name,
      region: pick(REGIONS, rnd),
      industry: pick(INDUSTRIES, rnd),
      contract_term_years: 0,
      last_deal_year: 0,
      arr_up_for_renewal_usd: sampleArrUsd(rnd),
      renewal_fiscal_quarter: "",
    });
  }

  const perm = Array.from({ length: CUSTOMER_COUNT }, (_, i) => i);
  for (let i = perm.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const wantThreeYear = Math.round(CUSTOMER_COUNT * TERM_THREE_YEAR_SHARE);
  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    accounts[perm[i]].contract_term_years =
      i < wantThreeYear ? 3 : TERM_NON_THREE[Math.floor(rnd() * TERM_NON_THREE.length)];
  }

  const slotQuarters = [];
  for (let qi = 0; qi < RENEWAL_QUARTERS.length; qi++) {
    const q = RENEWAL_QUARTERS[qi];
    for (let j = 0; j < LOGOS_UP_BY_QUARTER[qi]; j++) {
      slotQuarters.push(q);
    }
  }
  for (let i = slotQuarters.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [slotQuarters[i], slotQuarters[j]] = [slotQuarters[j], slotQuarters[i]];
  }
  for (let k = 0; k < CUSTOMER_COUNT; k++) {
    accounts[k].renewal_fiscal_quarter = slotQuarters[k];
  }

  for (const a of accounts) {
    a.last_deal_year = priorDealYear(a.renewal_fiscal_quarter, a.contract_term_years);
  }

  const allRenewals = [];
  for (const q of RENEWAL_QUARTERS) {
    const cohort = accounts.filter((a) => a.renewal_fiscal_quarter === q);
    const rows = simulateRenewalCohort(cohort, rnd);
    allRenewals.push(...rows);
  }

  assignChurnLossReasons(allRenewals, rnd);

  const byAccount = new Map(allRenewals.map((r) => [r.account_id, r]));
  const accountRows = accounts.map((a) => {
    const r = byAccount.get(a.account_id);
    const current = r.outcome === "renewed" ? r.booked_arr_usd : 0;
    return {
      account_id: a.account_id,
      account_name: a.account_name,
      region: a.region,
      industry: a.industry,
      contract_term_years: a.contract_term_years,
      last_deal_year: a.last_deal_year,
      renewal_fiscal_quarter: a.renewal_fiscal_quarter,
      arr_usd_current: current,
    };
  });

  const byAccountRenewal = new Map(allRenewals.map((r) => [r.account_id, r]));
  const productUsageRows = [];
  const satisfactionRows = [];
  for (const a of accounts) {
    const r = byAccountRenewal.get(a.account_id);
    const renewed = r.outcome === "renewed";
    const churned = r.outcome === "churned";
    const ir = RENEWAL_QUARTERS.indexOf(a.renewal_fiscal_quarter);
    for (let qi = 0; qi < RENEWAL_QUARTERS.length; qi++) {
      const q = RENEWAL_QUARTERS[qi];
      if (!isActiveInQuarter(a.renewal_fiscal_quarter, q, renewed)) continue;
      const quartersUntilRenewal =
        churned && ir >= 0 ? Math.max(0, ir - qi) : null;
      for (const product_line of PRODUCT_LINES) {
        const tier = sampleUsageTier(rnd, {
          churned,
          quartersUntilRenewal,
        });
        const csat = sampleCsat(rnd, tier);
        const nps = sampleNps(rnd, csat);
        productUsageRows.push({
          account_id: a.account_id,
          fiscal_quarter: q,
          product_line,
          usage_tier: tier,
        });
        satisfactionRows.push({
          account_id: a.account_id,
          fiscal_quarter: q,
          product_line,
          csat_score: csat,
          nps_score: nps,
        });
      }
    }
  }

  writeFileSync(
    join(OUT, "cx", "product_usage.csv"),
    toCsv(productUsageRows, [
      "account_id",
      "fiscal_quarter",
      "product_line",
      "usage_tier",
    ]),
  );

  writeFileSync(
    join(OUT, "cx", "customer_satisfaction.csv"),
    toCsv(satisfactionRows, [
      "account_id",
      "fiscal_quarter",
      "product_line",
      "csat_score",
      "nps_score",
    ]),
  );

  const { wonNewDeals } = buildWonNewDeals(allRenewals, rnd, CUSTOMER_COUNT, idPad);

  const accountsExtended = [...accountRows];
  const accountIds = new Set(accountsExtended.map((a) => a.account_id));
  for (const d of wonNewDeals) {
    if (accountIds.has(d.account_id)) continue;
    accountIds.add(d.account_id);
    accountsExtended.push({
      account_id: d.account_id,
      account_name: d.account_name,
      region: d.region,
      industry: pick(INDUSTRIES, rnd),
      contract_term_years: d.contract_term_years,
      last_deal_year: priorDealYear(d.fiscal_quarter, d.contract_term_years),
      renewal_fiscal_quarter: "",
      arr_usd_current: d.acv_usd || 0,
    });
  }
  accountsExtended.sort((a, b) => a.account_id.localeCompare(b.account_id));

  writeFileSync(
    join(OUT, "crm", "accounts.csv"),
    toCsv(accountsExtended, [
      "account_id",
      "account_name",
      "region",
      "industry",
      "contract_term_years",
      "last_deal_year",
      "renewal_fiscal_quarter",
      "arr_usd_current",
    ]),
  );

  const unifiedDealRows = buildUnifiedBookingsRows(
    allRenewals,
    wonNewDeals,
    accountsExtended,
    rnd,
    idPad,
  );
  accountsExtended.sort((a, b) => a.account_id.localeCompare(b.account_id));
  writeFileSync(
    join(OUT, "crm", "accounts.csv"),
    toCsv(accountsExtended, [
      "account_id",
      "account_name",
      "region",
      "industry",
      "contract_term_years",
      "last_deal_year",
      "renewal_fiscal_quarter",
      "arr_usd_current",
    ]),
  );
  writeFileSync(
    join(OUT, "crm", "deal_data.csv"),
    toCsv(unifiedDealRows, [
      "account_id",
      "account_name",
      "fiscal_quarter",
      "close_date",
      "region",
      "account_vertical",
      "product_line",
      "deal_type",
      "outcome",
      "contract_term_years",
      "acv_usd",
      "tcv_usd",
    ]),
  );

  const financeSummaryRows = buildFinanceSummaryRows(unifiedDealRows, accountsExtended);
  writeFileSync(
    join(OUT, "finance", "finance_summary.csv"),
    toCsv(financeSummaryRows, [
      "fiscal_quarter",
      "won_deals",
      "lost_deals",
      "won_deal_acv_usd",
      "lost_deal_acv_usd",
      "billings_tcv_usd",
      "recognized_revenue_usd",
      "cogs_usd",
      "gross_profit_usd",
      "sales_marketing_opex_usd",
      "rnd_opex_usd",
      "gna_opex_usd",
      "ebitda_usd",
      "active_accounts",
      "account_base_count",
    ]),
  );

  const accountArrByQuarterRows = buildAccountArrByQuarterRows(
    unifiedDealRows,
    accountsExtended,
    byAccountRenewal,
  );
  writeFileSync(
    join(OUT, "finance", "arr_by_account_quarter.csv"),
    toCsv(accountArrByQuarterRows, ["account_id", "fiscal_quarter", "arr_usd"]),
  );

  const supportSummaryRows = buildSupportSummaryRows(accountsExtended, byAccountRenewal, rnd);
  writeFileSync(
    join(OUT, "support", "support_summary.csv"),
    toCsv(supportSummaryRows, [
      "account_id",
      "fiscal_quarter",
      "ticket_count",
      "avg_days_to_resolution",
    ]),
  );

  const dealDataDashPath = join(OUT, "deal-data-dashboard.html");
  writeDealDataDashboardHtml(unifiedDealRows, dealDataDashPath);

  const catalogPath = join(DATA_ROOT, "catalog.json");
  const catalogFiles = listFilesRecursive(DATA_ROOT, DATA_ROOT).filter(
    (f) => f.path !== "catalog.json",
  );
  writeFileSync(
    catalogPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        data_root: "data",
        files: catalogFiles.sort((a, b) => a.path.localeCompare(b.path)),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(`Wrote ${join(OUT, "crm", "accounts.csv")}`);
  console.log(
    `Wrote ${join(OUT, "crm", "deal_data.csv")} (${unifiedDealRows.length} unified rows: renewals + new ACV, with ${wonNewDeals.length} new ACV rows)`,
  );
  console.log(`Wrote ${join(OUT, "finance", "finance_summary.csv")} (${financeSummaryRows.length} rows)`);
  console.log(
    `Wrote ${join(OUT, "finance", "arr_by_account_quarter.csv")} (${accountArrByQuarterRows.length} rows)`,
  );
  console.log(`Wrote ${join(OUT, "support", "support_summary.csv")} (${supportSummaryRows.length} rows)`);
  console.log(`Wrote ${join(OUT, "cx", "product_usage.csv")} (${productUsageRows.length} rows)`);
  console.log(
    `Wrote ${join(OUT, "cx", "customer_satisfaction.csv")} (${satisfactionRows.length} rows)`,
  );
  console.log(`Wrote ${dealDataDashPath} (open in browser — local preview only)`);
  console.log(`Wrote ${catalogPath} (data file catalog)`);
  console.log(
    `Cohorts: ${RENEWAL_QUARTERS.map((q, i) => `${q}=${LOGOS_UP_BY_QUARTER[i]}`).join(", ")} — ${CUSTOMER_COUNT} accounts, ${allRenewals.length} renewal rows`,
  );
}

main();
