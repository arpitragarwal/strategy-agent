# Strategy team prototype

Multi-agent strategy pipeline with **Server-Sent Events** for live progress, **PostgreSQL** for run state, and an optional **Memory** repository (search-on-demand, like an internal knowledge lookup). A **SQL subagent** answers numeric questions on demand against an in-process **DuckDB** warehouse (views over prototype CSVs in `data/dummy_data/`).

## Agent architecture

All steps are orchestrated in **`src/lib/orchestrator.ts`**. Each “agent” is a **prompt + model call** (text or JSON), not a separate process. The same model ID is used unless you change code.

### Pipeline (happy path)

| Stage | Role | Output |
|--------|------|--------|
| **Context & clarification** | If **`usePriorRunMemory`** is true on the run (default): optional **Memory** routing (small JSON: search or skip) + keyword scan of recent artifacts when useful. If false, that search is skipped. Then a **plan JSON** emits up to **4 natural-language `quant_requests`** that the **SQL subagent** answers against DuckDB to pin down vague goal phrases (e.g. “largest segment”). A final brief is **markdown**: themes, risks, opportunities, **data-backed specificity**, open questions, **Questions for you**, and suggested focus for the tree. Step‑by‑step runs pause here; you can **`PATCH /api/runs/[id]`** with **`clarificationAnswers`** before continuing so answers merge into the brief. | Markdown (`discoveryOutput`) |
| **Structure (v1)** | Builds an initial **hypothesis tree** as JSON: **`roots`** → nested **`children`**; **every node** gets a `nodeStates` entry; **each node's `question`** is a **testable declarative hypothesis** (not only leaves); leaves have **`children: []`**. Parses alternate shapes via `normalizeOutlineDoc`; retries if empty. | JSON → outline |
| **Manager review (tree)** | Reviews MECE coverage and whether **every node's question** is a testable claim (confirm/refute), not the full prose brief. | Markdown → `treeReviewNotes` |
| **Structure (revised)** | Rebuilds full tree JSON from manager feedback; falls back to v1 if revision JSON is invalid. | JSON → final outline |
| **Analysis** (leaves, **bounded concurrency**) | Batched **`Promise.all`** over leaves (cap **`ANALYSIS_CONCURRENCY`**; default **3** on Vercel, **4** locally). Each leaf: initial analysis JSON (optional **`quant_request`** delegated to the SQL subagent) → **manager review** grounded to the data catalog (may emit a **`suggested_followup_quant_request`**) → optional **refinement** pass that re-runs the SQL subagent on the manager's follow-up; then **`verdict`**, **`confidence`**, **`evidence_needed`**, optional **`quant`** result, optional **`leafManagerReview`** markdown. Disable with **`LEAF_MANAGER_REVIEW=off`**. The DB field **`redirectContext`** is legacy only (older runs); it is not written by the app anymore. | JSON per leaf + SSE |
| **Branch rollup** | After all leaves finish (or skip), **bottom‑up waves** judge each **internal node's hypothesis** (`question`) using **direct children** as evidence (LLM JSON + deterministic fallback): **summary**, **analysis**, **verdict**, **confidence**, optional **evidence** gaps. | Updates `nodeStates` for internal nodes |
| **Manager (analyses)** | Pressure-tests **leaf** analyses (manager prompt stays leaf-focused). | Markdown |
| **Synthesis** | **Short** markdown: **bold key point** (≤2 sentences), then supporting **bullets** (no section header), then **Open questions**. Partial runs prefix a partial banner. | Markdown |

JSON-heavy steps use **`generateJson`** with repair hints (`src/lib/json.ts`). Small models often ignore JSON MIME types, so repairs include **text-model passes** plus a **final JSON-MIME repair** when needed (e.g. prose or comma-separated themes instead of `{ "roots": [...] }`). **`generateText` / `generateJson`** also **retry transient API and network errors** (including many `fetch failed` cases) with backoff — see **`GOOGLE_AI_MAX_RETRIES`** and **`ANALYSIS_CONCURRENCY`** in `.env.example`.

### User controls (while `status === running` or paused for review)

- **Step‑by‑step** pauses after **context & clarification**, **revised hypothesis tree**, and **after branch rollup / leaf phase** (before manager critique).
- **End‑to‑end** skips those pauses (you can still queue **synthesize so far** between analysis batches).

Checked **between leaf batches** (not mid–API‑call): control consumption applies before each concurrent batch.

- **Synthesize so far** — Stops early: marks remaining leaves `skipped`, runs **partial manager** + **partial synthesis**, saves run and a **memory** row tagged partial (no branch rollup if leaves incomplete).

Controls: `PATCH /api/runs/[id]/control` with `{ "action": "synthesize_now" }` (optional `"note"` is accepted but unused today).

Run creation: **`POST /api/runs`** with **`prompt`** (required), optional **`mode`** (`step_by_step` \| `end_to_end`, default `step_by_step`), optional **`usePriorRunMemory`** (boolean, default **`true`**).

While paused after context & clarification: `PATCH /api/runs/[id]` with `{ "clarificationAnswers": "..." }` (optional); merged into the brief when you continue.

### Memory

- **Writes:** On completion (full or partial), a **`MemoryArtifact`** row is saved (title derived from the **user goal**, synthesis excerpt, topics, outline + **all** node states, context brief — **not** manager critique in payload).
- **Reads:** Context step does **not** preload memory. When **`usePriorRunMemory`** is true (default), a routing step may request a **targeted search** over recent artifacts (`src/lib/strategyMemory.ts`); hits feed the context prompts when relevant. When false, that search path is skipped for the whole run (set via **`POST /api/runs`** body and stored on **`StrategyRun`**).

