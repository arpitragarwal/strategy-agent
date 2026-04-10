# Strategy team prototype

Multi-agent strategy pipeline with **Server-Sent Events** for live progress, **PostgreSQL** for run state, and an optional **Memory** repository (search-on-demand, like an internal knowledge lookup). Prototype **CSV datasets** under `data/dummy` back in-app quantitative checks (Arquero).

## Agent architecture

All steps are orchestrated in **`src/lib/orchestrator.ts`**. Each “agent” is a **prompt + model call** (text or JSON), not a separate process. The same model ID is used unless you change code.

### Pipeline (happy path)

| Stage | Role | Output |
|--------|------|--------|
| **Context & clarification** | Optional **Memory** routing (small JSON: search or skip) + keyword scan of recent artifacts when useful. Then a **plan JSON** drives **0–4 in-process quant runs** on catalog CSVs to pin down vague goal phrases (e.g. “largest segment”). A final brief is **markdown**: themes, risks, opportunities, **data-backed specificity**, open questions, **Questions for you**, and suggested focus for the tree. Step‑by‑step runs pause here; you can **`PATCH /api/runs/[id]`** with **`clarificationAnswers`** before continuing so answers merge into the brief. | Markdown (`discoveryOutput`) |
| **Structure (v1)** | Builds an initial **hypothesis tree** as JSON: **`roots`** → nested **`children`**; **every node** gets a `nodeStates` entry; **each node's `question`** is a **testable declarative hypothesis** (not only leaves); leaves have **`children: []`**. Parses alternate shapes via `normalizeOutlineDoc`; retries if empty. | JSON → outline |
| **Manager review (tree)** | Reviews MECE coverage and whether **every node's question** is a testable claim (confirm/refute), not the full prose brief. | Markdown → `treeReviewNotes` |
| **Structure (revised)** | Rebuilds full tree JSON from manager feedback; falls back to v1 if revision JSON is invalid. | JSON → final outline |
| **Analysis** (leaves, **bounded concurrency**) | Batched **`Promise.all`** over leaves (cap **`ANALYSIS_CONCURRENCY`**, default 4). Each leaf: initial analysis JSON → **manager review** (grounded to the data catalog; invalid suggested quants dropped) → optional **refinement** pass if gaps remain; then **`verdict`**, **`confidence`**, **`evidence_needed`**, optional **`quant`**, optional **`leafManagerReview`** markdown. Disable with **`LEAF_MANAGER_REVIEW=off`**. User **redirect** notes accumulate in **`redirectContext`** for later batches. | JSON per leaf + SSE |
| **Branch rollup** | After all leaves finish (or skip), **bottom‑up waves** judge each **internal node's hypothesis** (`question`) using **direct children** as evidence (LLM JSON + deterministic fallback): **summary**, **analysis**, **verdict**, **confidence**, optional **evidence** gaps. | Updates `nodeStates` for internal nodes |
| **Manager (analyses)** | Pressure-tests **leaf** analyses (manager prompt stays leaf-focused). | Markdown |
| **Synthesis** | **Short** markdown: **bold key point** (≤2 sentences), then supporting **bullets** (no section header), then **Open questions**. Partial runs prefix a partial banner. | Markdown |

JSON-heavy steps use **`generateJson`** with repair hints (`src/lib/json.ts`). Small models often ignore JSON MIME types, so repairs include **text-model passes** plus a **final JSON-MIME repair** when needed (e.g. prose or comma-separated themes instead of `{ "roots": [...] }`). **`generateText` / `generateJson`** also **retry transient API and network errors** (including many `fetch failed` cases) with backoff — see **`GOOGLE_AI_MAX_RETRIES`** and **`ANALYSIS_CONCURRENCY`** in `.env.example`.

### User controls (while `status === running` or paused for review)

- **Step‑by‑step** pauses after **context & clarification**, **revised hypothesis tree**, and **after branch rollup / leaf phase** (before manager critique).
- **End‑to‑end** skips those pauses (you can still queue **synthesize** / **redirect** between analysis batches).

Checked **between leaf batches** (not mid–API‑call): control consumption applies before each concurrent batch.

- **Synthesize so far** — Stops early: marks remaining leaves `skipped`, runs **partial manager** + **partial synthesis**, saves run and a **memory** row tagged partial (no branch rollup if leaves incomplete).
- **Apply redirect** — Appends steering to **`redirectContext`**; **later leaf batches** see it in the prompt.

