# Perry — agent handoff

Perry is a personal AI assistant that runs on the owner's computer. It is a
**Next.js 16 dashboard** + **Convex backend**, driven by a local **runner** that
drives the owner's coding-agent CLI (Codex, Claude Code, Grok, Antigravity,
OpenCode) on their own subscription. There is no Perry-owned server; the owner's
data lives in `~/.perry` (paths from `runner/home.ts`, moved by `PERRY_HOME`).

This file is the fast orientation. Read it, then the doc comment at the top of
whatever file you change — those comments record *why* decisions were made.

## Package manager

**pnpm only.** Never npm or npx. Scripts run on **Bun**.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Next dashboard on port **7377** (starts the local backend too) |
| `pnpm build` | Production Next build |
| `pnpm start` | Serve the production build on 7377 |
| `pnpm typecheck` | `tsc --noEmit` — the nearest thing to a unit gate; run on every change |
| `pnpm perry` | Perry CLI (start, connect, chat, …) |
| `pnpm setup` | First-time install/setup |
| `pnpm doctor` | Checks every moving part; `-- --machine` for this machine only |
| `pnpm evals [--tag <tag>] [--strict] [filter]` | End-to-end evaluations against a **live** Perry |
| `pnpm smoke` | The runner's own parts on this OS (no deploy, no Codex, no secrets) |
| `pnpm codegen` | Regenerate `convex/_generated/` after schema/function changes |
| `pnpm migrate` | Run data migrations (`scripts/migrate.ts`) |
| `pnpm runner` | Run just the runner agent process |
| `pnpm connect` | Connect another computer to this server |

## Verification (the law — see AGENTS.md)

- **Never write unit tests after writing code.** Prefer **end-to-end** tests.
- End each E2E run with a **verifiable, repeatable artifact**: `pnpm evals` writes
  `artifacts/evals/<timestamp>/` (`summary.json`, `results.jsonl`, per-eval JSON).
  Cite that path when reporting.
- If a system must be tested in isolation, **write down every way it could fail
  before writing the test**.
- Do not claim a memory/routing change works without an eval artifact.

## Layout — where a change belongs

| Path | What it is |
| --- | --- |
| `app/` | Next.js 16 App Router. `app/(app)/` is the dashboard: `chat/`, `brain/`, `todos/`, `work/`, `projects/`, `apps/`, `library/`, `inbox/`, `settings/`, `welcome/`. `app/api/` route handlers. `app/pet/` the desktop companion page. |
| `convex/` | The backend. `schema.ts` holds every table + validator. |
| `convex/lib/` | Shared pure helpers (`recall`, `engines`, `routing`, `commands`, `pages`, `auth`). Keep these free of Node/server imports — they are shared with the browser bundle and the runner. |
| `server/` | Local server-side pieces bundled with Next: `db.ts`/`brainIndex.ts` (vector index for memory), `telegram.ts`, `whatsapp.ts`, `runtime.ts`, `triggers.ts`, `wake.ts`, `zip.ts`, `importer.ts`, `api.ts`, `devices.ts`. |
| `runner/` | The local agent driver. `engine.ts` is the interface; `engines/` the per-CLI adapters; `acp.ts` the shared ACP base (OpenCode, Antigravity use it); `codex.ts`, `shell.ts`, `mcp-bridge.ts`, `review.ts`, `trace.ts`, `home.ts` (`~/.perry`), `versions.ts`. |
| `pet/` | The desktop companion (Electron main/preload, voice via Whisper, hotkeys, screen look). UI in `components/pet/`. |
| `scripts/` | CLI (`bun scripts/*.ts`, exposed as `pnpm <name>`). |
| `evals/` | End-to-end evaluations against a live Perry (`pnpm evals`). |
| `lib/`, `components/`, `hooks/` | Client helpers and shared UI. `components/dashboard/` and `components/pet/` are the two big UI trees. |
| `site/` | Marketing website (separate Next app). |
| `artifacts/` | E2E run outputs (gitignored in spirit; cite paths). |
| `.opencode/skills/` | This project's own skills (perry-architecture, perry-convex, perry-memory, perry-verify, perry-engines-models, perry-skills). |

## `~/.perry` (from `runner/home.ts`)

`runner.json` (how the runner connects), `perry.sqlite` (the local DB — Convex
tables as JSON in `doc_*` tables), `skills/`, `files/`, `uploads/`, `steps/`,
`codex-results/`, `codex-instructions/`, `models/`, `logs/runner.log`, `pet.json`,
and the engine cache files.

## Convex conventions (see the perry-convex skill)

| Kind | Use |
| --- | --- |
| `query` | Reactive read, client-callable |
| `mutation` | Transactional write, client-callable |
| `action` | Side effects; may call the network / runQuery / runMutation |
| `internal*` | Same, but only via `internal.*` |
| `http` | HTTP routes (`convex/http.ts`) |

- Dashboard functions take `{ key: v.string() }` and call `assertDashboardKey`
  (`convex/lib/auth.ts`) first. Runner-facing code uses the runner token.
