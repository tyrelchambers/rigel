export function Stepper({ labels, current }: { labels: string[]; current: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
      {labels.map((label, i) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            aria-current={i === current ? "step" : undefined}
            style={{
              width: 8, height: 8, borderRadius: 8,
              background: i <= current ? "var(--accent-primary)" : "var(--border)",
            }}
          />
          {i < labels.length - 1 && <span style={{ width: 14, height: 1, background: "var(--border)" }} />}
        </div>
      ))}
      <span style={{ marginLeft: 8, fontSize: 11.5, color: "var(--fg-secondary)" }}>
        Step {current + 1} of {labels.length} · {labels[current]}
      </span>
    </div>
  );
}
