/**
 * Perry controlling the computer the desktop pet runs on (issue #101's sibling):
 * the model's `use_computer` tool (convex/computer.ts, convex/mcp.ts) asks, the pet's page
 * asks this over `pet:act` (pet/main.js), and the action happens here — the real pointer
 * and keys, not Perry's own browser.
 *
 * On a Mac the work is done by `perry-input`, a small Swift helper built from pet/input.swift
 * with swiftc the first time it is needed (no third-party code): CGEvent for move/click/drag/
 * scroll/type/key, NSWorkspace for the app in front, and the Accessibility API to read the
 * element under a point. macOS silently drops events from a helper it does not trust, so the
 * helper says so rather than pretending it moved. Accessibility is the helper's, not this
 * app's (System Settings → Privacy & Security → Accessibility); the grant is by path, so
 * rebuilding the helper in place keeps it, and `perry-control` (scripts/perry-control.ts)
 * runs the same helper without Electron in the loop at all.
 *
 * Coordinates are normalized (0-1) against the picture the model was shown, mapped here to the
 * display's own points, so Retina scale and the picture's cap cannot drift.
 */
import { screen } from "electron";
import { capture } from "./look.js";
import { ensureBinary, frontPid, run as jsonRun } from "./input.js";

/**
 * A point normalized (0-1) on the picture, as this display's own points.
 * Clamped: a point off the picture is the edge of the screen, never somewhere
 * outside it, so a bad coordinate cannot move the pointer off the desktop.
 */
function mapPoint(nx, ny, display) {
  const u = Math.min(1, Math.max(0, Number.isFinite(nx) ? nx : 0.5));
  const v = Math.min(1, Math.max(0, Number.isFinite(ny) ? ny : 0.5));
  const { x, y, width, height } = display.bounds;
  return {
    x: Math.round(x + u * width),
    y: Math.round(y + v * height),
  };
}

/**
 * A fresh picture of the screen after something changed it, so the model sees
 * the effect before its next move and stale coordinates cannot chain into a
 * second mistaken click. Best effort: an action that worked is not a failure
 * because the picture could not be taken.
 */
async function afterActing(display, own) {
  try {
    const shot = await capture(own, { x: display.bounds.x + display.bounds.width / 2, y: display.bounds.y + display.bounds.height / 2 });
    const whole = shot.screen ?? shot.window;
    if (!whole) return {};
    return { screen: { image: whole.image, display: { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height, scale: display.scaleFactor } } };
  } catch {
    return {};
  }
}

export async function act(action, args = {}, own = []) {
  if (process.platform !== "darwin") return { ok: false, error: "Computer control is only implemented on macOS in this build." };
  try {
    await ensureBinary();
  } catch (error) {
    // Without the helper nothing moves, and macOS silently drops events from a helper it cannot run.
    return { ok: false, error: `Perry could not build the macOS input helper (swiftc). ${error instanceof Error ? error.message : String(error)}` };
  }
  const display = screen.getPrimaryDisplay();
  switch (action) {
    case "look": {
      // The same picture look_at_screen takes (look.js), so control sees the screen it is about to act on.
      const shot = await capture(own, { x: display.bounds.x + display.bounds.width / 2, y: display.bounds.y + display.bounds.height / 2 }).catch((error) => ({ error: String(error) }));
      if (shot.error) return { ok: false, error: shot.error };
      const whole = shot.screen ?? shot.window;
      if (!whole) return { ok: false, error: "Perry couldn't take a picture of the screen." };
      return { ok: true, result: { seen: whole.name, image: whole.image, display: { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height, scale: display.scaleFactor } } };
    }
    case "front_app": {
      const r = await jsonRun(["front"]);
      return r.ok ? { ok: true, result: r } : { ok: false, error: r.error };
    }
    case "element_at": {
      const nx = Number(args.x ?? 0.5);
      const ny = Number(args.y ?? 0.5);
      const p = mapPoint(nx, ny, display);
      const r = await jsonRun(["element", String(Math.round(p.x)), String(Math.round(p.y))]);
      if (!r.ok) return { ok: false, error: r.error };
      // What a control is, for the approval: its label and role. Its value is screen content, not a label, so it is
      // cut short and left out of what decides a click (see mcp.ts); a title is what a button says.
      const { value, description, ...rest } = r;
      return { ok: true, result: { ...rest, ...(description ? { description: String(description).slice(0, 200) } : {}), ...(typeof value === "string" && value ? { value: value.slice(0, 200) } : {}) } };
    }
    case "move": {
      const nx = Number(args.x ?? 0.5);
      const ny = Number(args.y ?? 0.5);
      const p = mapPoint(nx, ny, display);
      const r = await jsonRun(["move", String(p.x), String(p.y)]);
      return r.ok ? { ok: true, result: r } : { ok: false, error: r.error };
    }
    case "click": {
      const nx = Number(args.x ?? 0.5);
      const ny = Number(args.y ?? 0.5);
      const button = args.button === "right" ? "right" : "left";
      const clicks = Math.max(1, Math.min(2, Number(args.clicks ?? 1)));
      const p = mapPoint(nx, ny, display);
      const r = await jsonRun(["click", String(p.x), String(p.y), button, String(clicks)]);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, result: { ...r, ...(await afterActing(display, own)) } };
    }
    case "drag": {
      const nx1 = Number(args.x ?? 0.5), ny1 = Number(args.y ?? 0.5);
      const nx2 = Number(args.toX ?? nx1), ny2 = Number(args.toY ?? ny1);
      const p1 = mapPoint(nx1, ny1, display);
      const p2 = mapPoint(nx2, ny2, display);
      const r = await jsonRun(["drag", String(p1.x), String(p1.y), String(p2.x), String(p2.y)]);
      return r.ok ? { ok: true, result: r } : { ok: false, error: r.error };
    }
    case "scroll": {
      const dx = Number(args.dx ?? 0);
      const dy = Number(args.dy ?? -120);
      // The helper wants a point to scroll at, which is wherever the pointer already is.
      const at = await jsonRun(["pointer"]);
      const r = await jsonRun(["scroll", String(at.x ?? 0), String(at.y ?? 0), String(dy), String(dx)]);
      return r.ok ? { ok: true, result: r } : { ok: false, error: r.error };
    }
    case "type": {
      const text = String(args.text ?? "");
      const pid = await frontPid();
      const r = await jsonRun(pid ? ["type", text, String(pid)] : ["type", text]);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, result: { ...r, ...(await afterActing(display, own)) } };
    }
    case "key": {
      const keys = String(args.keys ?? "");
      const pid = await frontPid();
      const r = await jsonRun(pid ? ["key", keys, String(pid)] : ["key", keys]);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, result: { ...r, ...(await afterActing(display, own)) } };
    }
    case "open_app": {
      const app = String(args.app ?? "");
      const r = await jsonRun(["open", app]);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, result: { ...r, ...(await afterActing(display, own)) } };
    }
    default: {
      return { ok: false, error: `Unknown action: ${action}` };
    }
  }
}
