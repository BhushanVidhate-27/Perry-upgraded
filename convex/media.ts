import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { assertDashboardKey } from "./lib/auth";
import { index } from "./library";
import { b2Upload, b2Download, type B2Creds } from "./lib/b2";

/**
 * Local media: chat files that stay on the owner's machine, wherever the agent
 * or the upload inbox put them. The row records the absolute path; the Next.js
 * server on that machine serves the file from there, by attachment id, and
 * only for rows that exist, so nothing unregistered is ever reachable.
 *
 * Files can also live in B2 Blackblaze cloud storage (b2FileId on the row),
 * which is what Perry uses when deployed to Render. B2 credentials come from
 * the owner's saved secrets (B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME).
 */
export const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  avif: "image/avif", bmp: "image/bmp", heic: "image/heic", aac: "audio/aac", flac: "audio/flac", opus: "audio/ogg", oga: "audio/ogg",
  log: "text/plain", html: "text/html", htm: "text/html", xml: "application/xml", rtf: "application/rtf", zip: "application/zip",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function describePath(path: string): { fileName: string; contentType: string } {
  const fileName = path.split(/[\\/]/).pop() || "file";
  const extension = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  return { fileName, contentType: TYPES[extension] ?? "application/octet-stream" };
}

const attachmentShape = v.object({
  url: v.optional(v.string()),
  localPath: v.optional(v.string()),
  b2FileId: v.optional(v.string()),
  fileName: v.string(),
  contentType: v.string(),
});

/** B2 credential names kept in the owner's Logins & secrets. */
const B2_KEY_ID_SECRET = "B2_KEY_ID";
const B2_APP_KEY_SECRET = "B2_APPLICATION_KEY";
const B2_BUCKET_SECRET = "B2_BUCKET_NAME";

/** Resolve B2 credentials from the owner's saved secrets. */
export async function b2Creds(ctx: ActionCtx | MutationCtx | QueryCtx): Promise<B2Creds | null> {
  const keyId = await ctx.runQuery(internal.secrets.get, { name: B2_KEY_ID_SECRET });
  const appKey = await ctx.runQuery(internal.secrets.get, { name: B2_APP_KEY_SECRET });
  const bucket = await ctx.runQuery(internal.secrets.get, { name: B2_BUCKET_SECRET });
  if (!keyId || !appKey || !bucket) return null;
  return { keyId, applicationKey: appKey, bucketName: bucket };
}

/** Resolve a queued turn's files without exposing storage ids. Local files go by path; B2 files get a download URL. */
export const forTurn = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    attachmentIds: v.array(v.id("chatAttachments")),
  },
  returns: v.array(attachmentShape),
  handler: async (ctx, args) => {
    const creds = await b2Creds(ctx);
    const result: Array<{ url?: string; localPath?: string; b2FileId?: string; fileName: string; contentType: string }> = [];
    for (const id of args.attachmentIds as Id<"chatAttachments">[]) {
      const row = await ctx.db.get(id);
      if (!row || row.conversationId !== args.conversationId || row.removedAt) continue;
      if (row.localPath) {
        result.push({ localPath: row.localPath, fileName: row.fileName, contentType: row.contentType });
        continue;
      }
      if (row.b2FileId && creds) {
        result.push({ b2FileId: row.b2FileId, fileName: row.fileName, contentType: row.contentType });
        continue;
      }
      const url = row.storageId ? await ctx.storage.getUrl(row.storageId) : null;
      if (url) result.push({ url, fileName: row.fileName, contentType: row.contentType });
    }
    return result;
  },
});

/** A file downloaded from Telegram, stored and attached to the message it came with. When B2 credentials are
 * configured, the file bytes are uploaded to B2 Blackblaze and the row keeps the B2 file id. */
export const attachStored = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    messageKey: v.string(),
    storageId: v.optional(v.id("_storage")),
    /** B2 Blackblaze file id, when the file was already uploaded to B2. */
    b2FileId: v.optional(v.string()),
    /** B2: upload these base64-encoded bytes to Blackblaze instead of Convex storage. */
    bytes: v.optional(v.string()),
    fileName: v.string(),
    contentType: v.string(),
    size: v.number(),
  },
  returns: v.id("chatAttachments"),
  handler: async (ctx, args) => {
    let b2FileId: string | undefined = args.b2FileId;
    let storageId: Id<"_storage"> | undefined = args.storageId;

    if (args.bytes && !storageId && !b2FileId) {
      // Upload to B2 Blackblaze when credentials are configured.
      const creds = await b2Creds(ctx);
      if (creds) {
        const fileBytes = Buffer.from(args.bytes, "base64");
        b2FileId = await b2Upload(creds, {
          fileName: args.fileName,
          contentType: args.contentType,
          bytes: fileBytes,
        });
      } else {
        throw new Error("No B2 credentials configured. Set B2_KEY_ID, B2_APPLICATION_KEY and B2_BUCKET_NAME in Settings → Logins & secrets.");
      }
    }

    const id = await ctx.db.insert("chatAttachments", {
      conversationId: args.conversationId,
      messageKey: args.messageKey,
      ...(storageId ? { storageId } : {}),
      ...(b2FileId ? { b2FileId } : {}),
      fileName: args.fileName,
      contentType: args.contentType,
      size: args.size,
      createdAt: Date.now(),
    });
    await index(ctx, id);
    return id;
  },
});

