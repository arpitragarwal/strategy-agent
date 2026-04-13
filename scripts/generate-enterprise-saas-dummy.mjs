#!/usr/bin/env node
/**
 * Enterprise SaaS prototype: logos up for renewal ramp 2025-Q1 (100) → 2026-Q1 (~150) across five Qs.
 * Contract terms 1–5 years (~80% are 3 years). Renewed deals: booked ARR = 1–3× prior ARR (E[×] ≈ 1.6); NRR is emergent.
 * Prior deal year = renewal calendar year − contract_term_years (~80% are 3yr → ~80%/Q are “3 years ago”).
 * Revenue GRR: last_deal_year === 2023 → ~85%; otherwise ~95%.
 *
 * Run: node scripts/generate-enterprise-saas-dummy.mjs
 * Or: npm run data:generate
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "data", "dummy");

/** All renewal periods included in the export. */
const RENEWAL_QUARTERS = ["2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4", "2026-Q1"];
/** Logos up for renewal in first Q (2025-Q1) and last Q (2026-Q1); middle Qs linearly interpolated. */
const LOGOS_UP_FIRST_Q = 100;
const LOGOS_UP_LAST_Q = 150;

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
  return Math.round((22_000 + u * 520_000) / 1000) * 1000;
}

function pick(arr, rnd) {
  return arr[Math.floor(rnd() * arr.length)];
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
 * @param {Array<{account_id: string, account_name: string, region: string, industry: string, contract_term_years: number, last_deal_year: number, arr_up_for_renewal_usd: number, renewal_quarter: string}>} cohort
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
      renewal_quarter: a.renewal_quarter,
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
    if (byQ[r.renewal_quarter]) byQ[r.renewal_quarter].push(r);
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
    const qi = RENEWAL_QUARTERS.indexOf(a.renewal_quarter) - RENEWAL_QUARTERS.indexOf(b.renewal_quarter);
    if (qi !== 0) return qi;
    return b.arr_up_for_renewal_usd - a.arr_up_for_renewal_usd;
  });

  function detailRowsForQuarter(q) {
    const quarterRows = sorted.filter((r) => r.renewal_quarter === q);
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

function main() {
  const rnd = mulberry32(RNG_SEED);

  if (existsSync(OUT)) {
    rmSync(OUT, { recursive: true });
  }
  mkdirSync(join(OUT, "crm"), { recursive: true });

  const idPad = Math.max(4, String(CUSTOMER_COUNT).length);
  const accounts = [];
  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    const account_id = `A${String(i + 1).padStart(idPad, "0")}`;
    const name = `${pick(ADJ, rnd)} ${pick(NOUN, rnd)}${rnd() < 0.4 ? " Inc" : ""}`;
    accounts.push({
      account_id,
      account_name: name,
      region: pick(REGIONS, rnd),
      industry: pick(INDUSTRIES, rnd),
      contract_term_years: 0,
      last_deal_year: 0,
      arr_up_for_renewal_usd: sampleArrUsd(rnd),
      renewal_quarter: "",
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
    accounts[k].renewal_quarter = slotQuarters[k];
  }

  for (const a of accounts) {
    a.last_deal_year = priorDealYear(a.renewal_quarter, a.contract_term_years);
  }

  const allRenewals = [];
  for (const q of RENEWAL_QUARTERS) {
    const cohort = accounts.filter((a) => a.renewal_quarter === q);
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
      renewal_quarter: a.renewal_quarter,
      arr_usd_current: current,
    };
  });

  writeFileSync(
    join(OUT, "crm", "accounts.csv"),
    toCsv(accountRows, [
      "account_id",
      "account_name",
      "region",
      "industry",
      "contract_term_years",
      "last_deal_year",
      "renewal_quarter",
      "arr_usd_current",
    ]),
  );

  writeFileSync(
    join(OUT, "crm", "renewals.csv"),
    toCsv(allRenewals, [
      "account_id",
      "account_name",
      "renewal_quarter",
      "region",
      "contract_term_years",
      "last_deal_year",
      "arr_up_for_renewal_usd",
      "outcome",
      "loss_reason",
      "booked_arr_usd",
      "renewal_motion",
    ]),
  );

  const dashboardPath = join(OUT, "renewals-dashboard.html");
  writeRenewalsDashboardHtml(allRenewals, dashboardPath);

  console.log(`Wrote ${join(OUT, "crm", "accounts.csv")}`);
  console.log(`Wrote ${join(OUT, "crm", "renewals.csv")}`);
  console.log(`Wrote ${dashboardPath} (open in browser — local preview only)`);
  console.log(
    `Cohorts: ${RENEWAL_QUARTERS.map((q, i) => `${q}=${LOGOS_UP_BY_QUARTER[i]}`).join(", ")} — ${CUSTOMER_COUNT} accounts, ${allRenewals.length} renewal rows`,
  );
}

main();
