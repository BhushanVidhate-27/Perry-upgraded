/**
 * Running Perry's macOS input helper (pet/input.swift), from either the desktop
 * pet or the perry-control CLI. Plain node, no electron, so the same binary is
 * used by both and macOS's Accessibility grant belongs to this one small file's
 * binary rather than to the pet's whole app.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = process.env.PERRY_HOME ?? join(homedir(), ".perry");
export const BIN = join(HOME, "bin", "perry-input");
/** Beside this file, wherever Perry was installed. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "input.swift");

/** The helper, built from input.swift when it is missing or older than it; macOS only. */
let building = null;
export function ensureBinary() {
  if (process.platform !== "darwin") return Promise.resolve();
  if (!existsSync(SRC)) return Promise.reject(new Error(`Perry's input helper source is missing (${SRC}).`));
  // A Perry update brings a new input.swift: rebuild it in place. The Accessibility grant is by
  // path, so the owner does not have to allow the new build (DESIGN.md, spike result).
  const fresh = existsSync(BIN) && statSync(BIN).mtimeMs >= statSync(SRC).mtimeMs;
  if (fresh) return Promise.resolve();
  building ??= new Promise((resolve, reject) => {
    mkdirSync(join(HOME, "bin"), { recursive: true });
    let errors = "";
    const child = spawn("swiftc", ["-O", SRC, "-o", BIN], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", (error) => reject(new Error(`swiftc could not be run (${error.message}).`)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`swiftc failed (${code}): ${swiftcError(errors)}`))));
  }).catch((error) => { building = null; throw error; });
  return building;
}

/** What swiftc said, first: its "error:" lines name the file and line, its tail is the note under them. */
const swiftcError = (output) => {
  const lines = output.trim().split(/\r?\n/);
  const first = lines.find((line) => line.includes("error:")) ?? "";
  return [first || lines[0] || "", lines[lines.length - 1]].filter(Boolean).join(" | ");
};

/** What the helper prints, as JSON: its answer, or what went wrong. A helper that
 *  fails (a name that is not an app) prints only why, on stderr; that is the error. */
export async function run(args) {
  const child = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  return await new Promise((resolve) => {
    child.on("close", () => {
      if (!out.trim()) return resolve({ ok: false, error: err.trim() || "perry-input said nothing." });
      try { resolve(JSON.parse(out.trim())); } catch { resolve({ ok: false, error: err.trim() || out.trim() }); }
    });
    child.on("error", () => resolve({ ok: false, error: err.trim() || "spawn failed" }));
  });
}

/** The pid of the app in front, or null when there is none. Keys go straight into that
 *  process rather than to whatever holds the focus when they arrive: Perry's own window,
 *  a notification or a permission dialog can take the focus in between. */
export async function frontPid() {
  const r = await run(["front"]);
  const pid = Number(r?.front?.pid ?? 0);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}