### Prototype data & quant

- CSVs live in **`data/dummy_data/`**. The app's catalog is **`src/lib/quant/catalog.ts`** — seven prototype tables across CRM, CX, finance, and support. Catalog ids use slashes (e.g. **`crm/deal_data`**); the SQL views drop the slash (e.g. **`crm_deal_data`**).
- Regenerate the **renewal-cohort** synthetic enterprise SaaS slice (accounts, renewals, quarterly product usage tiers, customer satisfaction scores) plus a local-only **`renewals-dashboard.html`**:  
  **`npm run data:generate`**  
  (`scripts/generate-enterprise-saas-dummy.mjs`).

#### SQL subagent

When any of the context planner, leaf analyst, or manager emits a `quant_request` (or `suggested_followup_quant_request`), the **SQL subagent** runs a Gemini tool-use loop against an in-process **DuckDB** instance with one view per CSV. Source: **`src/lib/quant/agent.ts`**.

- **Tools** the agent can call: `list_tables`, `describe_table`, `sample_rows`, `run_sql`, `finalize`. Defined in **`src/lib/quant/tools.ts`**.
- **Schema discovery is on-demand** — `describe_table` returns column types plus precomputed enum values for low-cardinality string columns, so the planner doesn't carry the catalog around in every prompt.
- **Safety layer** in **`src/lib/quant/sqlGuard.ts`**: single statement only, must start with `SELECT`/`WITH`, rejects DDL/DML/`ATTACH`/`COPY`/`PRAGMA`/`SET`/etc., auto-injects `LIMIT 1000`. DuckDB has no `statement_timeout` like Postgres — for now the row cap is the backstop; wrap `runSelect` in `Promise.race` + `conn.interrupt()` if you point this at larger data.
- **Caps:** up to **6 turns** and **8 `run_sql` calls** per `runQuantAgent` invocation. Every statement (and any guard rejection) is recorded in `QuantResult.sqlAudit`.
- **Output:** narrative (1–3 sentences with concrete numbers) + the final result table + optional Vega-Lite v5 chart spec, surfaced in the same `QuantResult` shape the leaf UI already renders.
- **DuckDB bootstrap:** in-memory, one `CREATE VIEW … AS SELECT * FROM read_csv_auto(...)` per CSV on cold start (`src/lib/quant/duckdb.ts`). Connection is cached on `globalThis` so it survives HMR. The native bindings are listed in **`next.config.ts → serverExternalPackages`** so Next does not try to bundle the per-platform `.node` files.

### Data model (Prisma)

- **`StrategyRun`** — prompt, **`usePriorRunMemory`** (whether to search prior-run Memory in context; default true), **`discoveryOutput`** (context & clarification brief), outline JSON, **`treeReviewNotes`**, **`clarificationAnswers`** (optional; merged on continue), per-node state (leaves + rolled-up branches), manager/synthesis text, progress log, control fields (**`synthesize_now`** only), legacy **`redirectContext`**, **`synthesisIsPartial`**, token usage JSON, etc.
- **`MemoryArtifact`** — title, summary, topics, full `payload` snapshot (no manager-notes field in payload for new rows), optional `runId`.

### Code map

| Path | Purpose |
|------|---------|
| `src/lib/agents/prompts.ts` | All agent prompt strings (context, tree, leaves, rollup, synthesis, …). |
| `src/lib/orchestrator.ts` | Run state machine, SSE, partial completion, branch rollup, memory writes. |
| `src/lib/strategyMemory.ts` | Optional Memory search + digest for context step. |
| `src/lib/genai.ts` | Google AI client, text vs JSON generation, JSON repair (incl. JSON‑MIME pass), retries. |
| `src/lib/quant/` | DuckDB bootstrap, schema introspection, SQL guard, Gemini tool-use loop (`agent.ts`), chart spec builder. |
| `src/lib/outline.ts` | Outline normalization, leaf flattening, **all node ids**, path labels. |
| `src/components/StrategyConsole.tsx` | UI: hypothesis tree, verdict/confidence/evidence per node, rollup labels, EventSource, memory. |
| `src/components/MarkdownBody.tsx` | Renders memo markdown in the browser. |
| `scripts/generate-enterprise-saas-dummy.mjs` | Regenerate `data/dummy_data/**/*.csv` (loaded as DuckDB views at runtime). |

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
4. Long runs: this app sets `maxDuration = 800` on the stream route (`src/app/api/runs/[id]/stream/route.ts`). Hobby plans cap lower; Pro lets you use long durations — also confirm **Function max duration** in the Vercel project settings if runs still cut off early.
5. If you see **“This run is already executing…”** after a refresh: the DB still had `running` from a **dead** serverless invocation (timeout, deploy, closed tab). Wait for the stale window or set **`STALE_RUNNING_MS`** (on Vercel the default recovery window is shorter than local). **Continue pipeline** after reconnect resumes from the inferred checkpoint. The UI now keeps a **single EventSource**, reconnects after **~28–32s** when the run is still `running` (aligned with that stale window), and sends a per-tab **`sid`** so the server can tell same-tab reconnects from other sessions.
6. After pulling schema changes, run **`npx prisma migrate deploy`** against production (Vercel build already runs `prisma generate`).
