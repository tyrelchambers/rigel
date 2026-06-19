import { useState } from "react";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "7px 10px",
  borderRadius: 7,
  background: "var(--surface-sunken)",
  border: "1px solid #34353A",
  color: "var(--fg-primary)",
  fontSize: 12,
  outline: "none",
};

const primaryBtnStyle: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  background: "var(--accent-primary)",
  color: "var(--fg-inverse)",
  fontSize: 12.5,
  fontWeight: 500,
  border: "none",
  cursor: "pointer",
};

export function AboutYouStep({
  submitSignup,
  onDone,
}: {
  submitSignup: (d: { name: string; email: string }) => Promise<{ ok: true }>;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length > 0 && EMAIL.test(email.trim());

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      await submitSignup({ name: name.trim(), email: email.trim() });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <span style={{ fontSize: 12.5, color: "var(--fg-secondary)", lineHeight: 1.5 }}>
        Tell us who you are to get started — so we know who's using Rigel.
      </span>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5 }}>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" style={inputStyle} />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5 }}>
        Email
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="jane@acme.com"
          type="email"
          style={inputStyle}
        />
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="submit"
          disabled={!valid || busy}
          style={{ ...primaryBtnStyle, opacity: !valid || busy ? 0.6 : 1 }}
        >
          {busy ? "Saving…" : "Continue →"}
        </button>
      </div>
    </form>
  );
}
