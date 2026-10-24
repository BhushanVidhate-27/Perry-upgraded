# Perry — Telegram bot + web dashboard, deployed on an Azure VM.
#
# Node 22 because Perry's backend uses the built-in `node:sqlite` module.
# The dashboard (Next.js) is the server: its instrumentation starts Perry's
# backend in the same process, and Telegram is polled from there.
#
# The runner (Bun) runs beside it in the container and drives OpenCode, whose
# bundled models are free and need no sign-in, so the bot can answer.
#
# Debian, not Alpine: career-ops renders CV PDFs with Playwright's Chromium,
# which is built against glibc. Alpine would need a rebuild of the browser.

# -------- Base --------
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# -------- Dependencies --------
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# -------- Build --------
FROM deps AS build
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV PERRY_SKIP_BUILD_TYPECHECK=1
RUN pnpm build

# -------- Run --------
FROM base AS run
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=7377
ENV PERRY_HOME=/data/.perry
ENV PERRY_PORT=7377

# Bun runs runner/index.ts; OpenCode is the engine (opencode/ models are free).
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git unzip \
 && rm -rf /var/lib/apt/lists/*

# career-ops (in the workspace, on the volume) renders PDFs with Playwright's
# Chromium. Baked in at the version career-ops pins, so its own install finds
# the browser already there and a container recreate needs no download.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g playwright@1.64.1 \
 && playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"
RUN curl -fsSL https://opencode.ai/v2/install | bash
ENV PATH=/root/.bun/bin:/root/.opencode/bin:$PATH

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/instrumentation.ts ./instrumentation.ts
COPY --from=build /app/proxy.ts ./proxy.ts
COPY --from=build /app/next-env.d.ts ./next-env.d.ts
COPY --from=build /app/app ./app
COPY --from=build /app/convex ./convex
COPY --from=build /app/server ./server
COPY --from=build /app/runner ./runner
COPY --from=build /app/lib ./lib
COPY --from=build /app/client ./client
COPY --from=build /app/components ./components

COPY --from=build /app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 7377
CMD ["./docker-entrypoint.sh"]
