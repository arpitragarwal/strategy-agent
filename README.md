# Strategy team prototype

Multi-agent strategy pipeline with **Server-Sent Events** for live progress, **PostgreSQL** for run state, and an optional **Memory** repository (search-on-demand, like an internal knowledge lookup). Prototype **CSV datasets** under `data/dummy` back in-app quantitative checks (Arquero).

## Agent architecture

All steps are orchestrated in **`src/lib/orchestrator.ts`**. Each “agent” is a **prompt + model call** (text or JSON), not a separate process. The same model ID is used unless you change code.

### Pipeline (happy path)

| Stage | Role | Output |
|--------|------|--------|
| **Discovery** | Optionally **searches Memory** (model decides via a small JSON route + keyword scan of recent artifacts), then surfaces themes, risks, opportunities, and open questions from the user’s goal. | Markdown |
| **Structure (v1)** | Builds an initial **MECE JSON tree** (`roots` → nested `children`; leaves have `children: []`). Parses alternate shapes via `normalizeOutlineDoc`; retries once if empty. | JSON → outline |
| **Manager MECE review** | Reviews coverage, overlaps, and gaps of the **draft tree only** (no leaf analyses yet). | Markdown → `treeReviewNotes` |
| **Structure (revised)** | Rebuilds the full tree JSON from **structure revision** prompt using manager feedback; falls back to v1 if revision JSON is invalid. | JSON → final outline |
| **Analysis** (loop) | One call **per leaf** on the **revised** tree: JSON (`summary`, `analysis`, `hypothesis`, **`evidence_needed`** data/context gaps, `confidence`, optional **`quant` plan**). **Redirect** notes go to `redirectContext` for later leaves. | JSON per leaf |
| **Manager (analyses)** | Pressure-tests the combined leaf analyses. | Markdown |
| **Synthesis** | Executive memo from discovery + manager + analyses. | Markdown |

JSON-heavy steps use **`generateJson`** with repair hints and parsing fallbacks (`src/lib/json.ts`) because small models often ignore JSON MIME types. **`generateText` / `generateJson`** also **retry transient API and network errors** with backoff (see **`GOOGLE_AI_MAX_RETRIES`** in `.env.example`).

### User controls (while `status === running`)

Checked **after discovery**, **after initial outline**, **after revised outline**, and **before each leaf** (the current LLM call always finishes first).

- **Synthesize so far** — Stops early: marks remaining leaves `skipped`, runs **partial manager** + **partial synthesis**, saves run and a **memory** row tagged partial.
- **Apply redirect** — Appends a steering note to `redirectContext` on the run; **subsequent leaf analyses** see it in the prompt.

Controls: `PATCH /api/runs/[id]/control` with `{ "action": "synthesize_now" }` or `{ "action": "redirect", "note": "..." }`.

### Memory

- **Writes:** On completion (full or partial), a **`MemoryArtifact`** row is saved (synthesis excerpt, topics, outline + node states, discovery — **not** manager critique text).
- **Reads:** Discovery **does not** preload memory. A routing step may request a **targeted search** over recent artifacts (`src/lib/strategyMemory.ts`); hits are passed into the main discovery prompt only when relevant.

### Prototype data & quant

- CSVs live in **`data/dummy/`** (CRM, finance, CX, support). The app’s catalog is **`src/lib/quant/catalog.ts`**; analysis agents reference dataset IDs such as **`crm/accounts`** or **`finance/pnl_monthly`**.
- Regenerate the **~$200M ARR / ~2K logo** synthetic SaaS universe (aligned rollups across CRM, finance, support, and CX):  
  **`npm run data:generate`**  
  (`scripts/generate-enterprise-saas-dummy.mjs`).

### Data model (Prisma)

- **`StrategyRun`** — prompt, discovery, outline JSON, **`treeReviewNotes`** (manager feedback on the MECE tree), per-node state, manager/synthesis text, progress log, optional control fields, `synthesisIsPartial`, etc.
- **`MemoryArtifact`** — title, summary, topics, full `payload` snapshot (no manager-notes field in payload for new rows), optional `runId`.

### Code map

| Path | Purpose |
|------|---------|
| `src/lib/agents/prompts.ts` | All agent system/user prompt strings. |
| `src/lib/orchestrator.ts` | Run state machine, SSE events, partial completion, memory writes. |
| `src/lib/strategyMemory.ts` | Optional Memory search + digest formatting for discovery. |
| `src/lib/genai.ts` | Google AI client, text vs JSON generation, JSON repair, retries. |
| `src/lib/quant/` | Dataset paths, CSV load, declarative **quant** plan execution (Arquero). |
| `src/lib/outline.ts` | MECE normalization, leaf flattening, path labels. |
| `src/components/StrategyConsole.tsx` | UI (MECE tree, strategy-question header, collapsible branches), EventSource, memory load. |
| `src/components/MarkdownBody.tsx` | Renders memo markdown in the browser. |
| `scripts/generate-enterprise-saas-dummy.mjs` | Regenerate `data/dummy/*.csv` for end-to-end tests. |

## Model (open-weight Gemma 4)

The app uses Google’s **Generative Language API** (`@google/generative-ai`) with a **model ID** you choose. That is the same API/key as “Gemini API,” but you should point it at **Gemma 4** (open-weight models Google hosts), e.g. `gemma-4-26b-a4b-it` or `gemma-4-31b-it`. Set `GOOGLE_AI_MODEL` in `.env` to the **smallest** Gemma 4 variant your [AI Studio](https://aistudio.google.com) project lists — that is usually cheaper than large proprietary Gemini models. See [Run Gemma with the Gemini API](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api).

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
