/**
 * Perry middleware — password-protects the web dashboard home page.
 *
 * When PERRY_PASSWORD is set, all dashboard routes require a valid
 * perry_session cookie. API routes, static assets, and the login page
 * are always accessible.
 *
 * Set PERRY_PASSWORD via:
 *   - .env.local (local development)
 *   - Render environment variables (production)
 *   - Telegram: /password set <your-password>
 */

import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = [
  "/login",
  "/api/auth",
  "/api/backend",
  "/_next",
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const password = process.env.PERRY_PASSWORD;
  // Also check if password is set in Perry's secret store (via env is enough for middleware)
  if (!password) {
    // No password configured — dashboard is open
    return NextResponse.next();
  }

  // Password is configured — check for session cookie
  const session = request.cookies.get("perry_session");
  if (session && session.value === "authenticated") {
    return NextResponse.next();
  }

  // No valid session — redirect to login
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)"],
};
