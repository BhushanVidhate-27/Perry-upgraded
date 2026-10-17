import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertDashboardKey } from "./lib/auth";
import { runningPets } from "./todos";

export const COMPUTER_WAIT_MS = 30_000;

export type ComputerRequest = { id: Id<"computerActions">; action: string; args: any };

export const ask = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    action: v.string(),
    args: v.any(),
    why: v.string(),
  },
  returns: v.union(v.object({ id: v.id("computerActions") }), v.object({ error: v.string() })),
  handler: async (ctx, args) => {
    const install = await ctx.db.query("installation").first();
    if (install?.computerControl === false) return { error: "The owner turned off letting you control the computer (Settings → Desktop pet). Tell them you'd like to use it." };
    const chat = await ctx.db.get(args.conversationId);
    if (!chat || chat.jobId || (chat as { taskId?: unknown }).taskId) return { error: "You can control the computer only in a chat with the owner, not in a scheduled job or a background task." };
    const [pet] = await runningPets(ctx);
    if (!pet) return { error: "The desktop pet is not running. Ask the owner to turn it on (Settings → Desktop pet). Paste a screenshot if you need to work from one." };
    const id = await ctx.db.insert("computerActions", {
      conversationId: args.conversationId,
      action: args.action,
      args: args.args,
      why: args.why.slice(0, 200),
      status: "asked",
      createdAt: Date.now(),
      device: pet.device,
    });
    return { id };
  },
});

export const get = internalQuery({
  args: { id: v.id("computerActions") },
  handler: async (ctx, args): Promise<Doc<"computerActions"> | null> => await ctx.db.get(args.id),
});

export const giveUp = internalMutation({
  args: { id: v.id("computerActions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row?.status === "asked") await ctx.db.patch(row._id, { status: "failed", error: "The desktop pet did not answer in time." });
    return null;
  },
});

export const asked = query({
  args: { key: v.string(), device: v.optional(v.id("petDevices")) },
  handler: async (ctx, args): Promise<ComputerRequest[]> => {
    assertDashboardKey(args.key);
    const rows = await ctx.db.query("computerActions").withIndex("by_status", (q) => q.eq("status", "asked").gt("createdAt", Date.now() - COMPUTER_WAIT_MS)).collect();
    return rows.filter((row) => row.device === args.device).map((row) => ({ id: row._id, action: row.action, args: row.args }));
  },
});

export const fulfil = mutation({
  args: { key: v.string(), id: v.id("computerActions"), result: v.optional(v.any()), error: v.optional(v.string()), device: v.optional(v.id("petDevices")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const row = await ctx.db.get(args.id);
    if (!row || row.status !== "asked" || row.device !== args.device) return null;
    if (args.result !== undefined) {
      await ctx.db.patch(row._id, { status: "done", result: args.result });
    } else {
      await ctx.db.patch(row._id, { status: "failed", error: (args.error ?? "The desktop pet could not complete that action.").slice(0, 800) });
    }
    return null;
  },
});

export const getSetting = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    assertDashboardKey(args.key);
    return (await ctx.db.query("installation").first())?.computerControl !== false;
  },
});

export const setSetting = mutation({
  args: { key: v.string(), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    if (!install) throw new Error("Run pnpm run setup first.");
    await ctx.db.patch(install._id, { computerControl: args.enabled });
    return null;
  },
});
