---
name: Perry engines and models
description: Use when adding or changing an engine (Codex, Claude Code, Grok, Antigravity) or model routing — runner/engines/, convex/lib/engines.ts, convex/models.ts, convex/lib/routing.ts, convex/lib/commands.ts.
---

# Perry engines and models

The owner picks which coding-agent CLI thinks for Perry. Perry never proxies a
vendor's sign-in and never sees tokens — the CLI keeps credentials on the
computer. Model catalogue comes from a signed-in **runner** that reports what its
CLI offers.

## Engines (`convex/lib/engines.ts` — pure, browser-safe)

- `ENGINES = ["codex", "claude", "grok", "cursor", "antigravity"]` — the kinds
  that can be named and stored.
- `RUNNABLE_ENGINES = ["codex", "claude", "grok", "antigravity"]` — the ones
  `runner/engines/` drives today (Cursor is named so rows can hold it, but not
  runnable).
- `ENGINE_LABELS`, `SIGN_IN_LABELS`, `MINIMUM_VERSIONS`, `CLI_PACKAGES`.
- `modelKey`/`parseModelKey` — `"<engine>/<model id>"`.
- `LOCKED_DOWN_BEFORE` / `GUEST_TOOLS` — a chat with someone else runs locked
  down, with only `remember`, `recall`, `read_memory`, `forget`, `tell_owner`.

### Adding an engine

1. Add the adapter under `runner/engines/<name>.ts` (implement `runner/engine.ts`).
2. Register it in `runner/engines/index.ts`.
3. Add the kind to `ENGINES` and (if runnable) `RUNNABLE_ENGINES`,
   `ENGINE_LABELS`, `SIGN_IN_LABELS`; set `MINIMUM_VERSIONS`/`CLI_PACKAGES` if its
   CLI is version-checked.
4. Add its install command to `scripts/lib.ts` `INSTALL_COMMANDS`, teach
   `scripts/doctor.ts` to detect it there, and (when it is not version-checked)
   leave it out of `latest`/`MINIMUM_VERSIONS`.
5. Say whether it can be **guest-locked-down** (a runner reports which of its
   engines can; older runners are taken to offer only Codex).

## Model catalogue

`convex/models.ts` (`engineModels`) reads the most recently seen non-revoked
runners and takes, per engine, the models the **last signed-in runner** reported.
A subscription's catalogue is only visible from its own CLI, so it can be stale
or empty until a runner reports. `ModelOption` (`convex/lib/commands.ts`) is
`{ id, name, isDefault, engine, efforts?, defaultEffort? }`.

## Routing (`convex/lib/routing.ts` — pure)

Work gets a **tier**, which picks a model and thinking level:

- `quick` — chat names, a review of one action, the heartbeat, a reminder.
  Fastest model (`QUICK_MODEL` names: mini/nano/flash/fast/haiku/lite/luna/small/
  spark/instant), at `low`.
- `standard` — a chat, a scheduled/event job, the daily summary, a short task.
  The engine's default model and level.
- `deep` — a long brief (`LONG_BRIEF = 500` chars), the nightly memory
  consolidation, the weekly brain review. Strongest model (`DEEP_MODEL` names:
  opus/pro/heavy/max/ultra), at `high`.

The **owner's pick wins** over the tier; Perry's own picks (`create_job`,
`queue_task`) win over the tier's. `effortFor` chooses among the model's reported
`efforts`. `BACKGROUND_CAP = 90`% keeps the last tenth of a plan for the owner's
own chats.

## Plan limits and failover

When an engine has no room (`Room`), work moves: the work's own engine first,
else the default engine while it has room, else the signed-in engine with the
most plan left — and says why. Work the owner said to keep on its engine (`stay`)
waits for its reset (`RESET_MARGIN_MS = 15_000`). Background work with nowhere to
go waits for the earliest reset. A chat moves only when its engine is used up. An
engine that is merely signed out is **not** routed around. With no engine for the
work and no default chosen, Perry asks (`NO_ENGINE`) rather than picking.

`HIT_HOLD_MS = 1h` holds work off an engine that refused a turn with no reported
window.

## When changing routing

- Keep `routing.ts` pure (no server imports) — the dashboard explains routing
  with the same functions.
- `modelsOf`, `enginesOf` (`convex/lib/commands.ts`) filter a catalogue.
- Any new tier/name pattern is a behavior change: note it in the run's details,
  which is the product's stated contract ("one rule, said in every run's details").