Controls: `PATCH /api/runs/[id]/control` with `{ "action": "synthesize_now" }` or `{ "action": "redirect", "note": "..." }`.

While paused after context & clarification: `PATCH /api/runs/[id]` with `{ "clarificationAnswers": "..." }` (optional); merged into the brief when you continue.

### Memory

- **Writes:** On completion (full or partial), a **`MemoryArtifact`** row is saved (title derived from the **user goal**, synthesis excerpt, topics, outline + **all** node states, context brief — **not** manager critique in payload).
- **Reads:** Context step does **not** preload memory. A routing step may request a **targeted search** over recent artifacts (`src/lib/strategyMemory.ts`); hits feed the context prompts when relevant.

### Prototype data & quant

- CSVs live in **`data/dummy/`** (CRM, finance, CX, support). The app’s catalog is **`src/lib/quant/catalog.ts`**; agents reference dataset IDs such as **`crm/accounts`** or **`finance/pnl_monthly`**.
- Regenerate the **~$200M ARR / ~2K logo** synthetic SaaS universe (aligned rollups across CRM, finance, support, and CX):  
  **`npm run data:generate`**  
  (`scripts/generate-enterprise-saas-dummy.mjs`).

### Data model (Prisma)

- **`StrategyRun`** — prompt, **`discoveryOutput`** (context & clarification brief), outline JSON, **`treeReviewNotes`**, **`clarificationAnswers`** (optional; merged on continue), per-node state (leaves + rolled-up branches), manager/synthesis text, progress log, control fields, **`redirectContext`**, **`synthesisIsPartial`**, etc.
- **`MemoryArtifact`** — title, summary, topics, full `payload` snapshot (no manager-notes field in payload for new rows), optional `runId`.

### Code map

| Path | Purpose |
|------|---------|
| `src/lib/agents/prompts.ts` | All agent prompt strings (context, tree, leaves, rollup, synthesis, …). |
| `src/lib/orchestrator.ts` | Run state machine, SSE, partial completion, branch rollup, memory writes. |
| `src/lib/strategyMemory.ts` | Optional Memory search + digest for context step. |
| `src/lib/genai.ts` | Google AI client, text vs JSON generation, JSON repair (incl. JSON‑MIME pass), retries. |
| `src/lib/quant/` | Dataset paths, CSV load, declarative **quant** plan execution (Arquero). |
| `src/lib/outline.ts` | Outline normalization, leaf flattening, **all node ids**, path labels. |
| `src/components/StrategyConsole.tsx` | UI: hypothesis tree, verdict/confidence/evidence per node, rollup labels, EventSource, memory. |
| `src/components/MarkdownBody.tsx` | Renders memo markdown in the browser. |
| `scripts/generate-enterprise-saas-dummy.mjs` | Regenerate `data/dummy/*.csv` for end-to-end tests. |

## Model (open-weight Gemma 4)

The app uses Google’s **Generative Language API** (`@google/generative-ai`) with a **model ID** you choose. That is the same API/key as “Gemini API,” but you should point it at **Gemma 4** (open-weight models Google hosts). The code default is **`gemma-4-31b-it`** (dense 31B). Set **`GOOGLE_AI_MODEL`** in `.env` to override (e.g. `gemma-4-26b-a4b-it` for the MoE variant if you want lower latency or different billing). Confirm the exact id in [AI Studio](https://aistudio.google.com). See [Run Gemma with the Gemini API](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api).

Legacy env name `GEMINI_MODEL` is still read if `GOOGLE_AI_MODEL` is unset.

---

## Prerequisites

- Node.js 20+
- A [Google AI Studio](https://aistudio.google.com/apikey) API key
- A Postgres database (e.g. [Neon](https://neon.tech) free tier)

## Setup

```bash
cp .env.example .env
# Edit .env: GOOGLE_AI_API_KEY, GOOGLE_AI_MODEL, DATABASE_URL
# Optional: GOOGLE_AI_MAX_RETRIES, ANALYSIS_CONCURRENCY

npm install
npx prisma db push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deploying on Vercel

1. Create a Vercel project from this repo.
2. Add environment variables: `GOOGLE_AI_API_KEY`, `GOOGLE_AI_MODEL`, `DATABASE_URL` (Neon pooled URL recommended).
3. Build command: `prisma generate && next build` (already in `npm run build`).
4. Long runs: this app sets `maxDuration = 300` on the stream route; on Hobby, Vercel may cap execution time lower — upgrade or move orchestration to a background worker if runs time out.
