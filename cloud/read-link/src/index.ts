/**
 * Perry's link reader, in the cloud.
 *
 * Perry, on the owner's machine, sends one link here. This Worker gets the real
 * media (never only metadata), keeps the file in R2, transcribes the audio with
 * Workers AI Whisper, and answers with the transcript and the R2 key. Perry then
 * decides what to do with it: add what it lists to the calendar, save a to-do,
 * write a note, and so on.
 *
 * Why the cloud: social platforms block plain server fetches, and the owner's
 * machine may be asleep. Workers are always up. The trade — accepted by the
 * owner — is that the media leaves the owner's machine. See README.md.
 *
 * The downloader is a pluggable resolver. Today it is cobalt (cobalt.tools),
 * an open-source downloader that answers with a direct media URL for the Worker
 * to stream. Swap `resolveVideo` / `resolveAudio` for another resolver without
 * touching the rest.
 */

export interface Env {
  /** R2 bucket holding every downloaded file. */
  MEDIA: R2Bucket;
  /** Workers AI, for Whisper. */
  AI: Ai;
  /** Shared secret Perry sends as a bearer token (`wrangler secret put PIPELINE_TOKEN`). */
  PIPELINE_TOKEN: string;
  /** cobalt instance to resolve links with. Defaults to the public one. */
  COBALT_URL?: string;
  /** cobalt API key, when the instance asks for one (`wrangler secret put COBALT_API_KEY`). */
  COBALT_API_KEY?: string;
}

const DEFAULT_COBALT = "https://api.cobalt.tools";
/** Longest audio to transcribe in one go, kept inside the Worker's memory. */
const MAX_AUDIO_BYTES = 90 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

type Media = { url: string; filename?: string };
type Answer = { transcript: string; r2Key?: string; title?: string };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return json({ error: "Use POST." }, 405);
    if (!env.PIPELINE_TOKEN || bearer(request) !== env.PIPELINE_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }
    let body: { url?: unknown };
    try {
      body = (await request.json()) as { url?: unknown };
    } catch {
      return json({ error: "Body must be JSON." }, 400);
    }
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!/^https?:\/\/\S+$/i.test(url)) return json({ error: "Give a public http(s) link." }, 400);
    try {
      return json(await read(url, env), 200);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  },
} satisfies ExportedHandler<Env>;

/** Get the real media, keep it, transcribe it. */
async function read(url: string, env: Env): Promise<Answer> {
  // The full file, stored for later. A failure here does not stop the transcript.
  let r2Key: string | undefined;
  let title: string | undefined;
  try {
    const media = await resolveVideo(url, env);
    title = media.filename;
    const download = await fetch(media.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (download.ok && download.body) {
      r2Key = keyFor(media.filename);
      await env.MEDIA.put(r2Key, download.body, {
        httpMetadata: { contentType: download.headers.get("content-type") ?? "video/mp4" },
      });
    }
  } catch {
    // Nothing stored; the transcript below still matters.
  }

  // Audio only, so Whisper need not decode a video.
  const audio = await resolveAudio(url, env);
  const bytes = await fetchBytes(audio.url);
  if (bytes.byteLength === 0) throw new Error("The downloader returned no audio.");
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error("The audio is too long to transcribe in one go.");

  const heard = (await env.AI.run("@cf/openai/whisper", {
    audio: [...new Uint8Array(bytes)],
  } as never)) as unknown as { text?: string };

  return { transcript: (heard.text ?? "").trim(), r2Key, title };
}

/** A direct URL to the file, from cobalt. */
async function resolveVideo(url: string, env: Env): Promise<Media> {
  return await resolve(url, env, { downloadMode: "auto" });
}

/** A direct URL to audio only, so Whisper need not decode a video. */
async function resolveAudio(url: string, env: Env): Promise<Media> {
  return await resolve(url, env, { downloadMode: "audio", audioFormat: "mp3" });
}

type Mode = { downloadMode: "auto" | "audio"; audioFormat?: string };

async function resolve(url: string, env: Env, mode: Mode): Promise<Media> {
  const endpoint = env.COBALT_URL || DEFAULT_COBALT;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(env.COBALT_API_KEY ? { authorization: `Api-Key ${env.COBALT_API_KEY}` } : {}),
    },
    body: JSON.stringify({ url, videoQuality: "720", filenameStyle: "basic", ...mode }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await response.json().catch(() => null)) as CobaltAnswer | null;
  if (!response.ok || !data) throw new Error(`The downloader answered ${response.status}.`);
  const direct = directUrl(data);
  if (!direct) {
    const reason = data.error ? (data.error.code ?? "error") : (data.status ?? "no url");
    throw new Error(`The downloader could not get this link (${reason}).`);
  }
  return direct;
}

type CobaltAnswer = {
  status?: string;
  url?: string;
  filename?: string;
  picker?: Array<{ url?: string }>;
  error?: { code?: string };
};

/** cobalt answers with a single url, or a picker of several. */
function directUrl(data: CobaltAnswer): Media | null {
  if (typeof data.url === "string" && data.url) return { url: data.url, filename: data.filename };
  const first = data.picker?.find((item) => typeof item.url === "string");
  return first?.url ? { url: first.url } : null;
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Fetching the media returned ${response.status}.`);
  return await response.arrayBuffer();
}

function bearer(request: Request): string {
  return (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

function keyFor(filename?: string): string {
  const ext = (filename?.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? "mp4").toLowerCase();
  return `links/${crypto.randomUUID()}.${ext}`;
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
