import { AboutYouStep } from "./onboarding/AboutYouStep";
import { rigel } from "@/lib/desktop";

/**
 * Full-screen first-run gate. When the captured name/email is missing, the app
 * renders ONLY this: a graphite page with a centered card that reuses the
 * AboutYouStep form. Submitting persists the durable profile (via submitSignup)
 * and calls onDone, after which App renders the real app.
 */
export function AccountGate({ onDone }: { onDone: () => void }) {
  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "var(--surface-sunken)",
      }}
    >
      <div
        style={{
          width: 400,
          maxWidth: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 22,
          padding: 28,
          background: "#101012",
          border: "1px solid rgba(255,255,255,0.10)",
          borderRadius: 16,
          boxShadow: "0 30px 80px rgba(0,0,0,0.44)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent-primary)" }} />
            <span
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 1.5,
                color: "var(--accent-primary)",
              }}
            >
              RIGEL
            </span>
          </div>
          <span style={{ fontSize: 18, fontWeight: 600, color: "var(--fg-primary)" }}>Welcome to Rigel</span>
        </div>
        <AboutYouStep submitSignup={(d) => rigel!.submitSignup(d)} onDone={onDone} />
      </div>
    </div>
  );
}
