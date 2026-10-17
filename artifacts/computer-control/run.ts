import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../browser";

// bun artifacts/computer-control/run.ts <outDir>
//
// Perry controlling the real computer, end to end: a fresh Perry (its own
// PERRY_HOME and port), the real desktop pet against it, and the model's
// `use_computer` path driven through the very functions the tool calls
// (convex/computer.ts), so what is checked is the real loop — the pet page's
// poll, the IPC, pet/control.js, and the OS — without an engine in the way.
//
// A window of this script's own is the target (target.ts): it logs every click
// and every keystroke, so a click and a type Perry is asked for are checked
// against what the OS really did, not against what the pet reported.
//
// Ways it could fail (written before the test, per AGENTS.md):
//   1. The setting is off → ask must refuse.
//   2. No pet running → ask must refuse rather than hang.
//   3. The pet never sees the row (device mismatch, or its query is not
//      running) → the tool must time out, not hang.
//   4. The pet fulfils with an error instead of a result (control.js threw, the
//      helper is missing, or macOS does not allow Accessibility).
//   5. type does not land in the target window (focus went elsewhere, or
//      macOS blocked synthetic keys into a secure field).
//   6. click does not reach the target window (the pet's own window is over
//      the point, or its click-through logic eats it).
//   7. move lands somewhere else than asked (normalized→points, Retina scale,
//      the picture's cap).
//   8. element_at returns nothing, or hangs.
//   9. A point outside 0-1, or NaN, is refused by the schema, not dispatched.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/computer-control/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });

type Row = { _id: string; status: string; result?: any; error?: string; action: string; args?: any };
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const result: Record<string, unknown> = { checks, notes, passed: false };
const save = () => writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));

/** The marker this run types; unique to the run, checked in the target window at the end. */
const MARKER = `perry-computer-${Date.now().toString(36)}`;

