---
name: memory-review
description: Audit and correct the owner's memory - contradictions, stale facts, duplicates, and pages that have grown too long. Use on a weekly review, when the owner says something Perry knows is wrong, or when recall keeps returning the same thing twice.
---

# Memory review

Read the owner's Brain the way an editor would: find what is wrong, duplicated
or out of date, and put it right. Change nothing the owner did not ask for
without proposing it first. Everything below reads and writes through the real
tools; where a change needs the owner's yes, propose it and stop.

## 1. Ask Brain what needs attention

`brain_review` returns, in one call:

- merges it has already proposed for lines that say the same thing in nearly
  the same words;
- `sections` that have grown long;
- `weeks` of the journal not yet rolled up;
- `waiting`, how many proposals are already awaiting the owner.

Treat each as a lead, not an instruction.

## 2. Read the layers whole

- `brain_list` — every page this chat can reach, newest first, with ids.
- `brain_read` `"About me"` (profile) and `"Things to remember"` (core) — the
  two standing layers, read end to end; they are small and go with every turn.
- `brain_read` a journal day by name (`"today"`, `"yesterday"`, `"2026-10-01"`)
  for the days that matter.

The lines of a memory page come back with their ids, ready for `supersedes`,
`extends` and `forget`.

## 3. Look for the four faults

Search with `recall` for the same fact in different words, and read the hits
together:

- **Contradictions** — two lines that cannot both be true. The newer, or the
  one the owner last confirmed, usually stands.
- **Stale facts** — true once, not now (an old address, a job they left, a plan
  that is over). Check `expires` and the dates the lines carry.
- **Duplicates** — the same fact in several lines, or a daily note and a core
  fact saying one thing.
- **Drift** — a preference stated once that has since changed, or a `profile`
  rule that no longer matches how the owner asks for things.

## 4. Correct it

- **A fact changed.** `remember` the new version with `supersedes` naming the
  old ids. The old lines are kept as history and stop being loaded.
- **A fact only grew.** `remember` with `extends` for the line it adds to.
- **Two lines say one thing.** `brain_propose` with `kind="merge"` and the ids;
  nothing changes until the owner approves, edits or declines.
- **A section is too long.** `brain_propose` with `kind="condense"`.
- **A past week of the journal is loose.** `brain_propose` with `kind="rollup"`
  and the week as its `section` title; the days stay.
- **The same person or thing has two pages.** `brain_propose` with
  `kind="mergePages"`, `page` the one merged away and `to` the one that stays.
- **A page's own words are wrong.** `brain_read` it for the current
  `revision`, then `brain_write` `mode="replace_section"` with that revision,
  keeping every word the owner wrote that is still true.
- **Something should go for good.** That is the `forget` skill: only on the
  owner's ask, and only after quoting back what will be deleted.

Give every `brain_propose` a short `why` the owner reads first.

## 5. Report

Say what you found (the contradictions, the duplicates, the stale lines), what
you changed and with which ids, and what you proposed and are waiting on. Never
say a memory was changed or merged until the tool calls answer.
