// Matrix channel — the Settings "Channels" Matrix card. Shares the common card
// chrome (ChannelCard + ChannelCardHeader) with Signal/Discord/Slack; the connect
// wizard lives in MatrixConnectModal. Three resting states: NOT CONNECTED /
// CONNECTED / ERROR, driven by the derived matrixStatus.
import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMessage, faPlugCircleXmark } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { parseAllowedSenders } from "@rigel/k8s";
import { Button } from "@/components/ui/button";
import { useAssistantAction } from "@/lib/api";
import type { SettingsDerived } from "./useSettings";
import { MatrixConnectModal } from "./MatrixConnectModal";
import { ChannelDisconnectDialog } from "./ChannelDisconnectDialog";
import { ChannelCard, ChannelCardHeader } from "./ChannelCard";
import { NotifyToggle } from "./NotifyToggle";

const MATRIX_ICON = <FontAwesomeIcon icon={faMessage} className="size-4 text-primary" />;

export function MatrixSection({ derived }: { derived: SettingsDerived }) {
  const {
    namespace,
    matrixStatus,
    matrixHomeserverUrl,
    matrixUserId,
    matrixAllowedSenders,
    notifyChannels,
  } = derived;
  const setMatrix = useAssistantAction();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const senders = parseAllowedSenders(matrixAllowedSenders);

  async function disconnect() {
    setDisconnectError(null);
    try {
      await setMatrix.mutateAsync({
        action: "setMatrix",
        namespace,
        matrixHomeserverUrl: "",
        matrixUserId: "",
        matrixRoomId: "",
        matrixAllowedSenders: "",
      });
      setDisconnectOpen(false);
    } catch (err) {
      setDisconnectError(err instanceof Error ? err.message : String(err));
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

  // ── CONNECTED ────────────────────────────────────────────────────────────
  if (matrixStatus === "connected") {
    const rows: { k: string; v: string }[] = [
      { k: "HOMESERVER", v: matrixHomeserverUrl.replace(/^https?:\/\//, "") || "—" },
      { k: "BOT", v: matrixUserId || "—" },
      { k: "ALLOWED SENDERS", v: senders.join(", ") || "(bot only)" },
    ];
    return (
      <ChannelCard>
        <ChannelCardHeader
          icon={MATRIX_ICON}
          title="Matrix"
          dotColor="var(--status-running)"
          statusLabel="Connected"
          action={
            <div className="flex items-center gap-4">
              <NotifyToggle channelId="matrix" namespace={namespace} enabled={notifyChannels.includes("matrix")} />
              <button
                type="button"
                onClick={() => {
                  setDisconnectError(null);
                  setDisconnectOpen(true);
                }}
                disabled={setMatrix.isPending}
                className="flex items-center gap-[7px] transition-opacity hover:opacity-80 disabled:opacity-50"
              >
                <FontAwesomeIcon icon={faPlugCircleXmark} className="size-[14px] text-destructive" />
                <span className="text-xs font-medium text-destructive">Disconnect</span>
              </button>
            </div>
          }
        />
        <div className="h-px w-full bg-[var(--border-subtle)]" />
        <div className="grid grid-cols-3 gap-8">
          {rows.map((r) => (
            <div key={r.k} className="flex flex-col gap-1">
              <span className="font-mono text-3xs uppercase tracking-wide text-[var(--fg-tertiary)]">{r.k}</span>
              <span className="select-text font-mono text-xs text-foreground break-all">{r.v}</span>
            </div>
          ))}
        </div>
        {modal}
        <ChannelDisconnectDialog
          open={disconnectOpen}
          onOpenChange={setDisconnectOpen}
          onConfirm={disconnect}
          pending={setMatrix.isPending}
          error={disconnectError}
          channel="Matrix"
          description="This clears the homeserver, bot user, and allowed senders from Rigel's config. Notifications stop immediately. You can reconnect anytime."
        />
      </ChannelCard>
    );
  }

  // ── ERROR ──────────────────────────────────────────────────────────────
  if (matrixStatus === "error") {
    return (
      <ChannelCard>
        <ChannelCardHeader
          icon={MATRIX_ICON}
          title="Matrix"
          dotColor="var(--status-failed)"
          statusLabel="Can't reach homeserver"
          statusDestructive
          action={
            <Button size="sm" onClick={() => setWizardOpen(true)}>
              Reconnect
            </Button>
          }
        />
        <span className="text-destructive text-xs" style={{ lineHeight: 1.45 }}>
          {matrixHomeserverUrl
            ? `${matrixHomeserverUrl.replace(/^https?:\/\//, "")} didn't respond to Rigel.`
            : "The homeserver didn't respond to Rigel."}
        </span>
        {modal}
      </ChannelCard>
    );
  }

  // ── NOT CONNECTED ──────────────────────────────────────────────────────
  return (
    <ChannelCard>
      <ChannelCardHeader
        icon={MATRIX_ICON}
        title="Matrix"
        dotColor="var(--fg-tertiary)"
        statusLabel="Not connected"
        action={
          <Button size="sm" onClick={() => setWizardOpen(true)}>
            Connect
          </Button>
        }
      />
      <span className="text-muted-foreground text-xs" style={{ lineHeight: 1.45 }}>
        Message Rigel from Element. Runs alongside Signal.
      </span>
      {modal}
    </ChannelCard>
  );
}
