---
name: Perry skills system
description: Use when working on Perry's own Skills feature — the on-disk skills folder, SKILL.md format, skill import/review/install, and the security review.
---

# Perry's own Skills system

Distinct from *this* coding agent's skills (`.opencode/skills/`). Perry's
assistant has a **skills folder on disk**: `~/.perry/skills` (`runner/home.ts`,
`PATHS.skills`). Each skill is a folder with a `SKILL.md` (Agent Skills format,
shared across Codex/Claude), and it is the folder every engine is pointed at, so
Codex can list a skill from the next turn.

## Files

| File | Role |
| --- | --- |
| `convex/lib/skills.ts` | The whole mechanism: `listSkills`, `readSkill`, `removeSkill`, `stageSkill`, `installStaged`, and the security review. |
| `convex/skills.ts` | Dashboard actions (`list`, `read`, `remove`), gated by `assertDashboardKey`. |
| `convex/tools.ts` | `review_skill`, `install_skill` — the agent-facing path. |
| `convex/lib/commands.ts` | `skillMentions` — the `$`/skill list in the composer. |

## The import flow (issue #110)

Because public skill collections carry malicious skills, import is a two-step,
owner-approved flow:

1. **`review_skill`** → `stageSkill(source)` fetches the skill from a URL or
   local folder into `~/.perry/skills-review` (a folder Codex does **not** load
   from), reads it, and returns a `Staged`: name, description, files, and a
   `Found` summary — commands it runs, sites it reaches, paths it touches,
   scripts, and `warnings`.
2. The agent tells the owner plainly what it does and what it can do on this
   computer, and asks whether to install.
3. **`install_skill`** → `installStaged(reviewId, replace?)` moves it into
   `~/.perry/skills`.

**Never copy a skill into the skills folder yourself** — always through review.

## Guards in `lib/skills.ts`

- `NAME = /^[a-z0-9][a-z0-9-]{0,63}$/` — a skill name as Codex takes it.
- `MAX_FILES = 60`, `MAX_BYTES = 2 MiB`; `SKIP` = `.git`, `node_modules`,
  `__pycache__`, `.DS_Store`.
- `SHOWN_SKILL = 20_000`, `SHOWN_OTHER = 4_000` bytes shown per file.
- `WARNINGS` is the security review: patterns for "ignore previous instructions",
  "don't tell the user", `curl | sh`, base64 decode, broad `rm -rf`, reaching for
  `.ssh`/`.env`/browser data, exfiltrating keys, self-starting (cron/launchd), and
  asking for more rights (sudo/chmod 777). Extend this list when you find a new
  trap; keep the messages plain and specific.

## Frontmatter

`frontmatter(skill)` reads `name` and `description` from the leading `---` block,
the same fields Codex reads. Keep skills portable: a folder with `SKILL.md`.

## What to check when changing this

- A staged skill never becomes loadable by an engine (it stays in
  `skills-review` until installed).
- Path handling rejects escapes: the code resolves and checks the target stays
  inside the skills folder.
- Deleting a skill (`remove`) drops its folder; a chat naming it afterwards gets
  its name as plain text.
- The dashboard (`convex/skills.ts`) reads the folder as **actions**, not live
  queries, because a skill written on disk is not in the database.
