"use client";

/**
 * Perry login page — password box for the protected dashboard home page.
 *
 * Simple form that posts to /api/auth/login. On success, sets an
 * perry_session cookie and redirects back to the requested page.
 */

import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const next =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("next") || "/"
      : "/";

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (response.ok) {
        window.location.href = next;
      } else {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        setError(data.error || "Wrong password.");
      }
    } catch {
      setError("Could not connect. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        background: "#0c0c0e",
        color: "#f2f2f4",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: 12,
          padding: 40,
          width: "100%",
          maxWidth: 360,
          boxShadow: "0 24px 48px -12px rgb(0 0 0 / 0.5)",
        }}
      >
        <h1
          style={{
            fontSize: 24,
            marginBottom: 8,
            letterSpacing: "-0.5px",
            fontWeight: 600,
          }}
        >
          Perry
        </h1>
        <p style={{ color: "#a1a1aa", marginBottom: 24, fontSize: 14 }}>
          Enter the password to access Perry's dashboard.
        </p>
        {error && (
          <div
            style={{
              color: "#ff7a70",
              fontSize: 13,
              marginBottom: 16,
              textAlign: "center",
            }}
          >
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              color: "#a1a1aa",
              marginBottom: 8,
            }}
          >
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            placeholder="••••••••"
            style={{
              width: "100%",
              padding: "12px 16px",
              fontSize: 16,
              border: "1px solid #27272a",
              borderRadius: 8,
              background: "#0c0c0e",
              color: "#f2f2f4",
              marginBottom: 16,
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%",
              padding: 12,
              fontSize: 16,
              fontWeight: 600,
              border: "none",
              borderRadius: 8,
              background: "#a1a1aa",
              color: "#0c0c0e",
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? "Signing in…" : "Unlock Perry"}
          </button>
        </form>
        <p
          style={{
            fontSize: 12,
            color: "#71717a",
            textAlign: "center",
            marginTop: 16,
          }}
        >
          Set or change your password with /password set in Telegram.
        </p>
      </div>
    </div>
  );
}
