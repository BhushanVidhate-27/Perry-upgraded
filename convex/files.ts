import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import { loadConversation } from "./brain";
import { saveMessages } from "./lib/agent";
import { describePath } from "./media";
import { sendFile } from "./lib/telegram";
import type { Target } from "./channels";

/**
 * Putting a file or a screenshot in front of the owner on their phone. The
 * model could only send words (send_message is text; notify.deliver is text),
 * so anything it made, or a picture of the screen it took, stopped at the
 * dashboard. This is the way out: the owner's own Telegram chat, where the
 * words go too, and nothing anywhere else.
 *
 * Telegram shows a picture as a photo and everything else as a document
 * (lib/telegram.ts, sendFile), so a screenshot needs nothing special here: it
 * is a png on disk and goes as a photo. The file must be one Perry already has
 * a handle to — a path it saved, a look it took, or a Library item — so nothing
 * is read out of an arbitrary place on the machine.
 */

/** The largest a file may be to go this way, under Telegram's own 50 MB cap. */
const MAX_BYTES = 45 * 1024 * 1024;

/** Read a local file as the Blob sendFile uploads. Missing or unreadable is an error the tool shows. */
async function readFile(path: string): Promise<{ blob: Blob; fileName: string; contentType: string }> {
  const { readFile: read, stat } = await import("node:fs/promises");
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new Error(`There is no file at ${path}.`);
  }
  if (size > MAX_BYTES) throw new Error(`${path.split(/[\\/]/).pop()} is ${(size / 1048576).toFixed(1)} MB, over the ${MAX_BYTES / 1048576} MB this sends.`);
  const bytes = await read(path);
  const { fileName, contentType } = describePath(path);
  return { blob: new Blob([bytes], { type: contentType }), fileName, contentType };
}

/**
 * The owner's own Telegram chat, and nothing else: the target for this
 * conversation resolves to the owner's channel (channels.ts), and a Telegram
 * target is only the owner when the install says this chat id is theirs (the
 * same check notify.ts makes before it will send a word). A web owner has no
 * phone to send to and is told so.
 */
async function ownerTelegram(ctx: ActionCtx): Promise<{ chatId: string; conversationId?: string }> {
  const target: Target | null = await ctx.runQuery(internal.channels.target, {});
  if (!target || target.channel !== "telegram") throw new Error("The owner has no Telegram chat connected to send this to.");
  const install: { ownerChannel?: string; ownerExternalId?: string; claimedAt?: number } | null =
    await ctx.runQuery(internal.installation.get, {});
  if (!install?.claimedAt || install.ownerChannel !== "telegram" || install.ownerExternalId !== target.externalId) {
    throw new Error("This Telegram chat is not the owner's; files go only to their own chat.");
  }
  return { chatId: target.externalId, conversationId: target.conversationId };
}

/**
 * Send one file from this computer to the owner's Telegram and keep it in that
 * chat's history, so the turn that sent it and the next turn there both know a
 * file went. `path` is the file on disk (a saved file, or a look the pet took;
 * a Library item is resolved to its file by the tool before it gets here). The
 * token comes from the saved secret, never from the caller.
 */
export const toOwner = internalAction({
  args: {
    /** Absolute path on this computer of the file to send (a saved file, or a look the pet took). */
    path: v.string(),
    /** What the file is, in a few words: the dashboard shows it beside the send. */
    why: v.string(),
    /** A note under the file on Telegram (Markdown, sent as HTML). */
    caption: v.optional(v.string()),
    /** The chat this came from, so the send can be mirrored into its history too when it is the owner's own Telegram. */
    origin: v.optional(v.id("conversations")),
  },
  returns: v.union(
    v.object({ sent: v.boolean(), name: v.string(), note: v.optional(v.string()) }),
    v.object({ error: v.string() }),
  ),
  handler: async (ctx, args): Promise<{ sent: boolean; name: string; note?: string } | { error: string }> => {
    const path = args.path;
    try {
      const owner = await ownerTelegram(ctx);
      const file = await readFile(path);
      const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
      if (!token) return { error: "There is no Telegram bot set up to send this from. The owner can add one in Settings → Telegram." };
      await sendFile(token, owner.chatId, {
        blob: file.blob,
        fileName: file.fileName,
        contentType: file.contentType,
        ...(args.caption ? { caption: args.caption } : {}),
      });
      // It belongs to that chat: shown in its history and told to the next turn there, as notify does for words.
      const conversation = await ctx.runQuery(internal.conversations.getByExternalId, { channel: "telegram", externalId: owner.chatId });
      const chat = conversation ?? (await loadConversation(ctx, "telegram", owner.chatId));
      await saveMessages(ctx, {
        threadId: chat.threadId,
        messages: [{ role: "assistant", content: `Sent the owner ${file.fileName} on Telegram (${args.why}).` }],
      });
      return { sent: true, name: file.fileName };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
});