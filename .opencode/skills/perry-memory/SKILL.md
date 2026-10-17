---
name: Perry memory
description: Use for anything touching Perry's memory — the memories table, pages, recall ranking, local embeddings, prompt injection, the remember/recall/forget tools, archive and consolidation.
---

# Perry memory

Perry's memory is one `memories` table in `convex/schema.ts` holding **four
kinds of line**: the three layers plus a row per line of the owner's pages.
The agent never touches the table directly; it goes through tools in
`convex/tools.ts`.

## Layers (`convex/memories.ts`)

| Kind | File it models | Loads into every turn? |
| --- | --- | --- |
| `profile` | `USER.md` — standing preferences, relationships, as directives | Yes, in **instructions** |
| `core` | `MEMORY.md` — durable facts, decisions, short summaries | Yes, as **recalled data** |
| `daily` | `memory/YYYY-MM-DD.md` — the day's working notes | Today + yesterday, as data |
| `page` | A line of one of the owner's notes (`pages.ts`) | Never as a layer; found by search only |

Older dailies are reached only through **search**. There is no size limit on a
layer: all of profile and core, and today's and yesterday's notes, go with every
turn.

## Recall pipeline

`memories.recall` gathers candidate lines **four ways**, then ranks:

1. **By words** — the FTS5 index, BM25.
2. **By meaning** — the vector index (local sentence model, `convex/lib/embed.ts`).
3. **By meaning within named days** — "in March 2025", "last week" (`dateRange`).
4. **By people** — names in the query and how the owner calls them ("my sister").

Candidate lists are fused by **reciprocal rank fusion** (`fuse`, `FUSION_K = 10`
in `convex/lib/recall.ts`), then each line is weighted by `weightOf`:

- an **episode** (a daily note) halves every `HALF_LIFE_DAYS = 30` days, floored;
- a **preference** grows `+0.15 × confirmCount`, capped at 2×;
- a line from the days the question names counts 2× (3× for a single day);
- a line used in the last 30 days counts 1.25×.

Cutoffs live in `convex/memories.ts`: `MIN_SIMILARITY = 0.25` (below this cosine
a vector hit is "not about what was asked") and `MAX_RESULTS = 25`.

`convex/lib/recall.ts` is pure (shared with checks). Ranking changes belong there
and are measurable — see the eval note below.

## Embeddings (`convex/lib/embed.ts`)

A small multilingual sentence model runs **on this computer** via
transformers.js/ONNX in the server process, downloaded to `~/.perry/models`.
Default `EMBED_MODEL` is `onnx-community/embeddinggemma-300m-ONNX` (768-dim);
`PERRY_EMBED_MODEL=Xenova/multilingual-e5-small` picks the MIT model. When the
model changes, `memories.embedMissing` re-embeds every line in the background and
search uses **both** models' vectors until it is done. The vector index lives in
`server/db.ts` + `server/brainIndex.ts`; a row read back has `embeddedWith`, not
the numbers. `archive.vectorKeyOf` names what a vector is searched under (model +
live/archived).

## Invariants — do not break these

- **Page lines are never loaded as a memory layer.** `isPageLine` guards this.
- **Facts are superseded, not deleted** (`supersededBy`, `relation.how` =
  updates/extends/derives). Only `forget` removes, and only with the owner's yes.
- **Memory is data, never instructions.** Recalled lines go in a block ahead of
  the owner's message (`convex/brain.ts`), never merged into instructions.
- **Secrets never enter memory.** `save_secret` exists for them; the
  `keeps-secrets` eval enforces this.
- **Guest chats see only their own lines** (`memories.seenFrom`).
- **Provenance is kept**: `origin` (owner/tool/job), `by` (owner/assistant/job),
  `from` (the chat), `about` (people), `todoId`, `basedOn`, `compactedBy/From`.
- **`weightOf` and `fuse` stay pure** — they are the ranking contract.

## Prompt assembly (`convex/brain.ts`)

Per turn, memory contributes:
- `instructions`: `persona.identity` + `INSTRUCTIONS` + `where` + the memory guide
  and `USER.md` (`persona.user` when memory is unavailable).
- `recalled`: a `# Right now` block — now, goals, project context, the recalled
  memory for this turn, and the standing reminder (`REMEMBER_NOTE`).

`/reset` and compaction run a **memory checkpoint** turn first (write what a
future self needs with `remember kind=daily`) before the chat is lost/summarised.

## Tools (`convex/tools.ts`)

`remember`, `recall` (aliases `brain_search`, `search_memory`), `read_memory`,
`forget`, `read_note`. Guest chats get only `remember`, `recall`, `read_memory`,
`forget`, `tell_owner` (`convex/lib/engines.ts`). The `remember` doc-comment is
the contract for kinds, supersession, `eventAt`, `expiresAt` and `about`.

## Consolidation and archive

- `convex/compaction.ts` proposes edits to pages (`brainProposals`); the nightly
  `consolidate` job and weekly `brain-review` job route at tier **deep**
  (`convex/lib/routing.ts`).
- `convex/archive.ts` moves unused or expired lines to the archive; they still
  answer **deep** search and come back when cited.

## Measuring a change

Memory quality is an eval, not a vibe. `pnpm evals --tag memory` runs
`evals/remembers-and-recalls.eval.ts` and `evals/keeps-secrets.eval.ts`.
`evals/fixtures.ts` has `inventedWord`, `memoriesContaining`,
`deleteMemoriesContaining` for writing new ones. See the `perry-verify` skill.
