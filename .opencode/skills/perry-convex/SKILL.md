---
name: Perry Convex conventions
description: Use when editing Convex functions or schema in convex/ — function kinds, internal vs public, auth, indexes, codegen/migrate, and the tools.ts return-type cycle.
---

# Perry Convex conventions

The backend under `convex/` is Convex (note: `convex` is also a dependency at
`^1.46.0`). Follow the local patterns; do not invent shapes.

## Function kinds

| Kind | Use |
| --- | --- |
| `query` | Reactive read. Client-callable. |
| `mutation` | Transactional write. Client-callable. |
| `action` | Side effects, may `runQuery`/`runMutation`, may call the network. |
| `internalQuery` / `internalMutation` / `internalAction` | Same, but only reachable from other server code via `internal.*`. |
| `http` | HTTP routes (`convex/http.ts`). |

Server-to-server calls use `internal` from `convex/_generated/api.ts`.
Client code uses `api`.

## Auth

Dashboard-facing functions take `{ key: v.string() }` and call
`assertDashboardKey(args.key)` (`convex/lib/auth.ts`) first. Runner-facing code
uses the runner token; `convex/validate.ts` holds other validators. Never add a
public function that reads or writes owner data without one of these.

## Schema (`convex/schema.ts`)

- Every table is defined with `defineSchema` / `defineTable` and indexed with
  `.index("by_…", [...])`. Match the existing `by_<field>` naming.
- Reusable validators are exported (`vMemoryKind`, `vLineKind`, `vPageKind`,
  `vUsage`, `vCodexModel`, …). Add a validator rather than inlining a union when
  it is shared.
- New fields are `v.optional(...)` for backward compatibility with existing rows.
- The vector index for memory is kept **outside** the row: see `server/db.ts` and
  `server/brainIndex.ts`; the row keeps `embeddedWith`/`vectorKey` only.

## Generated code

`convex/_generated/` is generated. Change `schema.ts`/functions and run
`pnpm codegen`; never hand-edit generated files. `pnpm migrate` runs
`scripts/migrate.ts` for data migrations.

## The `tools.ts` return-type rule

Every `execute` in `convex/tools.ts` carries an **explicit return type**. Without
it, TypeScript chases `tools.ts → _generated/api → tools.ts` and gives up with an
implicit `any`. The annotations break the cycle — keep them.

## Style

- The top-of-file doc comment records *why* (often citing an issue number). Read
  it before editing; extend it when you change the behavior it describes.
- "Pure, with no server imports" files (e.g. `convex/lib/recall.ts`,
  `convex/lib/engines.ts`, `convex/lib/commands.ts`, `convex/lib/pages.ts`) are
  shared with the browser bundle or runner. Keep Node/server imports out.
- Prefer named exports and small pure helpers; the repo favors plain functions
  over new abstractions (see `AGENTS.md`).

## Verifying Convex changes

`pnpm typecheck`, then `pnpm evals` against a live runner. Schema changes that
touch data want `pnpm migrate` and a check on an existing install, not only a
fresh one (legacy rows without `kind` are handled in `memories.ts` as core).
