import { app, BrowserWindow, ipcMain } from "electron";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The target of the computer-control run: a plain window of the test's own that
 * logs every click and every keystroke the OS delivers to it. Perry's clicks and
 * typing are then checked against what landed *here* — the operating system —
 * rather than against what the pet said it did.
 *
 * Run by Electron: electron artifacts/computer-control/target.js <logPath>
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const logPath = process.argv[process.argv.length - 1];
const log = (line) => { try { appendFileSync(logPath, `${line}\n`); } catch {} };

ipcMain.on("target:event", (_event, line) => log(String(line)));

// A window can only be made once the app is ready.
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 760, height: 520, x: 100, y: 100,
    title: "Perry computer-control target",
    backgroundColor: "#ffffff",
    webPreferences: { preload: join(HERE, "target-preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.webContents.on("did-finish-load", () => { log("ready"); win.focus(); });
  void win.loadFile(join(HERE, "target.html"));
});

app.on("window-all-closed", () => app.quit());