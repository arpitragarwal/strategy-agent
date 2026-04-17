const { stripSynthesisMarkdown } = await import(
  new URL("../src/lib/stripExecutiveMarkdownPreamble.ts", import.meta.url).href
);

type Case = {
  name: string;
  input: string;
  expectContains: string[];
  expectNotContains: string[];
};

const cases: Case[] = [
  {
    name: "duplicate full synthesis (bold + bullets + ## Open questions, repeated)",
    input: `**Focus on expanding high-usage "power user" accounts and concentrating resources on high-win verticals, while delaying Enterprise ROI/Legal interventions until data gaps are closed.**

- Expansion win rates are strictly utility-driven, with losses concentrated in minimal/no-usage tiers.
- Shifting deal volume to the top two high-win-rate verticals can mathematically lift aggregate win rates.
- Win rates decay as ACV increases, but the driver remains inconclusive due to a statistically insignificant sample size (12 rows).
- Rep-level coaching and process enforcement are currently unfalsifiable because rep_id is missing.
- Current trends are based on Q1-26 data, leaving a blind spot for Q2-26 goals.

## Open questions
- Can rep_id be sourced to shift focus from market-fit to sales enablement?
- What is the TAM ceiling for the top-performing verticals?
- Is the Enterprise drop-off driven by ROI perception or the "Complexity Tax" (legal/procurement)?
- Do usage spikes consistently precede expansion deals (lead-lag analysis)?

**Prioritize expansion growth by targeting high-usage "power users" and concentrating land efforts on high-win-rate verticals, while pausing Enterprise ROI and rep-coaching initiatives until critical CRM data gaps are closed.**

- Expansion win rates are strictly utility-driven, with losses heavily concentrated in minimal or no-usage tiers.
- Shifting deal volume toward the top two high-performing verticals can mathematically lift aggregate win rates.
- Enterprise land win rates decay as ACV increases, but the primary driver remains inconclusive because loss-reason data for this segment is statistically insignificant (only 12 rows).
- Rep-level coaching and process enforcement are currently unfalsifiable and should be sidelined until rep_id and stage-transition timestamps are sourced.
- A temporal blind spot exists between the Q1-26 data cutoff and Q2-26 goals, requiring a lead-lag analysis.

## Open questions
- Can rep_id be recovered to determine if win rate variance is driven by sales skill?
- What is the TAM ceiling for the top-performing verticals?
- Is the Enterprise land attrition driven by ROI perception or the "Complexity Tax"?
- Do current usage-to-expansion conversion trends persist into the Q2-26 window?`,
    expectContains: [
      "Focus on expanding high-usage",
      "Q1-26 data, leaving a blind spot",
      "## Open questions",
      "Do usage spikes consistently precede expansion deals",
    ],
    expectNotContains: [
      "Prioritize expansion growth by targeting",
      "should be sidelined until rep_id",
      "Complexity Tax\" of legal",
      "Q2-26 window",
    ],
  },
  {
    name: "single synthesis (no duplication) — should pass through",
    input: `**Focus on expanding high-usage "power user" accounts.**

- Expansion win rates are strictly utility-driven.
- Shifting deal volume to the top two verticals can lift aggregate win rates.

## Open questions
- What is the TAM ceiling for top verticals?
- Is the Enterprise drop-off driven by ROI perception?`,
    expectContains: [
      "Focus on expanding high-usage",
      "## Open questions",
      "What is the TAM ceiling",
    ],
    expectNotContains: ["first attempt", "second attempt"],
  },
  {
    name: "single synthesis with short bold emphasis inside bullets — must not truncate",
    input: `**Prioritize expansion accounts with usage above the threshold.**

- The **key driver** is usage depth, not deal size.
- **Q1-26** data shows a 40% gap between top and bottom tiers.
- Verticals differ by **TAM ceiling**, not product quality.

## Open questions
- What is the exact **usage threshold** for top-tier accounts?
- Do **ROI perceptions** flip after onboarding completes?`,
    expectContains: [
      "Prioritize expansion accounts",
      "key driver",
      "## Open questions",
      "usage threshold",
      "ROI perceptions",
    ],
    expectNotContains: [],
  },
  {
    name: "duplicate with no blank line between first Open questions and second bold",
    input: `**First summary recommendation.**

- Support A
- Support B

## Open questions
- Q1
- Q2
**Second summary with different wording.**

- Alt A
- Alt B

## Open questions
- Qx
- Qy`,
    expectContains: ["First summary recommendation", "Q1", "Q2"],
    expectNotContains: [
      "Second summary with different wording",
      "Alt A",
      "Qx",
    ],
  },
  {
    name: "duplicate nested inside Open questions via `* *Bold Summary:* **…**`",
    input: `**To improve Q2-26 win rates, implement a bifurcated strategy that prioritizes usage-based triggers for expansion deals and pricing-centric optimization for land deals.**

- Expansion losses are primarily driven by adoption bottlenecks.
- Land deals are primarily lost on pricing.
- Existing "winner" verticals provide a potential blueprint.
- Product-market fit gaps in specific lines.
- Current data volume is critically low for several segments.

## Open questions
- What is the precise usage threshold that separates high-risk from high-win accounts?
- Do laggard verticals show high "Value" loss reasons even when usage is high?
- Does the Q2-26 product roadmap address the specific capability gaps?
- Is there a statistically significant sample size (N > 30) for laggard segments?
  - *Bold Summary:* **Improve Q2-26 win rates by bifurcating sales plays—focusing land deals on pricing optimization and expansion deals on usage-based triggers—while validating that vertical laggards suffer from value-proposition gaps rather than adoption bottlenecks.**
  - Expansion win rates correlate strongly with usage tiers, with low-usage accounts serving as the primary driver of lost deals.
  - Land deals are primarily lost on pricing, requiring a distinct intervention strategy.
  - Vertical "blueprints" can only be scaled if losses in laggard segments are driven by ROI failures.
  - Product-line underperformance may be a positioning gap.
  - Strategic pivots for ICP and product enablement currently rely on statistically thin datasets.
  - What is the precise usage threshold that separates high-risk from high-win accounts?
  - Do laggard verticals show high "Value" loss reasons even when usage is high?
  - Does the Q2-26 product roadmap address the specific capability gaps?
  - Can we achieve a statistically significant sample size (N > 30) for laggard segments before committing resources?**Improve Q2-26 win rates by bifurcating sales plays—focusing land deals on pricing optimization and expansion deals on usage-based triggers—while validating that vertical laggards suffer from value-proposition gaps rather than adoption bottlenecks.**
  - Expansion win rates correlate strongly with usage tiers, with low-usage accounts serving as the primary driver of lost deals.
  - Land deals are primarily lost on pricing.
  - Vertical "blueprints" can only be scaled if losses in laggard segments are driven by ROI failures.
  - Product-line underperformance may be a positioning gap.
  - Strategic pivots for ICP and product enablement currently rely on statistically thin datasets.`,
    expectContains: [
      "To improve Q2-26 win rates, implement a bifurcated strategy",
      "Expansion losses are primarily driven by adoption bottlenecks",
      "## Open questions",
      "What is the precise usage threshold",
      "Is there a statistically significant sample size (N > 30) for laggard segments?",
    ],
    expectNotContains: [
      "Improve Q2-26 win rates by bifurcating sales plays",
      "Bold Summary",
      "Vertical \"blueprints\" can only be scaled",
      "Strategic pivots for ICP",
      "Can we achieve a statistically significant sample size",
    ],
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  const out = stripSynthesisMarkdown(c.input);
  const missing = c.expectContains.filter((s) => !out.includes(s));
  const leaked = c.expectNotContains.filter((s) => out.includes(s));
  if (missing.length === 0 && leaked.length === 0) {
    console.log(`PASS  ${c.name}`);
    pass++;
  } else {
    console.log(`FAIL  ${c.name}`);
    if (missing.length) console.log("  missing:", missing);
    if (leaked.length) console.log("  leaked: ", leaked);
    console.log("  --- output ---");
    console.log(out);
    console.log("  --- end ---");
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
