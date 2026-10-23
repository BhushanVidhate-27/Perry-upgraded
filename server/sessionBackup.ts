import { createHash } from "node:crypto";
import { b2Upload, type B2Creds } from "../convex/lib/b2";
import type { Doc } from "./db";
import type { Runtime } from "./runtime";

type Snapshot = {
  version: 1;
  conversation: Doc;
  runs: Doc[];
  turns: Doc[];
  spans: Doc[];
  attachments: Doc[];
  createdAt: string;
  updatedAt: number;
};

const pending = new Map<string, ReturnType<typeof setTimeout>>();

function keyFor(chat: Doc): string {
  return createHash("sha256").update(`${chat.channel}:${String(chat.externalId)}`).digest("hex").slice(0, 32);
}

function snapshotName(chat: Doc, at: string): string {
  return `perry/sessions/${chat.channel}/${keyFor(chat)}/${at}.json`;
}

function latestName(chat: Doc): string {
  return `perry/sessions/${chat.channel}/${keyFor(chat)}/latest.json`;
}

async function credentials(runtime: Runtime): Promise<B2Creds | null> {
  const read = async (name: string) => (await runtime.runQuery("secrets:get", { name }, { internal: true })).value as string | null;
  const keyId = process.env.B2_KEY_ID ?? await read("B2_KEY_ID");
  const applicationKey = process.env.B2_APPLICATION_KEY ?? await read("B2_APPLICATION_KEY");
  const bucketName = process.env.B2_BUCKET_NAME ?? await read("B2_BUCKET_NAME");
  return keyId && applicationKey && bucketName ? { keyId, applicationKey, bucketName } : null;
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function save(runtime: Runtime, chat: Doc): Promise<void> {
  const creds = await credentials(runtime);
  if (!creds) return;
  const snapshot = await runtime.exclusive(() => {
    const conversationId = chat._id;
    const runs = runtime.store.all("runs").filter((row) => row.conversationId === conversationId);
    const turns = runtime.store.all("codexTurns").filter((row) => row.conversationId === conversationId);
    const runIds = new Set(runs.map((row) => row._id));
    const spans = runtime.store.all("runSpans").filter((row) => runIds.has(String(row.runId)));
    const attachments = runtime.store.all("chatAttachments").filter((row) => row.conversationId === conversationId);
    const at = new Date().toISOString();
    return {
      version: 1 as const,
      conversation: chat,
      runs,
      turns,
      spans,
      attachments,
      createdAt: at,
      updatedAt: chat.lastMessageAt as number,
    };
  });
  const at = snapshot.createdAt;
  const bytes = jsonBytes(snapshot);
  await b2Upload(creds, { fileName: snapshotName(chat, at), contentType: "application/json", bytes });
  await b2Upload(creds, { fileName: latestName(chat), contentType: "application/json", bytes });
  console.log(`[perry] saved session context to B2: ${chat.channel}/${keyFor(chat)}`);
}

function schedule(runtime: Runtime, chat: Doc): void {
  const existing = pending.get(chat._id);
  if (existing) clearTimeout(existing);
  pending.set(chat._id, setTimeout(() => {
    pending.delete(chat._id);
    void save(runtime, chat).catch((error) => {
      console.error(`[perry] could not save session context to B2: ${String(error)}`);
    });
  }, 2_000));
}

/** Save settled conversations after a completed turn, without running B2 inside a SQLite transaction. */
export function startSessionBackups(runtime: Runtime): () => void {
  const onChange = (tables: string[]) => {
    if (!tables.some((table) => table === "codexTurns" || table === "conversations" || table === "runs")) return;
    for (const chat of runtime.store.all("conversations")) {
      if ((chat.pendingTurns ?? 0) === 0 && (chat.lastMessageAt as number) > Date.now() - 60_000) schedule(runtime, chat);
    }
  };
  runtime.events.on("change", onChange);
  return () => {
    runtime.events.off("change", onChange);
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  };
}
