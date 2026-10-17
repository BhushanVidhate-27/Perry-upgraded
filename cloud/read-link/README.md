# Perry's link reader (cloud)

When the owner shares a link with Perry, Perry sends it here. This Worker
downloads the **real media**, stores the file in R2, transcribes the audio with
the free Workers AI Whisper model, and answers with the transcript. Perry then
acts on it: adds what it lists to the calendar, saves a to-do, writes a note.

It exists because social platforms block plain fetches from Perry's own machine,
and that machine may be asleep. Running this in the cloud means the media leaves
the owner's machine — a deliberate trade.

## Stack (all free tier)

| Piece | Service | Notes |
| --- | --- | --- |
| Run the code | Workers | 100k requests/day free |
| Store the files | R2 | 10 GB free, no egress fee |
| Transcribe | Workers AI `@cf/openai/whisper` | free daily allowance; ~$0.00045/audio-min after |
| Resolve the link | cobalt (`COBALT_URL`) | open-source downloader; point it at a publicly reachable instance of your own |

## One-time setup

Prerequisites on your Cloudflare account (Dashboard): enable **R2** and
**Workers AI**, and register a **workers.dev** subdomain. `wrangler` needs all
three before the commands below will work.

```sh
cd cloud/read-link
pnpm install
pnpm wrangler login                 # opens the browser; pick your Cloudflare account
pnpm wrangler r2 bucket create perry-link-media
pnpm deploy                         # prints the Worker URL, e.g. https://perry-read-link.<you>.workers.dev
printf '%s' 'YOUR-LONG-RANDOM-STRING' | pnpm wrangler secret put PIPELINE_TOKEN
```

Then in Perry: **Settings → Keys**, set

- `PIPELINE_URL` = the deployed Worker URL (the full `https://…workers.dev`),
- `PIPELINE_TOKEN` = the same random string.

Now a video link in chat works: Perry calls `read_link`, and the transcript comes
back for it to act on.

## cobalt

The Worker resolves links by POSTing to `COBALT_URL`. **The public instance
(`https://api.cobalt.tools`) is not usable here as-is:** cobalt's own docs say
the hosted instance "uses bot protection and is not intended to be used in
other projects", so it answers with a Turnstile challenge this Worker cannot
solve, and its YouTube support is currently withdrawn. Point `COBALT_URL` at
your own cobalt 11 instance.

Where that instance runs matters: **a Cloudflare Worker cannot reach
`localhost` or a private address.** A cobalt running on your own laptop, at
`http://127.0.0.1:9000`, is invisible to the Worker. Host it somewhere public —
a small VPS, Fly, Railway, a Cloudflare Container, or a tunnel — and set
`COBALT_URL` (in `wrangler.toml` `[vars]`, then `pnpm deploy`) to its public
HTTPS origin.

If your instance wants a key, `printf '%s' 'KEY' | pnpm wrangler secret put COBALT_API_KEY`.

## Limits and honesty

- **Whisper model.** This uses `@cf/openai/whisper`, a legacy English-only
  model that takes raw audio bytes. It is valid but not the current path:
  `@cf/openai/whisper-large-v3-turbo` (base64, chunked) is Cloudflare's
  recommendation for anything long. Moving to it is a later step.
- **Workers memory and CPU.** The audio is rejected over 90 MB, but a raw byte
  array near that size can still exceed the 128 MB isolate limit, and the free
  plan's 10 ms CPU/request is far below what a multi-megabyte array costs.
  Long audio should be chunked (Cloudflare publishes a tutorial for exactly
  this); until then, keep clips short or run on a paid plan.
- **R2 has no TTL yet**, so stored media accumulates against the 10 GB free
  tier. Add a lifecycle rule once you know your usage.
- **The stored file is not readable by Perry yet.** The answer includes an
  `r2Key`, but no tool fetches it back, so R2 is storage-only for now.
- **Login-gated or DRM-protected posts** (private Instagram, paid video) will
  fail; the resolver says so and Perry tells the owner rather than inventing.
- **No ffmpeg here.** Audio comes straight from cobalt (`downloadMode: "audio"`),
  so no container or paid plan is needed. On-screen text (slides) is not read
  yet — that needs frame sampling and is a later step.
- Downloading public content is the owner's own responsibility (cobalt's own
  stance: it only fetches free, public content, and caches nothing).

## Develop

```sh
pnpm dev        # wrangler dev, local
pnpm typecheck
pnpm tail       # live logs from the deployed Worker
```
