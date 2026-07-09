import type { ReactNode } from "react";

export function Stepper({ labels, current, status }: { labels: string[]; current: number; status?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          {labels.map((label, i) => (
            <div key={label} style={{ display: "flex", alignItems: "center" }}>
              <span
                aria-current={i === current ? "step" : undefined}
                style={{ width: 9, height: 9, borderRadius: 999, background: i <= current ? "var(--accent-primary)" : "#FFFFFF26" }}
              />
              {i < labels.length - 1 && <span style={{ width: 22, height: 2, background: "#FFFFFF14" }} />}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="text-sm" style={{ fontWeight: 600, color: "var(--fg-secondary)" }}>Step {current + 1} of {labels.length}</span>
          <span className="text-sm" style={{ color: "var(--fg-tertiary)" }}>· {labels[current]}</span>
        </div>
      </div>
      {status}
    </div>
  );
}
