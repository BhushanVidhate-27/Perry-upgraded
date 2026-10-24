---
name: career-ops
description: Job search with career-ops - evaluate a job posting, scan job boards, tailor a CV, render its PDF, track applications and prepare interviews. Use when the owner sends a job URL or description, or asks about their job search, applications, CV or interviews.
---

# career-ops

career-ops is a job-search system that lives in its own checkout in this
workspace. It is not a tool to call: it is a router, a set of mode
instructions, and scripts. Follow its instructions rather than inventing a
workflow.

## Where it is

- **`career-ops/`**, relative to the working directory of this turn (Perry runs
  each turn in its workspace). The same folder as `$PERRY_HOME/workspace/career-ops`.
- Its own router is `career-ops/.opencode/skills/career-ops/SKILL.md`.
- Its house rules are `career-ops/AGENTS.md`.

If that folder is missing, say so and stop. Do not create it, do not clone it
somewhere else, and do not improvise a job search without it.

## What to do, every time

1. Read `career-ops/AGENTS.md` and then
   `career-ops/.opencode/skills/career-ops/SKILL.md` in full.
2. Work out the mode the owner's message asks for from that router's Mode
   Routing table. No mode and no job text means show its menu.
3. Read the context files the router names for that mode, then execute the mode
   file's instructions. Its `PROJECT_ROOT` is the `career-ops` folder, and its
   `DATA_ROOT` is the same folder unless `.career-ops-data` says otherwise.
4. Run its scripts from `career-ops/` with `node`, e.g.
   `node generate-pdf.mjs`, exactly as `career-ops/docs/SCRIPTS.md` says.

## Running on this machine

- `node` is 22 and `git` is installed.
- Chromium for PDF mode is already installed; `npx playwright install` is not
  needed and would only waste time. `PLAYWRIGHT_BROWSERS_PATH` is set for you.
- Reports, generated PDFs and cover letters land under `career-ops/reports/`
  and `career-ops/output/`, which are on Perry's volume and survive restarts.
- A generated PDF or CV is something the owner wants to see: attach it with
  `send_file` instead of describing it.

## Rules

- Never send, submit or click anything on the owner's behalf in an application.
  Draft it, show it, and let them press the button. Ask before any outward
  action, as always.
- `cv.md`, `data/`, `reports/` and `output/` are the owner's private material.
  Never paste their contents into a chat with anyone else, and never commit
  them.
- If the first run asks for the owner's CV, name, target roles or salary, ask
  them in the chat one thing at a time and write what they answer into
  `career-ops/modes/_profile.md` and `career-ops/cv.md` as career-ops asks.
- Report what actually ran. If a script fails, show the error instead of
  pretending the report exists.
