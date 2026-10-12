import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { resolve, sep } from "node:path";
import { assertDashboardKey } from "./lib/auth";
import { runningPets } from "./todos";
import { PATHS } from "../runner/home";

/**
 * Perry looking at the screen when he needs to (issue #101): in a chat, the
 * look_at_screen tool (mcp.ts) asks here, the desktop pet takes the picture
 * as its Look hotkey does (pet/look.js) and saves it, and the tool hands it
 * to Codex and shows it in the chat, so the owner sees whatever he saw. Only
 * with the pet running, only in a chat with the owner, and never once they
 * turned it off in Settings. With pets on more than one computer, the one
 * the owner touched last is asked: the screen they are at.
 */

/** A request the pet has not taken by then is dropped: the tool has stopped waiting. */
export const LOOK_WAIT_MS = 30_000;

export type LookRequest = { id: Id<"screenLooks">; which: "window" | "screen"; why: string };

/** Ask the pet for a picture. Returns the request, or why Perry cannot look now. */
export const ask = internalMutation({
  args: { conversationId: v.id("conversations"), which: v.union(v.literal("window"), v.literal("screen")), why: v.string() },
  returns: v.union(v.object({ id: v.id("screenLooks") }), v.object({ error: v.string() })),
  handler: async (ctx, args) => {
    const install = await ctx.db.query("installation").first();
    if (install?.screenLook === false) return { error: "The owner turned off letting you look at the screen (Settings → Desktop pet). Ask them to show you with the Look hotkey instead." };
    const chat = await ctx.db.get(args.conversationId);
    // A background task works in a chat of its own (taskId, once background tasks are in); the owner is not reading it either.
    if (!chat || chat.jobId || (chat as { taskId?: unknown }).taskId) return { error: "You can look at the screen only in a chat with the owner, not in a scheduled job or a background task." };
    const [pet] = await runningPets(ctx);
    if (!pet) return { error: "The desktop pet is not running, and it is what sees the screen. Ask the owner to turn it on (Settings → Desktop pet), or to paste a screenshot." };
    const id = await ctx.db.insert("screenLooks", { conversationId: args.conversationId, which: args.which, why: args.why.slice(0, 200), status: "asked", createdAt: Date.now(), device: pet.device });
    return { id };
  },
});

export const get = internalQuery({
  args: { id: v.id("screenLooks") },
  handler: async (ctx, args): Promise<Doc<"screenLooks"> | null> => await ctx.db.get(args.id),
});

/** The tool stopped waiting: a request the pet never took is dropped. */
export const giveUp = internalMutation({
  args: { id: v.id("screenLooks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row?.status === "asked") await ctx.db.patch(row._id, { status: "failed", error: "The desktop pet did not answer in time." });
    return null;
  },
});

/**
 * For each pet: the pictures Perry is waiting for from it now. `device`, set
 * by the server from a paired pet's key, is which pet; none is the one on
 * Perry's own computer.
 */
export const asked = query({
  args: { key: v.string(), device: v.optional(v.id("petDevices")) },
  handler: async (ctx, args): Promise<LookRequest[]> => {
    assertDashboardKey(args.key);
    const rows = await ctx.db.query("screenLooks").withIndex("by_status", (q) => q.eq("status", "asked").gt("createdAt", Date.now() - LOOK_WAIT_MS)).collect();
    return rows.filter((row) => row.device === args.device).map((row) => ({ id: row._id, which: row.which, why: row.why }));
  },
});

/** The pet took the picture and saved it (or could not, and says why). Only the pet asked can answer. */
export const fulfil = mutation({
  args: { key: v.string(), id: v.id("screenLooks"), path: v.optional(v.string()), name: v.optional(v.string()), error: v.optional(v.string()), device: v.optional(v.id("petDevices")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const row = await ctx.db.get(args.id);
    if (!row || row.status !== "asked" || row.device !== args.device) return null;
    // The tool reads the picture from here and hands it to Codex, so it must be one the pet just saved, in the uploads folder.
    if (args.path && !resolve(args.path).startsWith(resolve(PATHS.uploads) + sep)) throw new Error("The picture must be saved in Perry's uploads folder.");
    await ctx.db.patch(row._id, args.path
      ? { status: "done", path: args.path, ...(args.name ? { name: args.name } : {}) }
      : { status: "failed", error: (args.error ?? "The desktop pet could not take the picture.").slice(0, 500) });
    return null;
  },
});

export const getSetting = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    assertDashboardKey(args.key);
    return (await ctx.db.query("installation").first())?.screenLook !== false;
  },
});

export const setSetting = mutation({
  args: { key: v.string(), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    if (!install) throw new Error("Run pnpm run setup first.");
    await ctx.db.patch(install._id, { screenLook: args.enabled });
    return null;
  },
});