/** The local media server asks this before accepting an upload. */
export const canStoreLocally = query({
  args: { key: v.string() },
  returns: v.boolean(),
  handler: async (_ctx, args) => {
    assertDashboardKey(args.key);
    return true;
  },
});

/** Where a local attachment lives, for the local media server. */
export const localAttachment = query({
  args: { key: v.string(), id: v.string() },
  returns: v.union(v.null(), v.object({ localPath: v.string(), fileName: v.string(), contentType: v.string() })),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const id = ctx.db.normalizeId("chatAttachments", args.id);
    const row = id ? await ctx.db.get(id) : null;
    return row?.localPath && !row.removedAt ? { localPath: row.localPath, fileName: row.fileName, contentType: row.contentType } : null;
  },
});

/** Codex's share_file: show a file from the owner's machine in the reply to this turn. A look is the pet's picture of the screen (look_at_screen). */
export const shareFromTurn = internalMutation({
  args: { turnId: v.id("codexTurns"), path: v.string(), look: v.optional(v.boolean()) },
  returns: v.object({ fileName: v.string(), contentType: v.string() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.turnId);
    if (!job) throw new Error("This turn is gone.");
    if (!ABSOLUTE_PATH.test(args.path)) throw new Error("Give the file's absolute path.");
    const described = describePath(args.path);
    const mediaKey = `codex-${job._id}`;
    const existing = await ctx.db.query("chatAttachments")
      .withIndex("by_message", (q) => q.eq("conversationId", job.conversationId).eq("messageKey", mediaKey))
      .collect();
    if (!existing.some((row) => row.localPath === args.path)) {
      const id = await ctx.db.insert("chatAttachments", {
        conversationId: job.conversationId,
        messageKey: mediaKey,
        localPath: args.path,
        ...described,
        size: 0,
        createdAt: Date.now(),
      });
      await index(ctx, id, args.look ? { how: "look", from: "pet", by: "perry" } : {});
    }
    await ctx.db.patch(job._id, { mediaKey });
    return described;
  },
});

/** share_file with a Library item's id: the item's file, wherever it is, shown in the reply to this turn. */
export const shareFromLibrary = internalMutation({
  args: { turnId: v.id("codexTurns"), id: v.string() },
  returns: v.object({ fileName: v.string(), contentType: v.string() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.turnId);
    if (!job) throw new Error("This turn is gone.");
    const chat = await ctx.db.get(job.conversationId);
    if (!chat || chat.contactId) throw new Error("A chat with someone else has no Library.");
    const itemId = ctx.db.normalizeId("library", args.id);
    const item = itemId ? await ctx.db.get(itemId) : null;
    if (!item) throw new Error("There is no Library item with that id; library_find shows them.");
    if (item.conversationId && (await ctx.db.get(item.conversationId))?.contactId) throw new Error("A chat with someone else has no Library.");
    const mediaKey = `codex-${job._id}`;
    const existing = await ctx.db.query("chatAttachments")
      .withIndex("by_message", (q) => q.eq("conversationId", job.conversationId).eq("messageKey", mediaKey))
      .collect();
    if (!existing.some((row) => (item.localPath && row.localPath === item.localPath) || (item.storageId && row.storageId === item.storageId))) {
      await ctx.db.insert("chatAttachments", {
        conversationId: job.conversationId,
        messageKey: mediaKey,
        ...(item.localPath ? { localPath: item.localPath } : { storageId: item.storageId }),
        fileName: item.name,
        contentType: item.contentType,
        size: item.size,
        createdAt: Date.now(),
      });
    }
    await ctx.db.patch(job._id, { mediaKey });
    return { fileName: item.name, contentType: item.contentType };
  },
});

/** The message key of the files a run's steps link to: kept apart from every message's. */
export const stepsKey = (runId: string) => `steps-${runId}`;

/**
 * A picture of Perry's browser for a step in the chat (tools.ts, browser),
 * registered so the local media server serves it; its id goes in the step's
 * result. Kept apart from the reply's own files.
 */
export const attachPreview = internalMutation({
  args: { conversationId: v.id("conversations"), path: v.string() },
  returns: v.id("chatAttachments"),
  handler: async (ctx, args) => {
    if (!ABSOLUTE_PATH.test(args.path)) throw new Error("Give the picture's absolute path.");
    return await ctx.db.insert("chatAttachments", {
      conversationId: args.conversationId,
      messageKey: "steps",
      localPath: args.path,
      ...describePath(args.path),
      size: 0,
      createdAt: Date.now(),
    });
  },
});
