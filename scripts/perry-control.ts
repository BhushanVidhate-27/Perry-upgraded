/**
 * perry-control: Perry's hands on your Mac, from the terminal.
 *
 * The desktop pet and this run the same binary (`perry-input`, pet/input.swift,
 * via pet/input.js), so a shortcut you take by hand and one Perry takes are the
 * same pointer and the same keys. Two things this adds over pet/control.js:
 *
 *   - Bindings (~/.perry/bindings.json): a named list of steps you write once —
 *     `perry-control bind greet "open Messages\ntype hi\nkey return"` — and run
 *     by name, so a whole app is reached by keys rather than by coordinates.
 *   - `doctor`: exactly which macOS permission each command needs, so what can
 *     be revoked is a decision rather than a guess. Everything here needs
 *     Accessibility for the helper binary alone; nothing here needs Screen
 *     Recording, which is only for looking at the screen (pet/look.js).
 *
 * How a binding can go wrong, which `selftest` checks before anything is typed:
 *   an unknown verb or a verb with nothing after it is refused by name and line
 *   number, and the whole binding is refused rather than half-run; a non-numeric
 *   coordinate is refused the same way; steps run in order and stop at the first
 *   failure, since a half-done binding that keeps typing is worse than none;
 *   bindings.json that is not a JSON object of strings is named and left alone,
 *   never overwritten; `bind` refuses to replace an existing binding without
 *   --force, so a named binding is not lost to a typo; running a name that is
 *   not there says what is. Blank lines and `#` comments are skipped.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME } from "../runner/home";
import { ensureBinary, frontPid, run } from "../pet/input.js";
import { bold, dim, green, red, yellow } from "./lib";

const BINDINGS = join(HOME, "bindings.json");
const say = console.log;

type Step = { line: number; text: string; verb: string; rest: string };

/** What a binding line may say. Anything else is refused before a key is posted. */
const VERBS = ["key", "type", "open", "pid", "move", "click", "drag", "scroll", "element", "front", "sleep"] as const;

/** A binding's steps, or why it cannot be one. Every throw names the line. */
export function parseSteps(script: string): Step[] {
  const steps: Step[] = [];
  script.split(/\r?\n/).forEach((raw, index) => {
    const text = raw.trim();
    if (!text || text.startsWith("#")) return;
    const verb = (text.split(/\s+/)[0] ?? "").toLowerCase();
    if (!(VERBS as readonly string[]).includes(verb)) throw new Error(`line ${index + 1}: "${verb}" is not something perry-control knows (${VERBS.join(", ")}).`);
    const rest = text.slice(verb.length).trim();
    if (!rest && verb !== "front") throw new Error(`line ${index + 1}: "${verb}" needs something after it.`);
    steps.push({ line: index + 1, text, verb, rest });
  });
  if (!steps.length) throw new Error("a binding needs at least one step.");
  return steps;
}

/** The helper's arguments for a step, in its own words (pet/input.swift). */
export async function helperArgs(step: Step): Promise<string[]> {
  const parts = step.rest.split(/\s+/);
  const numbers = (want: number) => {
    if (parts.length < want || parts.slice(0, want).some((part) => !Number.isFinite(Number(part)))) {
      throw new Error(`line ${step.line}: "${step.text}" needs ${want} number${want > 1 ? "s" : ""}.`);
    }
    return parts.slice(0, want).map(Number);
  };
  switch (step.verb) {
    case "front": return ["front"];
    case "pid": return ["pid", step.rest];
    // Keys and text name their app when the line starts with one (`type Finder hello`), so a
    // binding run from a foreground app — a terminal, a chat — does not type into itself.
    // `@Name` is required: the app must be running, or the step stops. A plain first word is
    // tried as an app and otherwise typed as it stands, which is why `@` exists.
    // Otherwise they go to the app in front, by pid, so a notification taking the focus in
    // between cannot swallow them.
    case "key": {
      const [target, combo] = await targetFor(step, parts);
      if (!combo) throw new Error(`line ${step.line}: "key" needs a combo, e.g. cmd+s or enter.`);
      return ["key", combo, ...(target ? [String(target)] : [])];
    }
    case "type": {
      const [target, text] = await targetFor(step, parts);
      return ["type", text, ...(target ? [String(target)] : [])];
    }
    case "open": return ["open", step.rest];
    case "move": { const [x, y] = numbers(2); return ["move", String(x), String(y)]; }
    case "click": {
      const [x, y] = numbers(2);
      return ["click", String(x), String(y), ...(parts[2] ? [parts[2]] : []), ...(parts[3] ? [parts[3]] : [])];
    }
    case "drag": { const [x1, y1, x2, y2] = numbers(4); return ["drag", String(x1), String(y1), String(x2), String(y2)]; }
    case "scroll": {
      // The helper wants a point to scroll at; the pointer is where the owner left it.
      const [dy] = numbers(1);
      const dx = Number.isFinite(Number(parts[1])) ? Number(parts[1]) : 0;
      const at = await run(["pointer"]);
      return ["scroll", String(at.x ?? 0), String(at.y ?? 0), String(dy), String(dx)];
    }
    case "element": { const [x, y] = numbers(2); return ["element", String(x), String(y)]; }
    default: return [];
  }
}

