import { type NextRequest, NextResponse } from "next/server";
import { dashboardPassword, passwordMatches, sessionToken } from "@/convex/lib/dashboardPassword";

/**
 * Checks the dashboard password and, when it matches, sets the session cookie.
 * The password comes from PERRY_PASSWORD or from /password in Telegram; see
 * convex/lib/dashboardPassword.ts. No password configured means no one can
 * log in, so the proxy lets everyone through instead.
 */
export async function POST(request: NextRequest) {
  let password: string;
  try {
    ({ password } = (await request.json()) as { password: string });
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (typeof password !== "string") {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const expected = dashboardPassword();
  if (!expected) {
    return NextResponse.json({ error: "No password is configured." }, { status: 400 });
  }
  if (!passwordMatches(password, expected)) {
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set("perry_session", sessionToken(expected), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