async function main() {
  if (process.platform !== "darwin") throw new Error("This run drives the real macOS input helper; it is macOS only.");
  const PORT = await freePort();
  const DEVTOOLS = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const KEY = "computer-control-e2e-key";
  const OWNER = "4242";
  const home = mkdtempSync(join(tmpdir(), "perry-computer-"));

  // --- A stand-in Telegram, so the owner can be claimed exactly as in production.
  const telegram = { sent: [] as any[], pending: [] as any[], nextUpdate: 1 };
  const from = { id: Number(OWNER), is_bot: false, first_name: "Mani", username: "The_M1N9" };
  const stub = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const method = request.url?.split("/").pop() ?? "";
      const args = body ? JSON.parse(body) as any : {};
      const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result })); };
      if (method === "getMe") return reply({ id: 1, is_bot: true, username: "perry_e2e_bot" });
      if (method === "getUpdates") {
        if (telegram.pending.length) return reply(telegram.pending.splice(0));
        return void setTimeout(() => reply(telegram.pending.splice(0)), 1_000);
      }
      if (method === "sendMessage") { telegram.sent.push({ id: telegram.sent.length + 1, text: String(args.text) }); return reply({ message_id: telegram.sent.length }); }
      if (method === "editMessageText") return reply(true);
      if (method === "answerCallbackQuery") return reply(true);
      return reply(true);
    });
  });
  await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
  const ownerSays = (text: string) => telegram.pending.push({
    update_id: telegram.nextUpdate++,
    message: { message_id: telegram.nextUpdate, date: Math.floor(Date.now() / 1000), chat: { id: Number(OWNER), type: "private" }, from, text },
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex",
    TELEGRAM_BOT_TOKEN: "123456:computer-control-e2e",
    TELEGRAM_API_BASE: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
    PERRY_PET_DEVTOOLS_PORT: String(DEVTOOLS),
  };
  for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "NEXT_PUBLIC_CONVEX_URL" || name === "COMPOSIO_API_KEY") delete env[name];

  const logs = { server: "", target: "" };
  const server = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.on("data", (c: Buffer) => { logs.server += c; });
  server.stderr?.on("data", (c: Buffer) => { logs.server += c; });

  const call = async <T,>(path: string, args: object = {}): Promise<T> => {
    const response = await fetch(`${BASE}/api/backend/admin`, {
      method: "POST", headers: { "content-type": "application/json", "x-perry-key": KEY }, body: JSON.stringify({ path, args }),
    });
    const body = await response.json() as { value?: T; error?: string };
    if (body.error) throw new Error(`${path}: ${body.error}`);
    return body.value as T;
  };
  const tryCall = async <T,>(path: string, args: object = {}): Promise<{ value?: T; error?: string }> => {
    try { return { value: await call<T>(path, args) }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  };
  const until = async (test: () => Promise<boolean> | boolean, what: string, seconds = 30) => {
    for (let i = 0; i < seconds * 4; i++) {
      if (await Promise.resolve().then(test).catch(() => false)) return;
      await sleep(250);
    }
    throw new Error(`timed out: ${what}`);
  };
  const check = async (name: string, test: () => Promise<boolean> | boolean, seconds = 20) => {
    checks[name] = await until(test, name, seconds).then(() => true, () => { console.log(`FAILED: ${name}`); return false; });
    save();
  };
  const rowOf = async (id: string) => await call<Row | null>("computer:get", { id });
  const settled = async (id: string, what: string, seconds = 25) => {
    await until(async () => (await rowOf(id))?.status !== "asked", what, seconds);
    return await rowOf(id) as Row;
  };
  /** The pet's own Electron (installed by `perry pet`), which also runs the target window. */
  const petElectron = async () => {
    const found = spawnSync(process.execPath, ["-e", "process.stdout.write('\\n' + require('electron'))"], { cwd: join(REPO, "pet"), encoding: "utf8" });
    const path = found.status === 0 ? found.stdout.trim().split(/\r?\n/).pop()?.trim() : undefined;
    if (!path || !existsSync(path)) throw new Error("The pet's Electron is not installed yet (run `perry pet` once).");
    return path;
  };

  let target: ChildProcess | null = null;
  try {
    await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
    const { code } = await call<{ code: string }>("installation:startPairing");
    ownerSays(code);
    await until(async () => (await call<{ claimed: boolean }>("installation:status")).claimed, "the owner to be claimed", 30);
    // The owner's chat is created by their first message, as in any install.
    ownerSays("hello");
    await until(() => call<{ _id: string } | null>("conversations:getByExternalId", { channel: "telegram", externalId: OWNER }).then((chat) => Boolean(chat)), "the owner's chat", 60);
    const chatId = (await call<{ _id: string } | null>("conversations:getByExternalId", { channel: "telegram", externalId: OWNER }))!._id;
    notes.chatId = chatId;

    // 1. Off ⇒ ask refuses. (Unset means on, so it is turned off first.)
    await call("computer:setSetting", { key: KEY, enabled: false });
    const refused = await tryCall<{ error?: string }>("computer:ask", { conversationId: chatId, action: "front_app", args: {}, why: "check it refuses" });
    notes.refusedWhenOff = refused.value?.error ?? refused.error;
    checks.refusedWhenOff = Boolean(refused.value?.error ?? refused.error);
    await call("computer:setSetting", { key: KEY, enabled: true });

    // 2. No pet running yet ⇒ ask refuses rather than hanging.
    const noPet = await tryCall<{ error?: string }>("computer:ask", { conversationId: chatId, action: "front_app", args: {}, why: "before the pet is on" });
    notes.refusedWithoutPet = noPet.value?.error ?? noPet.error;
    checks.refusedWithoutPet = Boolean(noPet.value?.error ?? noPet.error);

    // 3. The pet, started against this Perry (`perry pet`).
    const started = spawnSync(process.execPath, [join(REPO, "scripts", "perry.ts"), "pet"], { cwd: REPO, env, encoding: "utf8" });
    notes.perryPet = `${started.stdout ?? ""}${started.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "").trim();
    await until(() => call<Row[]>("computer:asked", { key: KEY }).then(() => true, () => false), "the pet's page to answer", 60);

    // The target: a plain window of this script's own, run by the pet's own Electron (installed
    // by `perry pet` just above), logging every click and keystroke the OS delivers to it.
    const targetLog = join(tmpdir(), `computer-target-${PORT}.txt`);
    const electronPath = await petElectron();
    target = spawn(electronPath, [join(REPO, "artifacts", "computer-control", "target.js"), targetLog], { cwd: REPO, env: { ...env }, stdio: ["ignore", "pipe", "pipe"] });
    target.stdout?.on("data", (c: Buffer) => { logs.target += c; });
    target.stderr?.on("data", (c: Buffer) => { logs.target += c; });
    const targetText = () => { try { return readFileSync(targetLog, "utf8"); } catch { return ""; } };
    await until(() => targetText().includes("ready"), "the target window to open", 30);

    // 4. A read is taken and fulfilled with a real result.
    const front = await settled((await call<{ id: string }>("computer:ask", { conversationId: chatId, action: "front_app", args: {}, why: "read the app in front" })).id, "front_app");
    notes.frontApp = front;
    checks.fulfilsWithResult = front.status === "done" && typeof front.result === "object";

    // 5. move is accepted and lands (the helper reports where the pointer went).
    const move = await settled((await call<{ id: string }>("computer:ask", { conversationId: chatId, action: "move", args: { x: 0.5, y: 0.5, why: "to the middle" }, why: "move to the middle" })).id, "move");
    notes.move = move;
    checks.moveAccepted = move.status === "done";

    // 6. click really reaches the target window: the click must be logged there.
    const beforeClick = targetText().split("\n").filter(Boolean).length;
    await call("computer:ask", { conversationId: chatId, action: "click", args: { x: 0.5, y: 0.5, why: "click the target" }, why: "click the target" });
    await until(() => targetText().split("\n").filter(Boolean).length > beforeClick, "the click to reach the target", 25);
    checks.clickReachesTarget = targetText().split("\n").filter(Boolean).length > beforeClick;
    notes.targetLog = targetText().slice(0, 2000);

    // 7. type really reaches the focused target window: the marker must be typed there.
    // The click has just focused it; give it a beat before the keys go out.
    await sleep(1_200);
    const typeAsked = await call<{ id: string }>("computer:ask", { conversationId: chatId, action: "type", args: { text: MARKER, why: "type the marker" }, why: "type the marker" });
    await until(async () => (await rowOf(typeAsked.id))?.status !== "asked", "the typing to be done", 25);
    const typeRow = await rowOf(typeAsked.id);
    notes.type = typeRow;
    await until(() => targetText().includes(MARKER), "the marker to be typed into the target", 15).catch(() => {});
    checks.typeReachesTarget = targetText().includes(MARKER);
    notes.targetLog = targetText().slice(0, 2000);

    // 8. element_at reads something under a point.
    const element = await settled((await call<{ id: string }>("computer:ask", { conversationId: chatId, action: "element_at", args: { x: 0.5, y: 0.5, why: "what is there" }, why: "what is there" })).id, "element_at");
    notes.elementAt = element;
    checks.elementRead = element.status === "done";

    // 9. A point outside 0-1 is refused, not dispatched somewhere random.
    const bad = await tryCall<{ error?: string }>("computer:ask", { conversationId: chatId, action: "move", args: { x: 5, y: 0.5, why: "off the screen" }, why: "off the screen" });
    notes.badPoint = bad.value?.error ?? bad.error;
    checks.badPointRefused = Boolean(bad.value?.error ?? bad.error);

    notes.petState = existsSync(join(home, "pet.json"));
    notes.targetOutput = logs.target.slice(-2000);
    notes.serverTail = logs.server.slice(-1500);
  } finally {
    // `perry pet off` stops him and stops him starting at login, as every run that starts him must.
    spawnSync(process.execPath, [join(REPO, "scripts", "perry.ts"), "pet", "off"], { cwd: REPO, env, stdio: "ignore" });
    target?.kill("SIGTERM");
    server.kill("SIGTERM");
  }

  result.passed = Object.values(checks).every(Boolean);
  save();
  console.log(JSON.stringify({ passed: result.passed, checks }, null, 2));
}

main().catch((error) => {
  console.error(error);
  result.error = error instanceof Error ? error.message : String(error);
  result.passed = false;
  save();
  process.exit(1);
});