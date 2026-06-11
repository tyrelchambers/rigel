/**
 * Login gate shown when the server has an admin password configured and this
 * browser has no valid session cookie. A correct password sets an httpOnly
 * session cookie (server-side) and the app renders.
 */
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useLogin } from "@/lib/api";

export function LoginScreen() {
  const login = useLogin();
  const [password, setPassword] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password) login.mutate(password);
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0A0A0A",
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: "min(360px, 90vw)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          padding: 24,
          background: "#141417",
          border: "1px solid #2A2A2A",
          borderRadius: 12,
          boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Sparkles size={18} style={{ color: "#A855F7" }} />
          <span style={{ fontSize: 16, fontWeight: 600, color: "#FFFFFF" }}>Helmsman</span>
        </div>
        <span style={{ fontSize: 12, color: "#A1A1AA" }}>Enter the admin password to continue.</span>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          style={{
            padding: "9px 12px",
            borderRadius: 8,
            background: "#0A0A0C",
            border: "1px solid #2A2A2A",
            color: "#FFFFFF",
            fontSize: 13,
            outline: "none",
          }}
        />
        {login.isError && (
          <span style={{ fontSize: 12, color: "#EF4444" }}>{login.error.message}</span>
        )}
        <button
          type="submit"
          disabled={!password || login.isPending}
          style={{
            padding: "9px 12px",
            borderRadius: 8,
            background: "#A855F7",
            color: "#FFFFFF",
            fontSize: 13,
            fontWeight: 500,
            border: "none",
            cursor: password && !login.isPending ? "pointer" : "default",
            opacity: !password || login.isPending ? 0.5 : 1,
          }}
        >
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