/** The pid of a running app named by a step, or null when it is not one. */
async function pidOf(name: string): Promise<number | null> {
  if (!name) return null;
  const answer = await run(["pid", name]);
  const pid = Number(answer?.pid ?? 0);
  return answer?.ok && Number.isFinite(pid) && pid > 0 ? pid : null;
}

/**
 * Which process a key or text step goes to, and what is left of it: the app named by
 * `@Name` (which must be running, or the step stops — a closed app must never send a
 * password to whatever happens to be in front), or a first word that names a running app,
 * or else the app in front with the whole of what was written.
 */
async function targetFor(step: Step, parts: string[]): Promise<[number | null, string]> {
  const [first, ...rest] = parts;
  if (first?.startsWith("@")) {
    const name = first.slice(1);
    const pid = await pidOf(name);
    if (!pid) throw new Error(`line ${step.line}: ${name} is not running, so "${step.text}" was not done. Open it first, or drop the @.`);
    return [pid, rest.join(" ")];
  }
  const named = await pidOf(first ?? "");
  return [named ?? await frontPid(), named ? rest.join(" ") : [first, ...rest].filter(Boolean).join(" ")];
}

function readBindings(): Record<string, string> {
  if (!existsSync(BINDINGS)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(BINDINGS, "utf8"));
  } catch (error) {
    throw new Error(`${BINDINGS} is not valid JSON (${error instanceof Error ? error.message : String(error)}). It has been left alone.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.values(parsed).some((script) => typeof script !== "string")) {
    throw new Error(`${BINDINGS} is not a set of name → steps. It has been left alone.`);
  }
  return parsed as Record<string, string>;
}

function writeBindings(bindings: Record<string, string>) {
  mkdirSync(dirname(BINDINGS), { recursive: true });
  writeFileSync(BINDINGS, `${JSON.stringify(bindings, null, 2)}\n`);
}

/** The command a line runs directly, without being saved first. */
async function runStep(step: Step, dry: boolean): Promise<string> {
  const args = await helperArgs(step);
  const answer = await run(dry ? ["--dry", ...args] : args);
  if (!answer?.ok) throw new Error(`line ${step.line}: ${answer?.error ?? "perry-input said nothing."}`);
  return JSON.stringify(answer);
}

async function runBinding(name: string, dry: boolean) {
  const bindings = readBindings();
  const script = bindings[name];
  if (script === undefined) {
    const names = Object.keys(bindings);
    throw new Error(`There is no binding called "${name}".${names.length ? ` Try: ${names.join(", ")}.` : " Make one with: perry-control bind <name> \"<steps>\""}`);
  }
  const steps = parseSteps(script);
  for (const step of steps) {
    say(dry ? `  ${dim(step.text)}` : `  ${dim(step.text)} ${dim(`(${step.verb})`)}`);
    if (step.verb === "sleep") {
      const ms = Number(step.rest);
      if (!Number.isFinite(ms)) throw new Error(`line ${step.line}: "sleep" needs milliseconds.`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      continue;
    }
    say(dim(`    ${await runStep(step, dry)}`));
  }
}

async function doctor() {
  const commands = {
    "key, type": "Accessibility (the helper posts keys)",
    "move, click, drag, scroll": "Accessibility (the helper moves the pointer)",
    "open": "nothing — NSWorkspace, and a permission dialog if it asks",
    "front, displays, pointer": "nothing",
    element: "Accessibility (it reads what is under the pointer)",
    "anything that looks at the screen": "Screen Recording — not used here; only pet/look.js needs it",
  };
  try {
    await ensureBinary();
  } catch (error) {
    say(red(`Perry could not build the macOS input helper (swiftc). ${error instanceof Error ? error.message : String(error)}`));
    return 1;
  }
  const trusted = await run(["trusted"]);
  say(bold("perry-control"));
  say(`  helper    ${green("built")} (${process.platform === "darwin" ? "macOS" : "not macOS: nothing here can act"})`);
  if (process.platform === "darwin") {
    say(trusted?.trusted
      ? `  keys      ${green("Accessibility allowed")}`
      : `  keys      ${yellow("Accessibility not allowed yet")} — macOS asks the first time a key is posted; in System Settings → Privacy & Security → Accessibility, allow ${red("perry-input")}`);
  }
  for (const [what, needs] of Object.entries(commands)) say(`  ${what.padEnd(26)} ${dim(needs)}`);
  say(`\n  bindings  ${dim(BINDINGS)}`);
  say(`\n${dim("Everything above runs as one small binary, not as Perry's desktop app: revoking it there costs nothing but the pointer and the keys.")}`);
  return trusted?.trusted ? 0 : 1;
}

/** The checks the header lists, run before anything is ever typed. */
async function selftest() {
  // The helper first: the checks below ask a running app for its pid, which only the
  // helper built from the current input.swift can answer.
  await ensureBinary();
  let failed = 0;
  const expect = (what: string, ok: boolean) => {
    say(`${ok ? green("✔") : red("✖")} ${what}`);
    if (!ok) failed++;
  };
  expect("a three-step binding parses", parseSteps("open Safari\ntype hi\nkey return").map((step) => step.verb).join(",") === "open,type,key");
  expect("comments and blank lines are skipped", parseSteps("# a note\n\nkey tab").length === 1);
  expect("an unknown verb is refused by line number", (() => {
    try { parseSteps("key tab\nfly home"); return false; } catch (error) { return error instanceof Error && error.message.includes("line 2"); }
  })());
  expect("a verb with nothing after it is refused", (() => {
    try { parseSteps("type"); return false; } catch (error) { return error instanceof Error && error.message.includes("line 1"); }
  })());
  expect("an empty binding is refused", (() => {
    try { parseSteps("# only a note"); return false; } catch (error) { return error instanceof Error && error.message.includes("at least one step"); }
  })());
  const numbers = await helperArgs({ line: 1, text: "click left right", verb: "click", rest: "left right" }).then(() => null, (error: unknown) => error);
  expect("a coordinate that is not a number is refused", numbers instanceof Error && numbers.message.includes("needs 2 numbers"));
  // Finder, because it is the one app that is always running on macOS.
  const named = await helperArgs({ line: 1, text: "type Finder hello", verb: "type", rest: "Finder hello" });
  expect("a running app named first takes the text, not the app's name", named[1] === "hello");
  expect("keys name their app too", (await helperArgs({ line: 1, text: "key Finder cmd+s", verb: "key", rest: "Finder cmd+s" }))[1] === "cmd+s");
  expect("@app is required, and takes the app's name", (await helperArgs({ line: 1, text: "type @Finder secret", verb: "type", rest: "@Finder secret" }))[1] === "secret");
  expect("a word that is not an app is typed as it stands", (await helperArgs({ line: 1, text: "type hello there", verb: "type", rest: "hello there" }))[1] === "hello there");
  const closed = await helperArgs({ line: 1, text: "type @NoSuchAppHere hunter2", verb: "type", rest: "@NoSuchAppHere hunter2" }).then(() => null, (error: unknown) => error);
  expect("an app that is not running stops the step, rather than typing into whatever is in front",
    closed instanceof Error && closed.message.includes("is not running"));
  expect("scroll takes a point from the pointer", (await helperArgs({ line: 1, text: "scroll -240", verb: "scroll", rest: "-240" })).length === 5);
  say(failed ? red(`\n${failed} check(s) failed.`) : green("\nAll checks passed."));
  return failed ? 1 : 0;
}

const HELP = `
  ${bold("perry-control")} drive this Mac from the terminal: keys, pointer, apps.

  ${bold("key")} [@app] <combo>   press one, e.g. cmd+s, enter, escape, ctrl+shift+k
  ${bold("type")} [@app] <text>    type text; @app names the app and insists it is running
  ${bold("open")} <app>            bring an app up, by name, bundle id or path
  ${bold("pid")} <app>             which process an app's keys would go to
  ${bold("move")} <x> <y>          move the pointer (points, as the screen shows them)
  ${bold("click")} <x> <y> [button] [clicks]
  ${bold("drag")} <x1> <y1> <x2> <y2>
  ${bold("scroll")} <dy> [dx]   at wherever the pointer is
  ${bold("element")} <x> <y>    what is under a point
  ${bold("front")}              the app in front
  ${bold("bindings")}           list the bindings
  ${bold("bind")} <name> "<steps>"   save one; ${bold("--force")} to replace it
  ${bold("unbind")} <name>      remove one
  ${bold("run")} <name> [--dry] play one back; ${bold("--dry")} posts nothing
  ${bold("doctor")}             what macOS lets this do, and what it needs
  ${bold("selftest")}           check the binding reader

  A binding is one step per line: ${bold("open Messages")}, ${bold("type hello")}, ${bold("key return")},
  ${bold("sleep 500")}, ${bold("# a comment")}. Every step takes the same words as above.
  ${dim("@app is required: if that app is not running the step stops, so nothing is typed into the wrong window.")}
`;

export async function perryControl(argv: string[]): Promise<number> {
  const [command = "help", ...rest] = argv;
  if (["help", "--help", "-h"].includes(command)) { say(HELP); return 0; }
  if (process.platform !== "darwin" && command !== "doctor") {
    say(red(`perry-control only acts on macOS in this build (this is ${process.platform}).`));
    return 1;
  }
  try {
    switch (command) {
      case "doctor": return await doctor();
      case "selftest": return await selftest();
      case "bindings": {
        const bindings = readBindings();
        const names = Object.keys(bindings);
        if (!names.length) say(dim(`No bindings yet in ${BINDINGS}. Make one with: perry-control bind <name> "<steps>"`));
        for (const name of names) say(`  ${bold(name)}\n${bindings[name].split(/\r?\n/).map((line) => `    ${dim(line)}`).join("\n")}`);
        return 0;
      }
      case "bind": {
        const [name, ...script] = rest.filter((part) => part !== "--force");
        const force = rest.includes("--force");
        if (!name || !script.join(" ").trim()) throw new Error("bind needs a name and the steps: perry-control bind greet \"open Messages\\ntype hi\\nkey return\"");
        parseSteps(script.join(" ")); // Refused before anything is written.
        const bindings = readBindings();
        if (bindings[name] !== undefined && !force) throw new Error(`"${name}" is already a binding. Pass --force to replace it.`);
        bindings[name] = script.join(" ").trim();
        writeBindings(bindings);
        say(green(`${name} saved to ${BINDINGS}. Play it with: perry-control run ${name} --dry`));
        return 0;
      }
      case "unbind": {
        const [name] = rest;
        const bindings = readBindings();
        if (bindings[name] === undefined) throw new Error(`There is no binding called "${name}".`);
        delete bindings[name];
        writeBindings(bindings);
        say(green(`${name} removed.`));
        return 0;
      }
      case "run": {
        const [name] = rest.filter((part) => part !== "--dry");
        if (!name) throw new Error("run needs a binding's name.");
        const dry = rest.includes("--dry");
        await ensureBinary();
        if (!dry && !(await run(["trusted"]))?.trusted) {
          say(red("Perry cannot post keys yet: macOS has not allowed Accessibility for perry-input. It asks the first time; try again, then allow it in System Settings → Privacy & Security → Accessibility."));
          return 1;
        }
        await runBinding(name, dry);
        say(green(dry ? `${name}: ${dim("nothing was posted")}` : `${name} done.`));
        return 0;
      }
      default: {
        const args = await helperArgs({ line: 1, text: [command, ...rest].join(" "), verb: command, rest: rest.join(" ") });
        if (!args.length) throw new Error(`Unknown command: ${command}`);
        await ensureBinary();
        say(JSON.stringify(await run(args), null, 2));
        return 0;
      }
    }
  } catch (error) {
    say(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }
  say(red(`Unknown command: ${command}`));
  say(HELP);
  return 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exit(await perryControl(process.argv.slice(2)));
}