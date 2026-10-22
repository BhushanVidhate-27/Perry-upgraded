#!/usr/bin/env node
/**
 * Perry Telegram Bot — standalone entry point.
 *
 * Runs Perry's backend (SQLite + Convex functions) + Telegram long-polling
 * without the Next.js dashboard UI. Use this on Render for minimal RAM usage.
 *
 * Usage: node server/telegram-bot.ts
 */

import { backend, startBackend } from "./index";

// Start Perry's backend: SQLite, Convex functions, crons, Telegram polling
startBackend().then(() => {
  console.log("[perry] Telegram bot running — waiting for messages...");
}).catch((error) => {
  console.error("[perry] Failed to start backend:", error);
  process.exit(1);
});

// Handle graceful shutdown
process.on("SIGTERM", () => {
  console.log("[perry] Shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[perry] Shutting down...");
  process.exit(0);
});
