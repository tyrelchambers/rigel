import { ShieldCheck } from "lucide-react";
import { kindLabel, type ValueKind } from "./configmapsDisplay";

// Detected value-kind badge, shared by the ConfigMap expanded-row detail and the
// edit modal so the CERTIFICATE / JSON / YAML / TEXT / BINARY treatment stays
// identical in both places. Certificate is green (with a shield), JSON/YAML take
// the accent, plain text and binary are neutral.
export function KindBadge({ kind }: { kind: ValueKind | "binary" }) {
  const label = kind === "binary" ? "BINARY" : kindLabel(kind);
  const toneClass =
    kind === "certificate"
      ? "bg-[var(--status-running)]/[0.12] text-[var(--status-running)]"
      : kind === "json" || kind === "yaml"
        ? "bg-[var(--accent-primary)]/[0.12] text-[var(--accent-primary)]"
        : "bg-white/[0.05] text-[var(--fg-tertiary)]";
  return (
    <span
      className={`inline-flex items-center gap-[5px] rounded-sm px-[8px] py-[2px] font-mono text-[10.5px] tracking-[0.5px] ${toneClass}`}
    >
      {kind === "certificate" && <ShieldCheck className="size-[11px]" />}
      {label}
    </span>
  );
}
