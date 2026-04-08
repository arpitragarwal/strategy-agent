# Strategy team prototype

Multi-agent strategy pipeline (discovery → MECE structure → per-leaf analysis → manager critique → synthesis) with **Server-Sent Events** for live progress, **PostgreSQL** for run state, and **memory artifacts** fed into the next discovery pass.

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

## Architecture

- `POST /api/runs` — create a pending run.
- `GET /api/runs/[id]/stream` — SSE; executes the pipeline once and streams events.
- `GET /api/memory` — list saved summaries from completed runs.

Agents and prompts live under `src/lib/agents/` and `src/lib/orchestrator.ts`.
