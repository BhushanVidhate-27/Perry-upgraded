---
name: Perry verification
description: Use before claiming a Perry change works — the pnpm evals / typecheck / smoke / doctor gate, and the AGENTS.md end-to-end rule.
---

# Perry verification

`AGENTS.md` is the law here: **never write unit tests after writing code**;
prefer **end-to-end** tests; end each E2E run with a **verifiable, repeatable
artifact**; if a system must be tested in isolation, write down every way it
could fail *before* writing the test.

## The gate

| Command | What it checks |
| --- | --- |
| `pnpm typecheck` | `tsc --noEmit`. The nearest thing to a unit gate; run it on every change. |
| `pnpm evals [--tag <tag>]… [--strict] [--judge-model <model>] [filter]…` | Every `evals/*.eval.ts` against a **live Perry**, one at a time. |
| `pnpm smoke` | The runner's own parts on this OS (no deployment, no Codex, no secrets). Cross-platform. |
| `pnpm doctor` | Checks every moving part and says which is broken. `-- --machine` for this machine only. |

## Evals (`evals/run.ts`)

- **Needs a runner online with `--auto`** — the owner's, or a short-lived test
  runner whose token is passed with `--runner-token`.
- A **filter** matches an eval id (its path under `evals/` without `.eval.ts`) or
  a folder of them; `--tag` keeps the evals carrying it.
- **Exit codes**: `0` all gates passed (and, with `--strict`, all soft bars);
  `1` an eval failed; `2` nothing matched or Perry was unreachable.
- It writes `artifacts/evals/<timestamp>/` — `summary.json`, `results.jsonl`, and
  one JSON per eval. **That directory is the repeatable artifact** the rule asks
  for; cite it when you report.

Memory work maps to: `pnpm evals --tag memory` (runs
`remembers-and-recalls` and `keeps-secrets`), `pnpm evals remembers-and-recalls`.
New evals use `defineEval` (`evals/eval.ts`), `evals/expect.ts`, and fixtures in
`evals/fixtures.ts` (`inventedWord`, `memoriesContaining`,
`deleteMemoriesContaining`).

## How to work

1. Read the relevant skill (`perry-memory`, `perry-convex`, …) and the file's doc
   comment before changing code.
2. Make the smallest change that fixes the problem. Prefer the platform, then a
   library, then a few lines — **not** a new abstraction or dependency.
3. `pnpm typecheck`.
4. Run the narrowest eval that covers it, then the wider tag, against a live
   runner. Keep the `artifacts/evals/<timestamp>/` path.
5. Report what changed and the exact command + artifact that proves it. If you
   could not run an eval (no runner), say so plainly instead of implying success.

## Do not

- Add a `*.test.ts` / unit test to assert a change.
- Claim a memory or routing change works without an eval artifact.
- Run evals against the owner's live Perry without a runner that is set up for it.
