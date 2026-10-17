---
name: Perry architecture
description: Use when working anywhere in the Perry codebase. Maps app/, convex/, server/, runner/, pet/, scripts/ and evals/, and says where a change belongs.
---

# Perry architecture

Perry is a personal AI assistant that runs on the owner's own computer. It is a
**Next.js 16 dashboard** plus a **Convex backend**, driven by a local **runner**
that talks to the owner's own coding-agent CLI (Codex, Claude Code, Grok Build,
Antigravity) on their subscription. Nothing is Perry's own server; the owner's
data lives in `~/.perry` (paths from `runner/home.ts`, moved by `PERRY_HOME`).

## Layout

| Path | What it is |
| --- | --- |
| `app/` | Next.js 16 App Router. `app/(app)/` is the dashboard: `chat/`, `brain/`, `todos/`, `work/`, `projects/`, `apps/`, `library/`, `inbox/`, `settings/`, `welcome/`. `app/api/` are route handlers; `app/pet/` the desktop companion page. |
| `convex/` | The backend. Data layers and behavior (see `perry-convex` skill). `schema.ts` holds every table and validator. |
| `server/` | Local server-side pieces bundled with the Next server: `db.ts`/`brainIndex.ts` (vector index for memory), `telegram.ts`, `whatsapp.ts`, `runtime.ts`, `triggers.ts`, `wake.ts`, `zip.ts`, `importer.ts`. |
| `runner/` | The local agent driver. `engine.ts` is the interface, `engines/` the per-CLI adapters, `codex.ts`, `shell.ts`, `mcp-bridge.ts` (Perry's tools as MCP to the engine), `review.ts`, `trace.ts`, `home.ts` (`~/.perry`), `versions.ts`. |
| `pet/` | The desktop companion (voice via Whisper, hotkeys, screen look). |
| `scripts/` | CLI (`bun scripts/*.ts`, exposed as `pnpm perry`, `pnpm doctor`, `pnpm evals`, …). |
| `evals/` | End-to-end evaluations against a live Perry (`pnpm evals`; see `perry-verify`). |
| `lib/`, `components/`, `hooks/` | Client-side helpers and UI shared with the dashboard. |
| `site/` | Marketing website (separate Next app). |

## Where a change belongs

| Change | Touch |
| --- | --- |
| Memory behavior, recall quality, embeddings | `convex/memories.ts`, `convex/lib/recall.ts`, `convex/lib/embed.ts` (see `perry-memory`) |
| The prompt: instructions, memory injection | `convex/brain.ts`, `convex/persona.ts` |
| Memory UI | `app/(app)/brain/` |
| A new agent tool | `convex/tools.ts`, then bind it in `convex/lib/agent.ts` / the mode binding in `convex/agents.ts`-style catalog |
| Perry's own Skills feature | `convex/lib/skills.ts`, `convex/skills.ts`, `~/.perry/skills` (see `perry-skills`) |
| An engine or a model | `runner/engines/<name>.ts`, `convex/lib/engines.ts`, `convex/lib/routing.ts` (see `perry-engines-models`) |
| Scheduled jobs / reminders | `convex/jobs.ts`, `convex/crons.ts`, `server/triggers.ts` |
| Local server / storage | `server/` |
| Dashboard route or UI | `app/(app)/<route>/`, `components/` |

## `~/.perry` (from `runner/home.ts`)

`runner.json` (how the runner connects), `skills/` (the folder every engine is
pointed at), `files/`, `uploads/`, `steps/`, `codex-results/`,
`codex-instructions/`, `models/` (local embedding/voice models), `logs/`, and
the engine cache files.

## Commands

`pnpm dev` (Next on 7377) · `pnpm build` · `pnpm typecheck` · `pnpm perry` ·
`pnpm setup` · `pnpm doctor` · `pnpm evals` · `pnpm smoke` · `pnpm codegen` ·
`pnpm migrate`.

## Conventions

- **pnpm**, never npm. Scripts run on **Bun** (`bun scripts/*.ts`).
- **Next.js 16** is not the Next you may remember: read the relevant guide in
  `node_modules/next/dist/docs/` before writing Next code.
- Modules described as "pure, with no server imports" (e.g. `convex/lib/engines.ts`,
  `convex/lib/recall.ts`, `convex/lib/commands.ts`, `convex/lib/pages.ts`) are
  shared by the server **and** the browser bundle or runner — keep them free of
  Node/server imports.
- Doc comments here are unusually load-bearing: read the block at the top of a
  file before changing it. They record why a decision was made and cite issues.
