// Matrix channel — a second chat channel alongside Signal. Resting states mirror
// SignalSection's state machine (not connected / connected / error). The connect
// wizard lives in MatrixConnectModal (paths A and B).
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { matrixStatusColor, matrixStatusLabel, parseAllowedSenders } from "@rigel/k8s";
import { useAssistantAction } from "@/lib/api";
import type { SettingsDerived } from "./useSettings";
import { MatrixConnectModal } from "./MatrixConnectModal";

const DOT_CLASS: Record<string, string> = {
  gray: "bg-muted-foreground/50",
  amber: "bg-amber-500",
  green: "bg-green-500",
  red: "bg-destructive",
};

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border bg-card p-3">{children}</div>;
}

export function MatrixSection({ derived }: { derived: SettingsDerived }) {
  const {
    namespace,
    matrixStatus,
    matrixHomeserverUrl,
    matrixUserId,
    matrixRoomId,
    matrixAllowedSenders,
    matrixInbound,
  } = derived;
  const setMatrix = useAssistantAction();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dot = DOT_CLASS[matrixStatusColor(matrixStatus)];
  const label = matrixStatusLabel(matrixStatus);
  const senders = parseAllowedSenders(matrixAllowedSenders);

  async function toggleInbound() {
    setError(null);
    try {
      await setMatrix.mutateAsync({ action: "setMatrix", namespace, matrixInbound: !matrixInbound });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Matrix</h2>
        <span className="font-mono text-[10px] text-muted-foreground">ns: {namespace}</span>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} />
        <span className="font-mono text-xs">{label}</span>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="select-text">{error}</span>
        </div>
      )}

      {matrixStatus !== "connected" ? (
        <Button size="sm" onClick={() => setWizardOpen(true)}>
          Connect Matrix
        </Button>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1 text-xs">
            <div className="font-mono">Connected as {matrixUserId}</div>
            <div className="text-muted-foreground">Homeserver: {matrixHomeserverUrl}</div>
            <div className="text-muted-foreground">Room: {matrixRoomId}</div>
            <div className="text-muted-foreground">
              Allowed senders: {senders.length > 0 ? senders.join(", ") : "(bot only)"}
            </div>
          </div>

          <button
            className="flex items-center gap-2 text-left"
            onClick={toggleInbound}
            disabled={setMatrix.isPending}
          >
            <span
              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                matrixInbound ? "bg-green-500" : "bg-muted-foreground/40"
              }`}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                  matrixInbound ? "translate-x-3.5" : "translate-x-0.5"
                }`}
              />
            </span>
            <span className="text-xs">Let me text the assistant back (two-way)</span>
          </button>

          <Button size="sm" variant="outline" onClick={() => setWizardOpen(true)}>
            Reconnect
          </Button>
        </div>
      )}

      <MatrixConnectModal
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        namespace={namespace}
        defaultAllowed={matrixAllowedSenders}
      />
    </Card>
  );
}
