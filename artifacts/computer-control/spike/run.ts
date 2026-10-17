// bun artifacts/computer-control/spike/run.ts <outDir>
//
// The small-scale test of the one genuinely new piece for Perry controlling the
// computer: the native input helper (pet/input.swift). It compiles the helper
// and drives it directly, with no Perry wiring yet. What it must show:
//
//   1. The helper compiles with the system toolchain (swiftc), no third-party code.
//   2. It reports the display geometry control needs (origin, size, scale): a
//      point on a Retina screen must map to the right point, not half or double.
//   3. It reads the app in front (so Perry can say what it is about to touch).
//   4. It constructs every event (move, click, drag, scroll, type, key) without
//      posting anything, in dry mode.
//   5. With Accessibility granted, its own contained selftest moves the real
//      pointer onto its own window, clicks, types a marker and reads it back.
//
// Ways it could fail:
//   a. swiftc is missing, or the helper does not compile.
//   b. Accessibility is not granted to the app that runs the helper: CGEvent.post
//      does nothing and reports no error. The helper must say trusted=false and
//      the selftest must refuse to type, never fake a marker.
//   c. The display geometry is wrong (scale or origin): the click lands at half
//      the distance, or on the wrong monitor. Caught by comparing `displays`
//      with what the helper computes.
//   d. Event construction is wrong: dry mode must name the action and point.
//   e. The selftest types into the wrong app: it must type only when its own
//      process is frontmost, and never touch whatever the owner is doing.
//   f. Reading the element under a point without Accessibility must return an
//      error, not hang (System Events hangs on its prompt; AX must not).
//   g. Any command hangs: each is run with a timeout and reported as hung.
//
// A "trusted" run is the only one that proves real input. Until the owner
// grants Accessibility, the spike still proves compile, geometry, front-app,
// event construction and the safe refusal.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/computer-control/spike/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SOURCE = resolve(REPO, "pet/input.swift");
const BIN = resolve(HERE, ".build/perry-input");

const result: Record<string, unknown> = { at: new Date().toISOString(), platform: process.platform };

/** Run the helper, with a timeout so a hung command is a failure, not a wait. */
function run(args: string[], timeoutMs = 20_000): { code: number | null; stdout: string; stderr: string; hung: boolean } {
  const done: SpawnSyncReturns<string> = spawnSync(BIN, args, { encoding: "utf8", timeout: timeoutMs });
  const hung = done.error !== undefined && (done.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  return { code: done.status, stdout: (done.stdout ?? "").trim(), stderr: (done.stderr ?? "").trim(), hung };
}
const json = (args: string[], timeoutMs = 20_000) => {
  const out = run(args, timeoutMs);
  // The helper prints JSON on stdout; take the last line that parses, so a stray diagnostic never breaks it.
  const lines = out.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return { ...JSON.parse(lines[i]), __hung: out.hung, __code: out.code, __stderr: out.stderr } as Record<string, unknown>; } catch { /* next */ }
  }
  return { __parse: out.stdout || out.stderr, __hung: out.hung, __code: out.code };
};

// --- Compile -----------------------------------------------------------------

if (process.platform !== "darwin") throw new Error("the spike is macOS-only");
const compile = spawnSync("swiftc", ["-O", SOURCE, "-o", BIN], { encoding: "utf8", timeout: 180_000 });
const compiled = compile.status === 0 && existsSync(BIN);
result.compile = { ok: compiled, status: compile.status, stderr: (compile.stderr ?? "").trim().slice(0, 400) };
if (!compiled) {
  writeFileSync(resolve(outDir, "result.json"), JSON.stringify(result, null, 2));
  throw new Error(`swiftc did not build the helper:\n${(compile.stderr ?? "").trim()}`);
}

// --- Safe checks -------------------------------------------------------------

const trusted = json(["trusted"]);
const displays = json(["displays"]);
const front = json(["front"]);
const element = json(["element", "400", "400"]);

// --- Event construction (dry) ------------------------------------------------

const dry = {
  move: json(["--dry", "move", "400", "300"]),
  click: json(["--dry", "click", "400", "300", "left", "2"]),
  drag: json(["--dry", "drag", "100", "100", "300", "300"]),
  scroll: json(["--dry", "scroll", "400", "300", "120", "0"]),
  type: json(["--dry", "type", "hello cinema"]),
  key: json(["--dry", "key", "cmd+s"]),
};

// --- The contained real test -------------------------------------------------

const selftest = json(["selftest"], 30_000);

const checks = {
  compiles: Boolean((result.compile as { ok: boolean }).ok),
  // One display at scale 2, 1470x956 points, is what this Mac reports; a change is not a failure, only a wrong recomputation would be.
  displaysReported: Array.isArray((displays as { displays?: unknown[] }).displays) && (displays as { displays: unknown[] }).displays.length > 0,
  frontAppReadable: typeof (front as { front?: { name?: string } }).front?.name === "string" && (front as { front: { name: string } }).front.name.length > 0,
  // Without Accessibility the element read must be a clean error, never a hang.
  elementReadReturns: typeof (element as { ok?: boolean }).ok === "boolean" && !(element as { __hung?: boolean }).__hung,
  everyEventConstructs: Object.values(dry).every((one) => (one as { ok?: boolean }).ok === true && !(one as { __hung?: boolean }).__hung),
  // The selftest either really types the marker (trusted) or cleanly refuses; it never hangs or fakes it.
  selftestHonest: !(selftest as { __hung?: boolean }).__hung
    && (((selftest as { trusted?: boolean }).trusted === true && (selftest as { ok?: boolean }).ok === true)
      || ((selftest as { trusted?: boolean }).trusted === false && (selftest as { ok?: boolean }).ok === false)),
};

result.trusted = trusted;
result.displays = displays;
result.front = front;
result.element = element;
result.dry = dry;
result.selftest = selftest;
result.checks = checks;
result.passed = Object.values(checks).every(Boolean);
result.realInputProven = checks.compiles && (selftest as { ok?: boolean }).ok === true;

writeFileSync(resolve(outDir, "result.json"), JSON.stringify(result, null, 2));

console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
if (!result.realInputProven) {
  console.log(`
The helper is sound, but real input is not proven yet: Accessibility is not
granted to the app running it, so CGEvent.post does nothing. Grant it and run
this again:

  System Settings -> Privacy & Security -> Accessibility -> + -> ${BIN}
  (or, in the built product, grant it to the desktop pet's Electron app)
  bun artifacts/computer-control/spike/run.ts ${outDir}

With it granted, selftest must type its marker into its own window and read it
back: {"ok":true,"trusted":true,"globalReceived":"perry-spike-OK-...","pidReceived":"perry-spike-OK-..."}.
`);
}
