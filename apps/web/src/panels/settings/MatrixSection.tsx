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
import { IconTile, GreenToggle, SUB, CAPTION } from "./MatrixWizardParts";

const DOT: Record<string, string> = {
  gray: CAPTION,
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

/** Section card shell — the design's elevated #1B1C1F card. */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex flex-col gap-3.5 rounded-[14px]"
      style={{ background: "var(--surface-elevated)", border: "1px solid rgba(255,255,255,0.07)", padding: 18 }}
    >
      {children}
    </div>
  );
}

/** Tile + "Matrix" + status dot/label — the head shared by all three states. */
function Head({ tone, status }: { tone: "neutral" | "accent" | "red"; status: MatrixStatus }) {
  const dot = DOT[matrixStatusColor(status)] ?? CAPTION;
  const statusColor = status === "error" ? "#E08A82" : SUB;
  return (
    <div className="flex items-center gap-3">
      <IconTile tone={tone} size={38} radius={10}>
        <MessageSquare className="size-[18px]" style={tone === "neutral" ? { color: SUB } : undefined} />
      </IconTile>
      <div className="flex flex-col gap-[3px]">
        <span style={{ fontSize: 15, fontWeight: 600, color: "#FFFFFF" }}>Matrix</span>
        <div className="flex items-center gap-[7px]">
          <span className="inline-block size-[7px] rounded-full" style={{ background: dot }} />
          <span style={{ fontSize: 12, color: statusColor }}>{STATUS_TEXT[status] ?? status}</span>
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
      open={wizardOpen}
      onClose={() => setWizardOpen(false)}
      namespace={namespace}
      defaultAllowed={matrixAllowedSenders}
    />
  );

  const errorBanner = error && (
    <div
      className="flex items-start gap-2 rounded-md p-2"
      style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.4)" }}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" style={{ color: "var(--status-failed)" }} />
      <span className="select-text" style={{ fontSize: 12, color: "var(--status-failed)" }}>
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
      <Card>
        <Head tone="accent" status="connected" />
        {errorBanner}
        <div className="flex flex-col gap-2.5">
          {rows.map((r) => (
            <div key={r.k} className="flex flex-col gap-[3px]">
              <span className="font-mono" style={{ fontSize: 10, letterSpacing: 0.6, color: CAPTION }}>
                {r.k}
              </span>
              <span className="select-text font-mono" style={{ fontSize: 12, color: "#E6E6EA" }}>
                {r.v}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between" style={{ paddingTop: 2 }}>
          <span style={{ fontSize: 12.5, fontWeight: 500, color: "#E6E6EA" }}>Enabled</span>
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
          className="flex items-center gap-[7px] self-start transition-opacity hover:opacity-80 disabled:opacity-50"
        >
          <Unplug className="size-[14px]" style={{ color: "#E07A6A" }} />
          <span style={{ fontSize: 12.5, fontWeight: 500, color: "#E07A6A" }}>Disconnect</span>
        </button>
        {modal}
      </Card>
    );
  }

  // ── ERROR ──────────────────────────────────────────────────────────────
  if (matrixStatus === "error") {
    return (
      <Card>
        <Head tone="red" status="error" />
        {errorBanner}
        <span style={{ fontSize: 12.5, color: "#B98A86", lineHeight: 1.45 }}>
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
          <RefreshCw className="size-[14px]" style={{ color: "var(--accent-primary)" }} />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--accent-primary)" }}>Reconnect</span>
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
      <span style={{ fontSize: 12.5, color: SUB, lineHeight: 1.45 }}>
        Message Rigel from Element. Runs alongside Signal.
      </span>
      <button
        type="button"
        onClick={() => setWizardOpen(true)}
        className="flex w-full items-center justify-center gap-[7px] rounded-[9px] transition-opacity hover:opacity-90"
        style={{ background: "var(--accent-primary)", padding: "10px 0" }}
      >
        <Plus className="size-[15px]" style={{ color: "#0A0A0A" }} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "#0A0A0A" }}>Connect Matrix</span>
      </button>
      {modal}
    </Card>
  );
}