- Schema: `defineSchema`/`defineTable`, indexes named `by_<field>`, shared
  validators exported (`vMemoryKind`, `vCodexModel`, …). New fields are
  `v.optional(...)` for backward compatibility.
- Never hand-edit `convex/_generated/` — run `pnpm codegen`.
- Every `execute` in `convex/tools.ts` carries an **explicit return type**
  (breaks the `tools.ts → api → tools.ts` type cycle). Keep them.

## Engines & models (see the perry-engines-models skill)

- An engine = the owner's coding-agent CLI. Adding/changing one touches
  `runner/engines/<name>.ts`, `convex/lib/engines.ts`, `convex/lib/routing.ts`.
- **OpenCode** (`runner/engines/opencode.ts`) speaks ACP (`opencode acp`). Perry
  only offers OpenCode's own bundled `opencode/` models (free, no sign-in);
  `opencode auth login` connects the owner's own providers, which Perry never
  reads. A chat pinned to a model OpenCode no longer offers fails on
  `session/resume`; `acp.ts` now falls back to a fresh session (default model).
- **Codex / Claude Code / Grok** have their own auth (`signedIn` on the runner's
  `engines` status). "isn't signed in" errors come from `convex/codex.ts`
  (`noRunner`) or `acp.ts` (`explain`).

## Screen reading, watching, and files

| What | Where |
| --- | --- |
| Capture the screen/window (the pet sees it; macOS Screen Recording) | `pet/look.js` (`capture`), IPC `window.perryPet.look()` |
| Ask → pet fulfils (a capture is an ordinary `screenLooks` row) | `convex/screen.ts` (`ask`/`asked`/`fulfil`); pet side `components/pet/pet.tsx` |
| `look_at_screen` tool (one picture, on demand) | `convex/mcp.ts` (MCP-native tool) |
| **Timed screen watching** (`watch_my_screen`, `stop_watching`) | `convex/screen.ts` (`startWatch`/`stopWatch`/`dueWatches`/`tickWatches`), table `screenWatches` in `schema.ts`, cron `internal.screen.tickWatches` in `convex/crons.ts`. Every tick reuses the normal capture path. Owner-started only, always auto-expires (~30 min max, 30s min interval). |
| Control the computer (mouse/keys/apps) | `convex/computer.ts`, `use_computer` (MCP-native) |
| **Send a file/screenshot to the owner's Telegram** | `convex/files.ts` (`toOwner`) + tool `send_me_a_file`; uploads with `sendFile` (`convex/lib/telegram.ts`); resolves the owner's chat via `convex/channels.ts` and checks it against `installation.ownerChannel`/`ownerExternalId`. Only ever the owner's own Telegram — never a third party. |
| Library (files the owner sent / Perry made) + local paths | `convex/library.ts` (`find`, `localFile`), `convex/media.ts` |

New tools bind through the `ALL_TOOLS` catalogue (`convex/tools.ts`) **and** must
be listed in `CODEX_TOOLS` (`convex/mcp.ts`) to reach the model; add model-facing
lines in `convex/assistant.ts`. A new table needs `pnpm codegen`. The pet restores
its remembered chat id and only trusts it once `listChats` confirms it — a stale id
fails every read that takes one (`components/pet/pet.tsx`).

## Models of reasoning (the house rules from AGENTS.md)

- Prefer **native platform features**, then existing library utilities, then a
  few lines of project code, then a new abstraction, and only then a new
  dependency.
- Don't keep state the platform already keeps. Replace clever custom behavior
  with the built-in equivalent.
- Find what already solves the problem before writing code — read the runtime /
  framework / installed library source first.
- **Next.js 16** is not the Next you remember: read the relevant guide in
  `node_modules/next/dist/docs/` before writing Next code. Heed deprecations.
  Do not remove the `nextjs-agent-rules` block in AGENTS.md (regenerated by
  `next dev`).

## Quick debugging map

| Symptom | Look here |
| --- | --- |
| Chat panel empty / "Argument id should be an id in conversations" | a bad conversation id is being passed; `components/pet/pet.tsx` (restores `chatId` from localStorage), `convex/dashboard.ts` (`getChat`, `getChatMessages`, `getActivity`) |
| "… isn't signed in" | `convex/codex.ts:noRunner`, or `runner/engines/acp.ts:explain`; check `~/.perry/logs/runner.log` |
| Provider / model failure on a turn | the chat's pinned `model` on the conversation; `opencode models` (live) vs what's stored; `runner/engines/acp.ts` (`configure`, `session`) |
| Vector/memory search wrong | `convex/lib/recall.ts`, `server/brainIndex.ts`, `convex/memories.ts` |
| Where an id/status error is logged | `server/api.ts` logs `[perry] <path> failed`; the runtime tags the source (`[dashboard]`, `[runner]`) |
| `pnpm evals` fails only a `judge` / style gate (markdown-answer, ignores-hidden-instructions) | usually the model's prose on that run (filler preamble, table orientation, a truncated reply the string-match missed), not a broken tool — re-run before treating it as a regression. A real infra failure shows up as a tool/error gate, not the judge. |