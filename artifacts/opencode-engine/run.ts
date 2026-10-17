import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TurnEvent } from "../../runner/engine";
import { OpenCodeEngine } from "../../runner/engines/opencode";

// bun artifacts/opencode-engine/run.ts <outDir>
// OpenCode as Perry's engine (runner/engines/opencode.ts), on this machine's
// real OpenCode CLI. The status probe must start nothing; then one real turn
// runs on the model routing picks, to prove the engine answers, reports usage,
// and never falls back to OpenCode's deprecated bundled default (exo-free).
//
// Ways it could fail, written down before the checks:
//   1. status() starts an agent or a session to see whether OpenCode works.
//   2. The installed CLI is not found, or reports no models.
//   3. No model is marked the default, or the default is the deprecated exo-free.
//   4. A turn does not start, or does not stream assistant text.
//   5. The turn ends failed, or reports no usage.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/opencode-engine/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const checks: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
const check = (name: string, passed: boolean, detail?: unknown) => { checks.push({ name, passed, detail }); };

const engine = new OpenCodeEngine((line) => console.error(JSON.stringify({ warn: line })));
try {
  const status = await engine.status();
  const model = status.models.find((item) => item.isDefault) ?? status.models[0];
  check("installed", status.installed && Boolean(status.version), { version: status.version, error: status.error });
  check("signedInWithModels", status.signedIn && status.models.length > 0, { signedIn: status.signedIn, models: status.models.length });
  check("defaultIsNotDeprecated", Boolean(model) && model.id !== "opencode/exo-free", { model: model?.id });

  let text = "";
  let usage: unknown;
  const result = await engine.runTurn(
    {
      instructions: "You are a test. Follow the instruction exactly.",
      prompt: "Reply with exactly this one word and nothing else: pong",
      attachments: [],
      cwd: outDir,
      model: model?.id,
      access: "auto",
    },
    {
      onSession: async () => {},
      onEvent: (event: TurnEvent) => {
        if (event.type === "text" && event.stream === "assistant") text = event.text;
        if (event.type === "usage") usage = event.state === "unavailable" ? "unavailable" : event.usage;
      },
      onRequest: async (request) => (request.options.find((item) => item.kind === "accept") ?? request.options[0])!.id,
    },
  );
  const reply = result.text || text;
  check("turnCompleted", result.state === "completed", { state: result.state, error: result.error });
  check("replyPong", /\bpong\b/i.test(reply), { reply: reply.slice(0, 120) });
  check("usageReported", usage !== undefined && usage !== "unavailable", usage);
} catch (error) {
  check("threw", false, error instanceof Error ? error.message : String(error));
} finally {
  engine.kill();
}

const passed = checks.every((item) => item.passed);
writeFileSync(join(outDir, "result.json"), JSON.stringify({ engine: "opencode", passed, checks }, null, 2) + "\n");
for (const item of checks) console.log(`${item.passed ? "✓" : "✗"} ${item.name}${item.passed ? "" : `  ${JSON.stringify(item.detail)}`}`);
console.log(passed ? "opencode-engine: PASS" : "opencode-engine: FAIL");
process.exit(passed ? 0 : 1);
