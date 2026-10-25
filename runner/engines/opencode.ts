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
 *     "effort"); `opencode models` lists them without a session. Its free
 *     bundled provider (`opencode/`) and the providers connected with
 *     `opencode auth login` are offered, bundled first (offeredModels), so a
 *     bundled plan that is used up can be left for a provider's own quota.
 *     Deprecated ids stay in that list (OpenCode's own default, exo-free, is
 *     one), so no id is trusted as the default; the first bundled model is. A
 *     session's learned efforts are kept per id.
 *   - Its bundled models need no sign-in at all, so an installed OpenCode is
 *     usable as it is; `opencode auth login` connects the owner's own
 *     providers, whose models Perry offers but whose credentials it never
 *     reads.
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

// --- Backup for model switching ----------------------------------------------

/**
 * The models /model offers, from `opencode models`: OpenCode's free bundled
 * ones first, then the models of providers connected with `opencode auth
 * login` (the ids `connected` names). Keeping the bundled ones first keeps the
 * free model the default, so connecting a provider never moves a chat that has
 * not picked one; switching to a provider is how a chat gets past a bundled
 * plan that is used up.
 *
 * Only connected providers are offered: `opencode models` can also list models
 * of providers this computer has not connected, which would bury the useful
 * ones. Bundled names drop OpenCode's `opencode/` prefix; a provider's id
 * keeps its own prefix, which tells the providers apart. Duplicate ids are
 * listed once.
 */
/**
 * The provider keys (ids and names, lowercased) in `opencode auth list
 * --format json`, which are the prefixes `opencode models` gives a provider's
 * models. Entries have been seen in two shapes: `{id, name}` and `{id,
 * integrationID, name}`, so every string field is taken. Notion and other MCP
 * integrations come back too; an `mcp_` entry is a tool server, not a model
 * provider, and is left out.
 */
export function providerKeys(entries: unknown[]): string[] {
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "";
  return [...new Set(entries.flatMap((entry) => {
    if (typeof entry === "string") return [text(entry)];
    if (!entry || typeof entry !== "object") return [];
    const fields = entry as { id?: unknown; name?: unknown; integrationID?: unknown };
    const ids = [text(fields.id), text(fields.integrationID)];
    // An MCP integration's name is a tool server, not a model provider.
    if (ids.some((id) => id.startsWith("mcp_"))) return [];
    return [...ids, text(fields.name)];
  }).filter(Boolean))];
}

export function offeredModels(ids: string[], learned: EngineModel[] = [], connected: string[] = []): EngineModel[] {
  const seen = new Map(learned.map((model) => [model.id, model]));
  const providers = new Set(connected.map((id) => id.trim().toLowerCase()).filter(Boolean));
  const usable = (id: string) => id.startsWith(BUNDLED) || providers.has(id.split("/")[0].toLowerCase());
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].filter(usable);
  const ordered = [
    ...unique.filter((id) => id.startsWith(BUNDLED)),
    ...unique.filter((id) => !id.startsWith(BUNDLED)),
  ];
  return ordered.map((id, index) => {
    const known = seen.get(id);
    return {
      id,
      name: id.startsWith(BUNDLED) ? id.slice(BUNDLED.length) : id,
      isDefault: index === 0,
      ...(known?.efforts?.length ? { efforts: known.efforts, defaultEffort: known.defaultEffort } : {}),
    };
  });
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
      // OpenCode caches an HTTP MCP server per session and does not reconnect
      // one whose Perry server restarted, so a chat that outlived a restart had
      // no Brain tools. The stdio bridge is a fresh child process whose every
      // call reaches Perry again, so the tools come back with the server.
      toolsVia: "stdio",
    }, warn);
  }

  protected launch(): AcpLaunch {
    return { command: this.cli.command, args: [...this.cli.args, "acp"] };
  }

  /** `opencode`, or what PERRY_OPENCODE_COMMAND names: not when that runs it through another program. */
  where(): string | undefined {
    return this.cli.args.length ? undefined : this.cli.command;
  }

  /** Its model list is asked again. */
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
      const models = await this.catalogue();
      // Its bundled models need no sign-in, so installed and with models is ready; the account is OpenCode's own.
      if (!models.length) {
        return { ...base, installed: true, version, signedIn: false, message: "OpenCode has no models to run. Run `opencode auth login` on this computer to connect a provider." };
      }
      const connected = models.some((model) => !model.id.startsWith(BUNDLED));
      return {
        ...base, installed: true, version, signedIn: true,
        auth: { type: "providers", label: connected ? "its bundled models and the providers connected here" : "its bundled models" },
        models,
        message: connected
          ? "Runs OpenCode's bundled models and the providers connected here; switch with /model when a plan is used up."
          : "Runs OpenCode's bundled models here; run `opencode auth login` on this computer to add a provider's models, then switch to one with /model when a plan is used up.",
      };
    } catch (error) {
      return { ...base, installed: true, version, signedIn: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Every model `opencode models` lists: bundled first, then the providers connected here (offeredModels). */
  private async catalogue(): Promise<EngineModel[]> {
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
      this.listed = { at: Date.now(), models: offeredModels(ran.stdout.split("\n"), this.learnedModels(), (await this.integrations()).providers) };
    }
    return this.listed.models;
  }

  /**
   * OpenCode's saved integrations: `ids` to sign out of, `providers` (ids and
   * names, lowercased) to tell which models belong to a provider the owner
   * connected. Empty when it will not say.
   */
  private async integrations(): Promise<{ ids: string[]; providers: string[] }> {
    const none = { ids: [], providers: [] };
    try {
      const ran = await runCli(this.cli, ["auth", "list", "--format", "json"], 30_000);
      if (ran.code !== 0) return none;
      const parsed = JSON.parse(ran.stdout) as unknown;
      if (!Array.isArray(parsed)) return none;
      const entries = parsed.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
      const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : "";
      return {
        ids: [...new Set(entries.map((entry) => text(entry.id ?? entry.name)).filter(Boolean))],
        // A provider's models are prefixed with its provider id, which may be
        // the integration's name rather than the credential's id.
        providers: providerKeys(parsed),
      };
    } catch {
      return none;
    }
  }

  /**
   * OpenCode is usable out of the box; this only connects the owner's own
   * providers. With none connected yet it shows the command to run here and
   * waits for one to appear.
   */
  async login(): Promise<LoginFlow> {
    if ((await this.integrations()).ids.length) return { interaction: null, done: Promise.resolve(), cancel: () => {} };
    const waiting = waitForSignIn(async () => (await this.integrations()).ids.length > 0, "Connecting OpenCode");
    // A provider's models are only known once it is connected: drop the list
    // so the status probe that follows the sign-in asks again.
    const done = waiting.done.then(() => { this.listed = null; });
    return { interaction: { type: "terminal", command: "opencode auth login" }, done, cancel: waiting.cancel };
  }

  async logout(): Promise<void> {
    const { ids } = await this.integrations();
    // Its bundled models need no sign-in, so with nothing connected there is nothing to sign out of.
    if (!ids.length) return;
    for (const id of ids) {
      const ran = await runCli(this.cli, ["auth", "logout", id], 30_000);
      if (ran.code !== 0) throw new Error(ran.stderr.trim() || `${id} could not be signed out.`);
    }
    this.kill();
  }
}
