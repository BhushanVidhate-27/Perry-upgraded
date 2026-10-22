import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../runner/home";

/**
 * The dashboard password, in one place for the two halves that need it: the
 * proxy (which decides whether a page may load) and the login route (which
 * checks it). Telegram's /password writes the same file, so a password set
 * from the bot works on the next request without a restart.
 *
 * PERRY_PASSWORD, when set, wins: an operator's env file should not be
 * silently overridden by a chat command.
 */

const FILE = join(HOME, "dashboard-password");

/** The password in force, or null when the dashboard is open. */
export function dashboardPassword(): string | null {
  const fromEnv = process.env.PERRY_PASSWORD?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = readFileSync(FILE, "utf8").trim();
    return fromFile || null;
  } catch {
    return null;
  }
}

/** Set it from Telegram. Only the owner can reach this path (brain.ts). */
export function setDashboardPassword(value: string): void {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(FILE, `${value.trim()}\n`, { mode: 0o600 });
}

/** Remove it from Telegram. A PERRY_PASSWORD in the environment still applies. */
export function clearDashboardPassword(): void {
  rmSync(FILE, { force: true });
}

/** Constant time, so a wrong password is not recovered a character at a time. */
export function passwordMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * What the session cookie holds: proof of the password, not the password.
 * Keyed with DASHBOARD_KEY so a cookie cannot be forged, and changes when the
 * password or the key does, which signs everyone out.
 */
export function sessionToken(password: string): string {
  return createHmac("sha256", process.env.DASHBOARD_KEY ?? "perry").update(password).digest("hex");
}

export function validSession(cookie: string | undefined, password: string | null): boolean {
  if (!password || !cookie) return false;
  return passwordMatches(cookie, sessionToken(password));
}
