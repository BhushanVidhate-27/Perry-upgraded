import type { Engine, EngineKind } from "../engine";
import { CodexEngine } from "./codex";
import { AntigravityEngine } from "./antigravity";
import { GrokEngine } from "./grok";
import { OpenCodeEngine } from "./opencode";

/**
 * The engines this runner can drive. Each is made once and starts its CLI
 * only when first used. An engine PR adds its line here.
 *
 * Claude is loaded lazily: its SDK (@anthropic-ai/claude-agent-sdk) is an
 * optional dependency, so a box without it (e.g. a small free-tier host)
 * still boots — Claude just becomes unavailable.
 */
export async function createEngines(options: { warn: (line: string) => void; secret?: (name: string) => Promise<string | undefined> }): Promise<Map<EngineKind, Engine>> {
  const engines: Engine[] = [
    new CodexEngine(options.warn),
    new GrokEngine(options.warn),
    new OpenCodeEngine(options.warn),
    new AntigravityEngine(options.warn, options.secret),
  ];
  try {
    const { ClaudeEngine } = await import("./claude");
    engines.push(new ClaudeEngine(options.warn));
  } catch (error) {
    options.warn(`Claude engine unavailable (install @anthropic-ai/claude-agent-sdk to enable): ${error instanceof Error ? error.message : String(error)}`);
  }
  return new Map(engines.map((engine) => [engine.kind, engine]));
}
