/**
 * StatusBar — thin bottom chrome bar (full width, below the main row).
 * Mirrors StatusBar.swift:
 *   LEFT  : "{namespace} · pods N · nodes N"  (counts from store)
 *   RIGHT : "kubectl: ok/error" dot · "claude: idle" · hint chips
 *             ⌘K Commands · / Search · ⌘L Chat
 */
import { useEffect, useState } from "react";
import { useCluster, filterByNamespace } from "@/store/cluster";
import { TOGGLE_TERMINAL_EVENT } from "@/shell/TerminalDrawer";
import { connectionStatus, type ConnectionTone } from "@/shell/connectionStatus";
import { apiFetch } from "@/lib/api";
import { formatShortcut } from "@/lib/platform";

const TONE_COLOR: Record<ConnectionTone, string> = {
  ok: "var(--status-running)",
  warn: "var(--status-pending)",
  error: "var(--status-failed)",
};

interface HealthData {
  context?: string;
  ok?: boolean;
}

interface StatusBarProps {
  chatHidden?: boolean;
  onToggleChat?: () => void;
}

export default function StatusBar({ chatHidden, onToggleChat }: StatusBarProps = {}) {
  const connected = useCluster((s) => s.connected);
  const resources = useCluster((s) => s.resources);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const activeContext = useCluster((s) => s.activeContext);

  const [health, setHealth] = useState<HealthData>({});

  useEffect(() => {
    apiFetch("/api/health")
      .then((r) => r.json())
      .then((d) => setHealth(d as HealthData))
      .catch(() => {/* ignore — optional */});
  }, []);

  const podCount = filterByNamespace(resources["pods"], namespaceFilter).length;
  const nodeCount = Object.keys(resources["nodes"] ?? {}).length;

  const { label: statusLabel, tone: statusTone } = connectionStatus(connected, error);
  const statusColor = TONE_COLOR[statusTone];

  // Namespace label for left side — use context name or namespace filter
  const namespaceLabel = namespaceFilter ?? activeContext ?? health.context ?? null;

  return (
    <div
      style={{
        height: 24,
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
          <MonoChip style={{ color: statusTone === "ok" ? "var(--fg-secondary)" : statusColor }} title={error ?? undefined}>
            {statusLabel}
          </MonoChip>
        </div>

        <Sep />

        {/* claude: idle */}
        <MonoChip>claude: idle</MonoChip>

        <Sep />

        {/* Hint chips */}
        <HintChip kbd={formatShortcut({ mod: true, key: "K" })}>Commands</HintChip>
        <HintChip kbd="/">Search</HintChip>
        <HintChip kbd={formatShortcut({ mod: true, key: "L" })}>Chat</HintChip>
        <HintChip kbd={formatShortcut({ ctrl: true, key: "`" })} onClick={() => window.dispatchEvent(new Event(TOGGLE_TERMINAL_EVENT))}>
          Terminal
        </HintChip>
        {onToggleChat && (
          <HintChip kbd={formatShortcut({ mod: true, key: "J" })} onClick={onToggleChat}>
            {chatHidden ? "Show chat" : "Hide chat"}
          </HintChip>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Sep() {
  return (
    <span className="text-3xs" style={{ color: "var(--border-strong)", userSelect: "none" }}>·</span>
  );
}

interface MonoChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode;
}

function MonoChip({ children, style, ...rest }: MonoChipProps) {
  return (
    <span
      className="text-2xs"
      style={{
        fontFamily: "'Geist Variable', ui-monospace, monospace",
        color: "var(--fg-secondary)",
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
  onClick?: () => void;
}

function HintChip({ kbd, children, onClick }: HintChipProps) {
  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      title={onClick ? `${children} (${kbd})` : undefined}
      style={{ display: "flex", alignItems: "center", gap: 3, cursor: onClick ? "pointer" : undefined }}
    >
      <span
        className="text-3xs"
        style={{
          fontFamily: "'Geist Variable', ui-monospace, monospace",
          color: "var(--fg-tertiary)",
          background: "var(--surface-elevated)",
          padding: "1px 4px",
          borderRadius: 3,
          border: "1px solid var(--border-strong)",
          lineHeight: 1.4,
        }}
      >
        {kbd}
      </span>
      <span
        className="text-2xs"
        style={{
          fontFamily: "'Geist Variable', ui-monospace, monospace",
          color: "var(--fg-secondary)",
        }}
      >
        {children}
      </span>
    </div>
  );
}
