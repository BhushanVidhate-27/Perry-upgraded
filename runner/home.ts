import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Assistant's home on this machine, the way Claude Code has ~/.claude and
 * Codex has ~/.codex. Created on setup and whenever the runner starts, and
 * shared by the runner and the dashboard's local media server, so a file
 * anywhere in here can be shown in chat and served from where it is.
 *
 *   runner.json     how this machine's runner connects
 *   codex-results/  finished Codex turns not yet delivered
 *   codex-instructions/  what each Codex thread was last told to follow (instructions.ts)
 *   uploads/        files the owner attached in chat
 *   files/          the agent's own folder for what it makes, organised as it sees fit
 *   steps/          small pictures of Perry's browser for the chat's steps; the newest are kept
 *   skills/         the agent's skills, one folder each with a SKILL.md, found by Codex; Perry's
 *                   own ship in runner/skills and are copied in here once, when not already there
 *   logs/           the runner's output when it runs as a background service
 *   claude-models.json  the models Claude Code last said this account has
 *   engine-versions.json  the newest release of each engine's CLI, as last looked up
 *   update-request.json  an update the dashboard asked for, for `perry run` to do
 *   update-result.json   how the last one went, for the dashboard to show
 *   default-engine.json  the default engine `perry setup` chose while Perry was not running, for its server to take when it starts
 *
 * PERRY_HOME moves the whole thing.
 */
export const HOME = process.env.PERRY_HOME ?? join(homedir(), ".perry");

export const PATHS = {
  runnerConfig: join(HOME, "runner.json"),
  codexResults: join(HOME, "codex-results"),
  codexInstructions: join(HOME, "codex-instructions"),
  uploads: join(HOME, "uploads"),
  files: join(HOME, "files"),
  steps: join(HOME, "steps"),
  /** An empty folder a chat with someone else runs in: nothing of the owner's is in it. */
  guest: join(HOME, "guest"),
  skills: join(HOME, "skills"),
  logs: join(HOME, "logs"),
  claudeModels: join(HOME, "claude-models.json"),
  engineVersions: join(HOME, "engine-versions.json"),
  updateRequest: join(HOME, "update-request.json"),
  updateResult: join(HOME, "update-result.json"),
  engineChoice: join(HOME, "default-engine.json"),
};

export function ensureHome() {
  for (const dir of [HOME, PATHS.codexResults, PATHS.uploads, PATHS.files, PATHS.skills]) mkdirSync(dir, { recursive: true });
  seedSkills();
  return PATHS;
}

/**
 * The skills Perry ships with, beside this file (runner/skills): memory skills
 * in the Agent Skills shape, a folder with a SKILL.md. Resolved lazily, because
 * this file is also bundled into the dashboard's server, where the path need
 * not resolve; a missing directory just means nothing is seeded.
 */
function shippedSkills(): string | null {
  let here: string | null = null;
  try { here = dirname(fileURLToPath(import.meta.url)); } catch { here = null; }
  for (const dir of [here && join(here, "skills"), join(process.cwd(), "runner", "skills")]) {
    if (dir && existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Copy Perry's shipped skills into the owner's skills folder, each only when
 * the skill is not already there. An owner's edited or imported skill of the
 * same name is left exactly as it is, never overwritten.
 */
function seedSkills() {
  const from = shippedSkills();
  if (!from) return;
  let names: string[];
  try {
    names = readdirSync(from, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return;
  }
  for (const name of names) {
    const to = join(PATHS.skills, name);
    if (existsSync(to)) continue;
    try { cpSync(join(from, name), to, { recursive: true, force: false, errorOnExist: true }); } catch {}
  }
}

/** How this machine's runner connects. Written by Perry's server, the runner and `pnpm run connect`. */
export type RunnerConfig = { url?: string; token?: string; dir?: string; name?: string; auto?: boolean };

export function readRunnerConfig(): RunnerConfig {
  // Perry's home, not the project: nothing here belongs in the server build's file trace.
  if (!existsSync(/*turbopackIgnore: true*/ PATHS.runnerConfig)) return {};
  try {
    return JSON.parse(readFileSync(/*turbopackIgnore: true*/ PATHS.runnerConfig, "utf8"));
  } catch {
    return {};
  }
}

export function writeRunnerConfig(config: RunnerConfig) {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(PATHS.runnerConfig, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
}
