# Perry -> Telegram Bot + B2 Blackblaze + Render (Optimized + Password Protected)

## Goal
Perry as a Telegram-controlled bot with B2 Blackblaze storage, deployed on Render with minimal RAM usage. Web dashboard is password-protected.

## ✅ Completed

### Dependencies Cleaned Up
Removed from `package.json`:
- `@huggingface/transformers`, `@composio/core`, `@agentclientprotocol/sdk`
- `backblaze-b2` (native B2 REST API used instead)
- `qrcode`, `turndown`, `baileys`, `@anthropic-ai/claude-agent-sdk`
- All devDependencies excluded from production install

### Modular Code Structure
| Module | Responsibility |
|--------|---------------|
| `convex/lib/b2.ts` | B2 client (authorize/upload/download/list/delete) |
| `convex/lib/commands.ts` | All Telegram commands |
| `convex/media.ts` | B2-aware media attachments |
| `convex/files.ts` | Send B2 files via Telegram |
| `server/telegram-bot.ts` | Standalone entry (no Next.js dashboard UI) |
| `app/middleware.ts` | Password-protection middleware |
| `app/login/page.tsx` | Password box page |
| `app/api/auth/login/route.ts` | Login verification API |
| `app/api/auth/logout/route.ts` | Logout API |

### Password Protection
- `PERRY_PASSWORD` env var (or `.env.local`) protects the dashboard home page
- Middleware redirects unauthenticated users to `/login`
- Login API verifies password and sets `perry_session` cookie (30 days)
- Telegram commands: `/password set <pw>`, `/password reset`, `/password status`
- Password stored in Perry's secret store (database) via Telegram; middleware reads from env var

### Telegram Commands (Owner-Authorized)
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
| `/storage get <name>` | Download from B2 |
| `/storage del <name>` | Delete from B2 |
| `/system` | Perry health + B2/Telegram config |
| `/web <url>` | Fetch URL and save to B2 |
| `/password set <pw>` | Set dashboard password |
| `/password reset` | Remove password |
| `/password status` | Check password status |

### RAM-Optimized Dockerfile
- Multi-stage build (base → deps → build → run)
- `pnpm install --production --frozen-lockfile --ignore-scripts`
- Bun only in build stage
- `node server/telegram-bot.ts` instead of `next start` (no dashboard UI overhead)

### Render Config
- `render.yaml` — persistent disk (10GB at `/data`), health check, env vars
- Health check: `/api/backend/http/health`

### Typecheck
- `convex/` and `server/` files: **no errors**
- Remaining `next` module errors are pre-existing (need `pnpm install`)

## Setup Steps

### 1. B2 Blackblaze
Create bucket at backblaze.com, get Key ID + Application Key

### 2. Telegram Bot
Message @BotFather → `/newbot` → save bot token

### 3. Deploy to Render
- Connect GitHub repo → use Dockerfile
- Add persistent disk: `/data` (10GB)
- Set env vars:
  - `TELEGRAM_BOT_TOKEN` — from @BotFather
  - `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME` — from B2
  - `PERRY_PASSWORD` — your chosen dashboard password
  - `DASHBOARD_KEY` — long random string
- Deploy

### 4. Pair & Configure
- Get pairing code from Perry logs
- Message bot on Telegram with pairing code
- Use `/password set <your-password>` to protect dashboard
- Add B2 keys via Settings → Logins & secrets (or env vars)

## Model
Nemotron 3.5 Lightning Free (current). For complex tasks, consider Claude 3.5 Sonnet or GPT-4o.

## Notes
- Telegram long-polling (no webhook needed — works on Render)
- `/control` (pet computer control) is macOS-only, NOT available on Render (Linux)
- Dashboard password: set via env var `PERRY_PASSWORD` or Telegram `/password set`
- Login page is at `/login`, session cookie lasts 30 days
