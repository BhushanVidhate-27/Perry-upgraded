import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { EngineModel, EngineStatus, LoginFlow } from "../engine";
import { AcpEngine, waitForSignIn, type AcpLaunch } from "./acp";
import { commandOf, runCli } from "./process";

/**
 * OpenCode (opencode.ai), the open-source coding agent, over ACP
 * (`opencode acp`), running whatever providers the owner has configured on
 * this computer. Its source is public (github.com/sst/opencode); what is
 * relied on here:
 *
 *   - `opencode --version` is the status: no agent is started to find out.
 *   - `opencode acp` speaks ACP v1 (its initialize reports loadSession,
 *     session resume, images and HTTP MCP).
 *   - Models and thinking level are session config options ("model",
 *     "effort"); `opencode models` lists them without a session, so only
 *     OpenCode's own bundled provider (`opencode/`, free with no sign-in) is
 *     offered here rather than the hundreds of models of providers this
 *     computer has not connected. Deprecated ids stay in that list (OpenCode's
 *     own default, exo-free, is one), so no id is trusted as the default and
 *     the first is taken; a session's learned efforts are kept per id.
 *   - Its bundled models need no sign-in at all, so an installed OpenCode is
 *     usable as it is; `opencode auth login` connects the owner's own
 *     providers, which Perry never reads.
 *   - It has no session modes that are access levels (build and plan are how
 *     it runs, not what it may do) and its permission defaults allow most
 *     tools, so Perry leaves its mode alone and answers whatever it does ask
 *     by the chat's access. To be asked before commands and edits, set
 *     OpenCode's own permission config to ask.
 *   - A second prompt sent while one runs is queued behind it.
 *   - `/compact`, `/init` and `/review` are its commands; `/compact` is taken
 *     as a prompt.
 *
 * PERRY_OPENCODE_COMMAND names another command for `opencode` (tests point it
 * at a stand-in agent).
 */

const INSTALL = "Install OpenCode on this computer (curl -fsSL https://opencode.ai/v2/install | bash), then choose it here.";
/** OpenCode's own provider: the models bundled with the CLI, free and usable with no sign-in. */
const BUNDLED = "opencode/";

/**
 * The owner's `opencode` command: PERRY_OPENCODE_COMMAND, else `opencode` on
 * PATH, else where OpenCode's own installer puts it (~/.opencode/bin) and a
 * service with a thin PATH would not see.
 */
export function opencodeCommand(): { command: string; args: string[] } {
  if (process.env.PERRY_OPENCODE_COMMAND?.trim()) return commandOf("PERRY_OPENCODE_COMMAND", "opencode");
  const names = process.platform === "win32" ? ["opencode.exe", "opencode.cmd"] : ["opencode"];
  const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), join(homedir(), ".opencode", "bin")];
  for (const dir of dirs) {
    for (const name of names) {
      const file = join(dir, name);
      if (existsSync(file)) return { command: file, args: [] };
    }
  }
  return { command: "opencode", args: [] };
}

export class OpenCodeEngine extends AcpEngine {
  private readonly cli = opencodeCommand();
  /** `opencode models` is a probe, so its answer is reused for a couple of minutes. */
  private listed: { at: number; models: EngineModel[] } | null = null;

  constructor(warn?: (line: string) => void) {
    super({
      kind: "opencode",
      label: "OpenCode",
      capabilities: {
        steer: "queue",
        compaction: { type: "slash-command", command: "/compact" },
        approvals: true,
        // No sandbox of its own to pin: Supervised rests on the permission
        // requests OpenCode's own config asks it to make.
        sandbox: {},
        images: true,
        modelSwitchInSession: true,
        usage: "partial",
        quickTurns: false,
      },
      // Nothing to authenticate over ACP: OpenCode uses the providers already
      // configured on this computer, and its bundled models need no sign-in.
      authMethods: [],
      // No session mode stands for an access: leave OpenCode's own (build).
      modes: { supervised: [], auto: [], full: [] },
      toolsVia: "auto",
    }, warn);
  }

  protected launch(): AcpLaunch {
    return { command: this.cli.command, args: [...this.cli.args, "acp"] };
  }

  /** `opencode`, or what PERRY_OPENCODE_COMMAND names: not when that runs it through another program. */
  where(): string | undefined {
    return this.cli.args.length ? undefined : this.cli.command;
  }

