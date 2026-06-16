/**
 * StatusBar — thin bottom chrome bar (full width, below the main row).
 * Mirrors StatusBar.swift:
 *   LEFT  : "{namespace} · pods N · nodes N"  (counts from store)
 *   RIGHT : "kubectl: ok/error" dot · "claude: idle" · hint chips
 *             ⌘K Commands · / Search · ⌘L Chat
 */
import { useEffect, useState } from "react";
import { useCluster } from "@/store/cluster";

interface HealthData {
  context?: string;
  ok?: boolean;
}

export default function StatusBar() {
  const connected = useCluster((s) => s.connected);
  const resources = useCluster((s) => s.resources);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [health, setHealth] = useState<HealthData>({});

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setHealth(d as HealthData))
      .catch(() => {/* ignore — optional */});
  }, []);

  const podCount = Object.keys(resources["pods"] ?? {}).length;
  const nodeCount = Object.keys(resources["nodes"] ?? {}).length;

  const kubectlOk = connected && !error;
  const statusColor = kubectlOk ? "var(--status-running)" : "var(--status-failed)";
  const statusLabel = kubectlOk ? "kubectl: ok" : "kubectl: error";

  // Namespace label for left side — use context name or namespace filter
  const namespaceLabel = namespaceFilter ?? health.context ?? null;

  return (
    <div
      style={{
        height: 22,
        background: "var(--surface-sunken)",
        borderTop: "1px solid #26272B",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 12px",
        flexShrink: 0,
      }}
    >
      {/* LEFT: namespace · pods N · nodes N */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {namespaceLabel && (
          <MonoChip>{namespaceLabel}</MonoChip>
        )}
        {podCount > 0 && (
          <>
            {namespaceLabel && <Sep />}
            <MonoChip>pods {podCount}</MonoChip>
          </>
        )}
        {nodeCount > 0 && (
          <>
            {(podCount > 0 || namespaceLabel) && <Sep />}
            <MonoChip>nodes {nodeCount}</MonoChip>
          </>
        )}
      </div>

      <div style={{ flex: 1 }} />

      {/* RIGHT: kubectl status · claude idle · hint chips */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* kubectl dot + label */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: statusColor,
              flexShrink: 0,
            }}
          />
          <MonoChip style={{ color: kubectlOk ? "var(--fg-tertiary)" : "var(--status-failed)" }} title={error ?? undefined}>
            {statusLabel}
          </MonoChip>
        </div>

        <Sep />

        {/* claude: idle */}
        <MonoChip>claude: idle</MonoChip>

        <Sep />

        {/* Hint chips */}
        <HintChip kbd="⌘K">Commands</HintChip>
        <HintChip kbd="/">Search</HintChip>
        <HintChip kbd="⌘L">Chat</HintChip>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Sep() {
  return (
    <span style={{ color: "var(--border-strong)", fontSize: 10, userSelect: "none" }}>·</span>
  );
}

interface MonoChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode;
}

function MonoChip({ children, style, ...rest }: MonoChipProps) {
  return (
    <span
      style={{
        fontFamily: "'Geist Variable', ui-monospace, monospace",
        fontSize: 10,
        color: "var(--fg-tertiary)",
        ...style,
      }}
      {...rest}
    >
      {children}
    </span>
  );
}

interface HintChipProps {
  kbd: string;
  children: string;
}

function HintChip({ kbd, children }: HintChipProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
      <span
        style={{
          fontFamily: "'Geist Variable', ui-monospace, monospace",
          fontSize: 9,
          color: "#4B4B55",
          background: "var(--surface-elevated)",
          padding: "1px 4px",
          borderRadius: 3,
          border: "1px solid #26272B",
          lineHeight: 1.4,
        }}
      >
        {kbd}
      </span>
      <span
        style={{
          fontFamily: "'Geist Variable', ui-monospace, monospace",
          fontSize: 10,
          color: "#4B4B55",
        }}
      >
        {children}
      </span>
    </div>
  );
}
