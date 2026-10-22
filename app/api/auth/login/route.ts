/**
 * Perry login API — verifies the password and sets a session cookie.
 *
 * Reads PERRY_PASSWORD from environment (or .env.local). Can also be
 * changed via Telegram: /password set <new-password>.
 */

import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { password } = await request.json();
    const expected = process.env.PERRY_PASSWORD;

    if (!expected) {
      return NextResponse.json({ error: "No password is configured." }, { status: 400 });
    }

    // Constant-time comparison
    if (password.length !== expected.length) {
      return NextResponse.json({ error: "Wrong password." }, { status: 401 });
    }
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= password.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (diff !== 0) {
      return NextResponse.json({ error: "Wrong password." }, { status: 401 });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set("perry_session", "authenticated", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
}