// --- Watching the screen on a timer (the watch_my_screen tool) ---------------

/**
 * Perry watching the screen over time so it can follow something that changes
 * by itself ("tell me when the build finishes", "watch for the download to
 * start"). Only ever the owner's own ask, only in a chat with them, and only
 * for as long as they asked: no watch starts by itself or runs forever. Each
 * tick pictures the screen exactly as look_at_screen does (ask -> the pet ->
 * fulfil), so a watched screen needs nothing new of the pet and the owner sees
 * every picture in their chat as it is taken.
 */
const MIN_EVERY_MS = 30_000;
const MAX_EVERY_MS = 5 * 60_000;
const MAX_WATCH_MS = 30 * 60_000;

export const startWatch = internalMutation({
  args: { conversationId: v.id("conversations"), everyMs: v.number(), which: v.union(v.literal("window"), v.literal("screen")), why: v.string() },
  returns: v.union(v.object({ id: v.id("screenWatches"), until: v.number(), everyMs: v.number() }), v.object({ error: v.string() })),
  handler: async (ctx, args) => {
    const install = await ctx.db.query("installation").first();
    if (install?.screenLook === false) return { error: "The owner turned off letting you look at the screen (Settings -> Desktop pet). Ask them to turn it on, or to show you a picture." };
    const chat = await ctx.db.get(args.conversationId);
    // Only with the owner reading along; a job or background task has no one watching a watch.
    if (!chat || chat.jobId || (chat as { taskId?: unknown }).taskId) return { error: "You can watch the screen only in a chat with the owner, not in a scheduled job or a background task." };
    const everyMs = Math.min(Math.max(Math.round(args.everyMs), MIN_EVERY_MS), MAX_EVERY_MS);
    const until = Date.now() + MAX_WATCH_MS;
    const id = await ctx.db.insert("screenWatches", { conversationId: args.conversationId, which: args.which, why: args.why.slice(0, 200), everyMs, until, status: "on", createdAt: Date.now() });
    return { id, until, everyMs };
  },
});

export const stopWatch = internalMutation({
  args: { id: v.id("screenWatches") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row && row.status === "on") await ctx.db.patch(row._id, { status: "stopped" });
    return null;
  },
});

/** The owner's own watches still on, so a turn can see them and stop one. */
export const watches = internalQuery({
  args: { conversationId: v.id("conversations") },
  returns: v.array(v.object({ id: v.id("screenWatches"), which: v.string(), why: v.string(), everyMs: v.number(), until: v.number() })),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("screenWatches").withIndex("by_status", (q) => q.eq("status", "on")).collect();
    return rows.filter((row) => row.conversationId === args.conversationId).map((row) => ({ id: row._id, which: row.which, why: row.why, everyMs: row.everyMs, until: row.until }));
  },
});

/**
 * The tick (crons.ts): every watch that is due gets one picture asked of the
 * pet, exactly as a one-off look is. A watch past its own `until` stops
 * itself, so a forgotten watch never keeps looking. The request is an ordinary
 * screenLooks row, so the pet, the waiting tool and "shown in the chat" all
 * already work for it.
 */
export const tickWatches = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const now = Date.now();
    const due: Array<Doc<"screenWatches">> = await ctx.runQuery(internal.screen.dueWatches, { now });
    for (const watch of due) {
      const asked = await ctx.runMutation(internal.screen.ask, {
        conversationId: watch.conversationId, which: watch.which, why: `watching: ${watch.why}`,
      });
      // Asked (a screenLooks row now waits on the pet), or refused (no pet, turned off): either way the tick is recorded.
      await ctx.runMutation(internal.screen.watchTick, { id: watch._id, asked: "id" in asked, at: now });
    }
    return null;
  },
});

/** Watches on, whose next picture is due and that have not run their course. */
export const dueWatches = internalQuery({
  args: { now: v.number() },
  returns: v.array(v.any()),
  handler: async (ctx, args): Promise<Array<Doc<"screenWatches">>> => {
    const rows = await ctx.db.query("screenWatches").withIndex("by_status", (q) => q.eq("status", "on")).collect();
    return rows.filter((row) => row.until > args.now && (row.lastAt ?? row.createdAt) + row.everyMs <= args.now);
  },
});

/** Record that a due watch has asked for a picture, and stop one whose ask was refused (no pet, or turned off). */
export const watchTick = internalMutation({
  args: { id: v.id("screenWatches"), asked: v.boolean(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.status !== "on") return null;
    if (!args.asked) await ctx.db.patch(row._id, { status: "stopped" });
    else await ctx.db.patch(row._id, { lastAt: args.at });
    return null;
  },
});
