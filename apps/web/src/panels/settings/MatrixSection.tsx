// Matrix channel — the settings "Channels" Matrix card, a faithful build of the
// Pencil frame wDsq8 (three resting states: NOT CONNECTED / CONNECTED / ERROR).
// State machine mirrors the derived matrixStatus; the connect wizard lives in
// MatrixConnectModal.
import { useState } from "react";
import { AlertTriangle, MessageSquare, Plus, RefreshCw, Unplug } from "lucide-react";
import { matrixStatusColor, parseAllowedSenders, type MatrixStatus } from "@rigel/k8s";
import { useAssistantAction } from "@/lib/api";
import type { SettingsDerived } from "./useSettings";
import { MatrixConnectModal } from "./MatrixConnectModal";
import { IconTile, GreenToggle } from "./MatrixWizardParts";

const DOT: Record<string, string> = {
  gray: "var(--fg-tertiary)",
  amber: "var(--status-pending)",
  green: "var(--status-running)",
  red: "var(--status-failed)",
};

const STATUS_TEXT: Record<string, string> = {
  notConnected: "Not connected",
  connecting: "Connecting…",
  connected: "Connected",
  error: "Can't reach homeserver",
};

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex flex-col gap-3.5 rounded-[14px] border bg-card border-[var(--border-subtle)]"
      style={{ padding: 18 }}
    >
      {children}
    </div>
  );
}

/** Tile + "Matrix" + status dot/label — the head shared by error and notConnected states. */
function Head({ tone, status }: { tone: "neutral" | "accent" | "red"; status: MatrixStatus }) {
  const dot = DOT[matrixStatusColor(status)] ?? "var(--fg-tertiary)";
  const statusClass = status === "error" ? "text-destructive" : "text-muted-foreground";
  return (
    <div className="flex items-center gap-3">
      <IconTile tone={tone} size={38} radius={10}>
        <MessageSquare className={tone === "neutral" ? "size-[18px] text-muted-foreground" : "size-[18px]"} />
      </IconTile>
      <div className="flex flex-col gap-[3px]">
        <span className="text-foreground" style={{ fontSize: 15, fontWeight: 600 }}>Matrix</span>
        <div className="flex items-center gap-[7px]">
          <span className="inline-block size-[7px] rounded-full" style={{ background: dot }} />
          <span className={statusClass} style={{ fontSize: 12 }}>{STATUS_TEXT[status] ?? status}</span>
        </div>
      </div>
    </div>
  );
}

export function MatrixSection({ derived }: { derived: SettingsDerived }) {
  const {
    namespace,
    matrixStatus,
    matrixHomeserverUrl,
    matrixUserId,
    matrixAllowedSenders,
    matrixInbound,
  } = derived;
  const setMatrix = useAssistantAction();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const senders = parseAllowedSenders(matrixAllowedSenders);

  async function toggleInbound() {
    setError(null);
    try {
      await setMatrix.mutateAsync({ action: "setMatrix", namespace, matrixInbound: !matrixInbound });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function disconnect() {
    setError(null);
    try {
      await setMatrix.mutateAsync({
        action: "setMatrix",
        namespace,
        matrixHomeserverUrl: "",
        matrixUserId: "",
        matrixRoomId: "",
        matrixAllowedSenders: "",
        matrixInbound: false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const modal = (
    <MatrixConnectModal
      key="matrix-wizard"
      open={wizardOpen}
      onClose={() => setWizardOpen(false)}
      namespace={namespace}
      defaultAllowed={matrixAllowedSenders}
    />
  );

  const errorBanner = error && (
    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span className="select-text" style={{ fontSize: 12 }}>
        {error}
      </span>
    </div>
  );

  // ── CONNECTED ────────────────────────────────────────────────────────────
  if (matrixStatus === "connected") {
    const rows: { k: string; v: string }[] = [
      { k: "HOMESERVER", v: matrixHomeserverUrl.replace(/^https?:\/\//, "") || "—" },
      { k: "BOT", v: matrixUserId || "—" },
      { k: "ALLOWED SENDERS", v: senders.join(", ") || "(bot only)" },
    ];
    return (
      <div className="flex flex-col gap-4 rounded-[14px] border border-[var(--border-subtle)] bg-card p-[18px]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-[var(--accent-dim)]">
              <MessageSquare className="size-4 text-primary" />
            </div>
            <div className="flex flex-col gap-[3px]">
              <span className="text-sm font-semibold text-foreground">Matrix</span>
              <div className="flex items-center gap-[7px]">
                <span className="inline-block size-1.5 rounded-full bg-[var(--status-running)]" />
                <span className="text-xs text-muted-foreground">Connected</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-foreground">Enabled</span>
              <GreenToggle
                on={matrixInbound}
                onClick={toggleInbound}
                disabled={setMatrix.isPending}
                label="Two-way replies"
              />
            </div>
            <button
              type="button"
              onClick={disconnect}
              disabled={setMatrix.isPending}
              className="flex items-center gap-[7px] transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              <Unplug className="size-[14px] text-destructive" />
              <span className="text-xs font-medium text-destructive">Disconnect</span>
            </button>
          </div>
        </div>
        {errorBanner}
        <div className="h-px w-full bg-[var(--border-subtle)]" />
        <div className="grid grid-cols-3 gap-8">
          {rows.map((r) => (
            <div key={r.k} className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--fg-tertiary)]">
                {r.k}
              </span>
              <span className="select-text font-mono text-xs text-foreground break-all">
                {r.v}
              </span>
            </div>
          ))}
        </div>
        {modal}
      </div>
    );
  }

  // ── ERROR ──────────────────────────────────────────────────────────────
  if (matrixStatus === "error") {
    return (
      <Card>
        <Head tone="red" status="error" />
        {errorBanner}
        <span className="text-destructive" style={{ fontSize: 12.5, lineHeight: 1.45 }}>
          {matrixHomeserverUrl
            ? `${matrixHomeserverUrl.replace(/^https?:\/\//, "")} didn't respond to Rigel.`
            : "The homeserver didn't respond to Rigel."}
        </span>
        <button
          type="button"
          onClick={() => setWizardOpen(true)}
          className="flex w-full items-center justify-center gap-[7px] rounded-[9px] transition-colors hover:bg-[var(--accent-dim)]"
          style={{ background: "var(--accent-dim)", border: "1px solid var(--accent-primary)", padding: "10px 0" }}
        >
          <RefreshCw className="size-[14px] text-primary" />
          <span className="text-sm font-semibold text-primary">Reconnect</span>
        </button>
        {modal}
      </Card>
    );
  }

  // ── NOT CONNECTED ──────────────────────────────────────────────────────
  return (
    <Card>
      <Head tone="neutral" status="notConnected" />
      {errorBanner}
      <span className="text-muted-foreground" style={{ fontSize: 12.5, lineHeight: 1.45 }}>
        Message Rigel from Element. Runs alongside Signal.
      </span>
      <button
        type="button"
        onClick={() => setWizardOpen(true)}
        className="flex w-full items-center justify-center gap-[7px] rounded-[9px] transition-opacity hover:opacity-90"
        style={{ background: "var(--accent-primary)", padding: "10px 0" }}
      >
        <Plus className="size-[15px]" style={{ color: "var(--fg-inverse)" }} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--fg-inverse)" }}>Connect Matrix</span>
      </button>
      {modal}
    </Card>
  );
}
