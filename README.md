# Strategy team prototype

Multi-agent strategy pipeline with **Server-Sent Events** for live progress, **PostgreSQL** for run state, and **memory artifacts** so later runs can reuse prior work.

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

## Model (open-weight Gemma 4)

The app uses Google’s **Generative Language API** (`@google/generative-ai`) with a **model ID** you choose. That is the same API/key as “Gemini API,” but you should point it at **Gemma 4** (open-weight models Google hosts), e.g. `gemma-4-26b-a4b-it` or `gemma-4-31b-it`. Set `GOOGLE_AI_MODEL` in `.env` to the **smallest** Gemma 4 variant your [AI Studio](https://aistudio.google.com) project lists — that is usually cheaper than large proprietary Gemini models. See [Run Gemma with the Gemini API](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api).

Legacy env name `GEMINI_MODEL` is still read if `GOOGLE_AI_MODEL` is unset.

## Deploying on Vercel

1. Create a Vercel project from this repo.
2. Add environment variables: `GOOGLE_AI_API_KEY`, `GOOGLE_AI_MODEL`, `DATABASE_URL` (Neon pooled URL recommended).
3. Build command: `prisma generate && next build` (already in `npm run build`).
4. Long runs: this app sets `maxDuration = 300` on the stream route; on Hobby, Vercel may cap execution time lower — upgrade or move orchestration to a background worker if runs time out.

## Agent architecture

All steps are orchestrated in **`src/lib/orchestrator.ts`**. Each “agent” is a **prompt + model call** (text or JSON), not a separate process. The same model ID is used unless you change code.

### Pipeline (happy path)

| Stage | Role | Output |
|--------|------|--------|
| **Discovery** | Surfaces themes, risks, opportunities, open questions from the user’s single prompt plus **prior memory** summaries. | Markdown |
| **Structure (v1)** | Builds an initial **MECE JSON tree** (`roots` → nested `children`; leaves have `children: []`). Parses alternate shapes via `normalizeOutlineDoc`; retries once if empty. | JSON → outline |
| **Manager MECE review** | Reviews coverage, overlaps, and gaps of the **draft tree only** (no leaf analyses yet). | Markdown → `treeReviewNotes` |
| **Structure (revised)** | Rebuilds the full tree JSON from **structure revision** prompt using manager feedback; falls back to v1 if revision JSON is invalid. | JSON → final outline |
| **Analysis** (loop) | One call **per leaf** on the **revised** tree: JSON (`summary`, `analysis`, `hypothesis`, `evidence_needed`, `confidence`). **Redirect** notes go to `redirectContext` for later leaves. | JSON per leaf |
| **Manager (analyses)** | Pressure-tests the combined leaf analyses. | Markdown |
| **Synthesis** | Executive memo from discovery + manager + analyses. | Markdown |

JSON-heavy steps use **`generateJson`** with repair hints and parsing fallbacks (`src/lib/genai.ts`, `src/lib/json.ts`) because small models often ignore JSON MIME types.

### User controls (while `status === running`)

Checked **after discovery**, **after initial outline**, **after revised outline**, and **before each leaf** (the current LLM call always finishes first).

- **Synthesize so far** — Stops early: marks remaining leaves `skipped`, runs **partial manager** + **partial synthesis**, saves run and a **memory** row tagged partial.
- **Apply redirect** — Appends a steering note to `redirectContext` on the run; **subsequent leaf analyses** see it in the prompt.

Controls: `PATCH /api/runs/[id]/control` with `{ "action": "synthesize_now" }` or `{ "action": "redirect", "note": "..." }`.

### Memory

On completion (full or partial), a **`MemoryArtifact`** row is created. The next run’s **discovery** step includes the latest summaries so the pipeline can build on past work.

### Data model (Prisma)

- **`StrategyRun`** — prompt, discovery, outline JSON, **`treeReviewNotes`** (manager feedback on the MECE tree), per-node state, manager/synthesis text, progress log, optional control fields, `synthesisIsPartial`, etc.
- **`MemoryArtifact`** — title, summary, topics, full `payload` snapshot, optional `runId`.

### HTTP API

| Endpoint | Purpose |
|----------|---------|
| `POST /api/runs` | Create run (`{ "prompt": "..." }` — goal and context in one block). |
| `GET /api/runs/[id]/stream` | **SSE** — executes the pipeline once and streams events. |
| `GET /api/runs/[id]` | Fetch a single run (for reloading saved state). |
| `PATCH /api/runs/[id]/control` | Queue synthesize-now or redirect while running. |
| `GET /api/memory` | List recent memory rows. |
| `GET /api/memory/[id]` | Load one artifact (full `payload`). |

### Code map

| Path | Purpose |
|------|---------|
| `src/lib/agents/prompts.ts` | All agent system/user prompt strings. |
| `src/lib/orchestrator.ts` | Run state machine, SSE events, partial completion, memory writes. |
| `src/lib/genai.ts` | Google AI client, text vs JSON generation, JSON repair. |
| `src/lib/outline.ts` | MECE normalization, leaf flattening, path labels. |
| `src/components/StrategyConsole.tsx` | UI, EventSource client, memory click-to-load. |
| `src/components/MarkdownBody.tsx` | Renders memo markdown in the browser. |
