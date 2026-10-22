import { NextResponse, type NextRequest } from "next/server";
import { oldSettingsTab } from "@/lib/settings";
import { dashboardPassword, validSession } from "@/convex/lib/dashboardPassword";

/**
 * /settings is no page of its own: it opens on General, and the old tabs'
 * links (/settings?tab=…, from bookmarks, older pets and Perry's past
 * messages) land on the section their tab became, the query left behind.
 * A redirect in next.config.ts would carry ?tab= along, and one from a page
 * comes once the page has begun, as a 200; here it is a plain 307.
 *
 * The same file guards the dashboard: when a password is set (PERRY_PASSWORD,
 * or /password in Telegram), every page needs a session cookie. Assets, the
 * login page and the backend's own routes (which check DASHBOARD_KEY) pass.
 * Proxy runs on the Node runtime, so the password file is readable here.
 */

const PUBLIC = ["/login", "/api/auth", "/api/backend", "/api/media", "/_next", "/favicon.ico", "/icon.svg", "/robots.txt"];

const isPublic = (pathname: string) => PUBLIC.some((path) => pathname === path || pathname.startsWith(`${path}/`));

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === "/settings") {
    const query = request.nextUrl.searchParams;
    return NextResponse.redirect(new URL(oldSettingsTab(query.get("tab") ?? undefined, query.get("key") ?? undefined), request.url));
  }

  if (isPublic(pathname)) return NextResponse.next();

  const password = dashboardPassword();
  if (!password) return NextResponse.next();

  if (validSession(request.cookies.get("perry_session")?.value, password)) return NextResponse.next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/settings", "/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
