# Perry — Telegram bot with B2 Blackblaze storage, deployed on Render
# Optimized for minimal RAM usage (512MB Render free tier)
# Runs standalone Telegram bot (no Next.js dashboard UI)

# -------- Base --------
FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# -------- Dependencies (production only) --------
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# --production skips devDependencies; --ignore-scripts skips native build scripts
RUN pnpm install --production --frozen-lockfile --ignore-scripts

# -------- Build (needs bun for codegen) --------
FROM base AS build
WORKDIR /app
# Install bun only in build stage (not in runtime)
RUN apk add --no-cache curl && curl -fsSL https://bun.sh/install | bash -s "bun-v1.1.34"
ENV PATH=/root/.bun/bin:$PATH

COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate Convex types
RUN pnpm codegen 2>/dev/null || true
# Build Next.js app (needed for API routes used by dashboard)
RUN pnpm build 2>/dev/null || true

# -------- Run (minimal: standalone Telegram bot, no dashboard UI) --------
FROM base AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7377
ENV PERRY_HOME=/data/.perry
ENV PERRY_PORT=7377
ENV B2_KEY_ID=""
ENV B2_APPLICATION_KEY=""
ENV B2_BUCKET_NAME=""
ENV TELEGRAM_BOT_TOKEN=""
ENV DASHBOARD_KEY=""

# Copy only production node_modules (no devDeps)
COPY --from=deps /app/node_modules ./node_modules
# Copy build output and runtime files
COPY --from=build /app/convex ./convex
COPY --from=build /app/server ./server
COPY --from=build /app/instrumentation.ts ./instrumentation.ts
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json

# Persistent disk for SQLite database + local file storage
VOLUME ["/data"]

EXPOSE 7377

# Standalone Telegram bot — no Next.js dashboard, minimal RAM
CMD ["node", "server/telegram-bot.ts"]
