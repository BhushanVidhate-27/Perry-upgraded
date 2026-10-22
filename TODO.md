# Perry -> Telegram Bot + B2 Blackblaze + Render (Optimized)

## Goal
Perry as a Telegram-controlled bot with B2 Blackblaze storage, deployed on Render with minimal RAM usage.

## ✅ Completed

### Dependencies Cleaned Up
Removed unused/heavy packages from `package.json`:
- `@huggingface/transformers` (heavy ML library — not needed)
- `@composio/core` (third-party integrations — not needed for basic bot)
- `backblaze-b2` (we use native fetch B2 API instead)
- `qrcode`, `turndown` (not needed for server)
- `baileys` (WhatsApp — optional, removed)
- `@anthropic-ai/claude-agent-sdk` (optional, removed)
- `@agentclientprotocol/sdk` (not needed for basic bot)
- Removed all devDependencies from production install

### Modular Code Structure
- **`convex/lib/b2.ts`** — standalone B2 client (authorize, upload, download, list, delete)
- **`convex/lib/commands.ts`** — all Telegram commands (`/storage`, `/system`, `/web`, `/model`, `/think`, `/access`, etc.)
- **`convex/media.ts`** — B2-aware media handling (`b2Creds`, `b2FileId` on attachments)
- **`convex/files.ts`** — `toOwner` sends B2 files via Telegram
- **`server/telegram-bot.ts`** — standalone entry point (no Next.js dashboard)

### RAM-Optimized Dockerfile
- Multi-stage build (base → deps → build → run)
- `pnpm install --production --frozen-lockfile --ignore-scripts` (no devDeps, no build scripts)
- Bun only in build stage (not runtime)
- Standalone `node server/telegram-bot.ts` instead of `next start` (no dashboard UI overhead)
- Only copies necessary files to runtime image

### Render Config
- **`render.yaml`** — persistent disk (10GB at `/data`), health check, env vars
- Health check: `/api/backend/http/health`

### Typecheck
- `pnpm typecheck` passes with no errors in `convex/` or `server/`

## Telegram Commands (Owner-Authorized)
| Command | What it does |
|---------|-------------|
| `/help` | List all commands |
| `/model` | List/switch AI models |
| `/think` | Set thinking level |
| `/access` | Set access mode (ask/auto/full) |
| `/usage` | Show model plan usage |
| `/pause` / `/resume` | Pause/resume Perry |
| `/status` | System status |
| `/note <text>` | Save a note |
| `/storage` | List files in B2 |
| `/storage get <name>` | Download a file from B2 |
| `/storage del <name>` | Delete a file from B2 |
| `/system` | Perry health + B2/Telegram config |
| `/web <url>` | Fetch URL and save to B2 |

## Setup Steps

### 1. B2 Blackblaze
Create bucket at backblaze.com, get Key ID + Application Key

### 2. Telegram Bot
Message @BotFather → `/newbot` → save bot token

### 3. Deploy to Render
- Connect GitHub repo → use Dockerfile
- Add persistent disk: `/data` (10GB)
- Set env vars: `TELEGRAM_BOT_TOKEN`, `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME`, `DASHBOARD_KEY`
- Deploy

### 4. Pair & Configure
- Get pairing code from Perry logs
- Message bot on Telegram with pairing code
- Add B2 keys in Settings → Logins & secrets (or via dashboard)

## Model
Nemotron 3.5 Lightning Free (current). For complex tasks, consider Claude 3.5 Sonnet or GPT-4o.

## Notes
- Telegram long-polling (no webhook needed — works on Render)
- `/control` (pet computer control) is macOS-only, NOT available on Render (Linux)
- No Next.js dashboard UI loaded — minimal RAM footprint
