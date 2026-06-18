// Shared form primitives for the GitOps add-repo/add-deployment dialogs.

export function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-xs font-medium" style={{ color: "var(--fg-secondary)" }}>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        style={{
          padding: "8px 10px",
          borderRadius: 8,
          background: "#08080A",
          border: "1px solid #26272B",
          color: "var(--fg-primary)",
          fontSize: 13,
          fontFamily: type === "password" || label.includes("URL") || label.includes("path") ? "ui-monospace, monospace" : undefined,
          outline: "none",
        }}
      />
    </label>
  );
}

/** Pulsing placeholders shown while the repo list loads. */
export function FormSkeleton() {
  const bar = (w: string, h = 34) => (
    <div className="animate-pulse rounded-md" style={{ width: w, height: h, background: "rgba(255,255,255,0.10)" }} />
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        {bar("70px", 12)}
        {bar("100%")}
      </div>
      <div className="flex gap-3">
        {bar("100%")}
        {bar("100%")}
        {bar("100%")}
      </div>
    </div>
  );
}