  /** Its bundled models are asked again. */
  reload(): void {
    this.kill();
    this.listed = null;
  }

  async status(): Promise<EngineStatus> {
    const base: Pick<EngineStatus, "kind" | "auth" | "models"> = { kind: "opencode", auth: {}, models: [] };
    let version: string | undefined;
    try {
      const ran = await runCli(this.cli, ["--version"]);
      if (ran.code !== 0) return { ...base, installed: false, signedIn: false, message: INSTALL, error: ran.stderr.trim().split("\n")[0] || undefined };
      version = ran.stdout.match(/(\d+\.\d+(?:\.\d+)*)/)?.[1] ?? ran.stdout.trim().split("\n")[0];
    } catch (error) {
      return { ...base, installed: false, signedIn: false, message: INSTALL, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      const models = await this.bundledModels();
      // Its bundled models need no sign-in, so installed and with models is ready; the account is OpenCode's own.
      if (!models.length) {
        return { ...base, installed: true, version, signedIn: false, message: "OpenCode has no models to run. Run `opencode auth login` on this computer to connect a provider." };
      }
      return {
        ...base, installed: true, version, signedIn: true,
        auth: { type: "providers", label: "its bundled models" },
        models,
        message: "Runs OpenCode's bundled models here; run `opencode auth login` on this computer to connect your own providers.",
      };
    } catch (error) {
      return { ...base, installed: true, version, signedIn: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** OpenCode's bundled (`opencode/`) models, from `opencode models`, with the efforts sessions have taught it. */
  private async bundledModels(): Promise<EngineModel[]> {
    if (!this.listed || Date.now() - this.listed.at > 2 * 60_000) {
      // A fresh container has no OpenCode service yet: the first ask starts it
      // and can come back with "plugins did not finish activating". Retry
      // before deciding the engine is signed out.
      let ran = await runCli(this.cli, ["models"], 30_000);
      for (let attempt = 0; ran.code !== 0 && attempt < 4; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        ran = await runCli(this.cli, ["models"], 30_000);
      }
      if (ran.code !== 0) throw new Error(ran.stderr.trim().split("\n")[0] || "opencode models failed.");
      const learned = new Map(this.learnedModels().map((model) => [model.id, model]));
      const models = ran.stdout.split("\n").map((line) => line.trim())
        .filter((id) => id.startsWith(BUNDLED))
        .map((id, index): EngineModel => {
          const seen = learned.get(id);
          // The id keeps OpenCode's `opencode/` provider prefix (the engine needs
          // it); the name drops it, as the engine is already named in the UI.
          return { id, name: id.slice(BUNDLED.length), isDefault: index === 0, ...(seen?.efforts?.length ? { efforts: seen.efforts, defaultEffort: seen.defaultEffort } : {}) };
        });
      this.listed = { at: Date.now(), models };
    }
    return this.listed.models;
  }

  /** The provider integrations saved in OpenCode, as ids; none when it will not say. */
  private async integrations(): Promise<string[]> {
    try {
      const ran = await runCli(this.cli, ["auth", "list", "--format", "json"], 30_000);
      if (ran.code !== 0) return [];
      const parsed = JSON.parse(ran.stdout) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.map((entry) => typeof entry === "string" ? entry
        : entry && typeof entry === "object" ? String((entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name ?? "") : "")
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * OpenCode is usable out of the box; this only connects the owner's own
   * providers. With none connected yet it shows the command to run here and
   * waits for one to appear.
   */
  async login(): Promise<LoginFlow> {
    if ((await this.integrations()).length) return { interaction: null, done: Promise.resolve(), cancel: () => {} };
    const waiting = waitForSignIn(async () => (await this.integrations()).length > 0, "Connecting OpenCode");
    return { interaction: { type: "terminal", command: "opencode auth login" }, done: waiting.done, cancel: waiting.cancel };
  }

  async logout(): Promise<void> {
    const ids = await this.integrations();
    // Its bundled models need no sign-in, so with nothing connected there is nothing to sign out of.
    if (!ids.length) return;
    for (const id of ids) {
      const ran = await runCli(this.cli, ["auth", "logout", id], 30_000);
      if (ran.code !== 0) throw new Error(ran.stderr.trim() || `${id} could not be signed out.`);
    }
    this.kill();
  }
}
