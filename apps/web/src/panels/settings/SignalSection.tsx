// Signal bridge section for the Settings page.
//
// Manages the 5-state status machine (notDeployed → deploying → starting →
// ready → linked) derived from the live deployments watch + the
// assistant-config ConfigMap. Styled to match the Matrix channel card.

import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCheck,
  faChevronDown,
  faChevronRight,
  faTriangleExclamation,
  faComment,
  faPlugCircleXmark,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/Loader";
import {
  signalBridgeManifest,
  signalStatusColor,
  signalStatusLabel,
  signalApiUrl,
  parseRecipients,
} from "@rigel/k8s";
import { useAssistantAction } from "@/lib/api";
import { apiFetch, fetchSignalQR, fetchSignalAccounts, sendSignalTest } from "@/lib/api";
import { useSettings } from "./useSettings";
import { ChannelDisconnectDialog } from "./ChannelDisconnectDialog";
import { ChannelCard, ChannelCardHeader } from "./ChannelCard";
import { NotifyToggle } from "./NotifyToggle";

const DOT_COLOR: Record<string, string> = {
  gray: "var(--fg-tertiary)",
  amber: "var(--status-pending)",
  blue: "var(--primary)",
  green: "var(--status-running)",
};


export function SignalSection({
  derived,
  applying,
  setApplying,
}: {
  derived: ReturnType<typeof useSettings>;
  applying: boolean;
  setApplying: (v: boolean) => void;
}) {
  const { status, namespace, signalNumber, recipients, notifyChannels } = derived;
  const setSignal = useAssistantAction();

  const [error, setError] = useState<string | null>(null);
  const [showManifest, setShowManifest] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  // Linking flow state.
  const [linking, setLinking] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrUrlRef = useRef<string | null>(null);

  // Recipients edit buffer (seeded from config, re-seeded on remote changes).
  const [recipientText, setRecipientText] = useState(recipients);
  useEffect(() => setRecipientText(recipients), [recipients]);

  const [testResult, setTestResult] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const dotColor = DOT_COLOR[signalStatusColor(status)];
  const label = signalStatusLabel(status);
  const busy = status === "deploying" || status === "starting";

  // Tear down the QR object URL + poller on unmount or cancel.
  function stopLinking() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (qrUrlRef.current) {
      URL.revokeObjectURL(qrUrlRef.current);
      qrUrlRef.current = null;
    }
    setQrUrl(null);
    setLinking(false);
  }
  useEffect(() => () => stopLinking(), []);

  async function deploy() {
    setError(null);
    setApplying(true);
    try {
      const res = await apiFetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: signalBridgeManifest(namespace) }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: number;
        stderr?: string;
      };
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      if (typeof data.code === "number" && data.code !== 0)
        throw new Error(`Deploy failed: ${data.stderr || `exit ${data.code}`}`);
      // The deployments watch advances the status to starting/ready.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  // Persist the just-linked number into assistant-config, then stop polling.
  async function saveLinkedNumber(number: string) {
    await setSignal.mutateAsync({
      action: "setSignal",
      namespace,
      apiUrl: signalApiUrl(namespace),
      number,
      recipients,
    });
    stopLinking();
  }

  async function startLinking() {
    setError(null);
    setLinking(true);
    try {
      const url = await fetchSignalQR(namespace);
      qrUrlRef.current = url;
      setQrUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      stopLinking();
      return;
    }
    // Poll accounts() every 2s; first non-empty number is the link.
    pollRef.current = setInterval(async () => {
      try {
        const accounts = await fetchSignalAccounts(namespace);
        const number = accounts.find((a) => a.trim() !== "");
        if (number) await saveLinkedNumber(number);
      } catch {
        // Transient — the bridge may still be registering; keep polling.
      }
    }, 2000);
  }

  async function saveRecipients() {
    setError(null);
    try {
      await setSignal.mutateAsync({
        action: "setSignal",
        namespace,
        apiUrl: signalApiUrl(namespace),
        number: signalNumber,
        recipients: recipientText,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function disconnect() {
    setDisconnectError(null);
    try {
      await setSignal.mutateAsync({
        action: "setSignal",
        namespace,
        apiUrl: "",
        number: "",
        recipients: "",
      });
      setDisconnectOpen(false);
    } catch (err) {
      setDisconnectError(err instanceof Error ? err.message : String(err));
    }
  }

  async function sendTest() {
    setError(null);
    setTestResult(null);
    if (linking) {
      setError("Finish linking before sending a test.");
      return;
    }
    if (signalNumber.trim() === "") {
      setError("No linked sender number — link your phone first.");
      return;
    }
    const list = parseRecipients(recipients);
    if (list.length === 0) {
      setError("Add at least one recipient (then Save) before sending a test.");
      return;
    }
    setSending(true);
    try {
      await sendSignalTest({ namespace, number: signalNumber, recipients: list });
      setTestResult("Sent.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  const linkingPanel = linking && (
    <div className="flex flex-col gap-2">
      {qrUrl ? (
        <>
          <img src={qrUrl} alt="Signal link QR code" className="h-48 w-48 rounded-md border bg-white p-1" />
          <p className="text-xs text-muted-foreground">
            Scan in Signal → Settings → Linked devices → Link new device. Waiting for the link…
          </p>
        </>
      ) : (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader size={14} /> Opening link channel…
        </p>
      )}
      <Button size="sm" variant="muted" className="w-fit" onClick={stopLinking}>
        Cancel
      </Button>
    </div>
  );

  return (
    <ChannelCard>
      <ChannelCardHeader
        icon={<FontAwesomeIcon icon={faComment} className="size-4 text-primary" />}
        title="Signal"
        dotColor={dotColor}
        statusLabel={label}
        busy={busy}
        action={
          <>
            {status === "notDeployed" && (
              <Button size="sm" disabled={applying} onClick={deploy}>
                {applying ? "Deploying…" : "Deploy bridge"}
              </Button>
            )}
            {status === "ready" && !linking && (
              <Button size="sm" onClick={startLinking}>
                Link phone
              </Button>
            )}
            {status === "linked" && (
              <div className="flex items-center gap-4">
                <NotifyToggle channelId="signal" namespace={namespace} enabled={notifyChannels.includes("signal")} />
                <Button size="sm" variant="muted" onClick={startLinking} disabled={linking}>
                  Re-link
                </Button>
                <button
                  type="button"
                  onClick={() => { setDisconnectError(null); setDisconnectOpen(true); }}
                  disabled={setSignal.isPending}
                  className="flex items-center gap-[7px] transition-opacity hover:opacity-80 disabled:opacity-50"
                >
                  <FontAwesomeIcon icon={faPlugCircleXmark} className="size-[14px] text-destructive" />
                  <span className="text-xs font-medium text-destructive">Disconnect</span>
                </button>
              </div>
            )}
          </>
        }
      />

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="select-text">{error}</span>
        </div>
      )}

      {/* notDeployed → manifest disclosure */}
      {status === "notDeployed" && (
        <div className="flex flex-col gap-2">
          <button
            className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowManifest((s) => !s)}
          >
            {showManifest ? <FontAwesomeIcon icon={faChevronDown} className="h-3 w-3" /> : <FontAwesomeIcon icon={faChevronRight} className="h-3 w-3" />}
            Show manifest
          </button>
          {showManifest && (
            <pre className="max-h-72 select-text overflow-auto rounded-md bg-[var(--surface-sunken)] p-2 font-mono text-2xs whitespace-pre">
              {signalBridgeManifest(namespace)}
            </pre>
          )}
        </div>
      )}

      {/* deploying/starting → progress */}
      {busy && (
        <p className="text-xs text-muted-foreground">
          {status === "deploying" ? "Applying manifest…" : "Waiting for the bridge pod to start…"}
        </p>
      )}

      {/* QR linking panel (first link or re-link) */}
      {linkingPanel}

      {/* linked → sender, recipients, send test */}
      {status === "linked" && !linking && (
        <>
          <div className="h-px w-full bg-[var(--border-subtle)]" />
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-3xs uppercase tracking-wide text-[var(--fg-tertiary)]">Sender</span>
              <span className="font-mono text-xs text-foreground">{signalNumber}</span>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">
                Recipients (comma-separated). Empty sends to yourself.
              </span>
              <div className="flex gap-2">
                <input
                  className="flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2 text-sm text-foreground outline-none placeholder:text-[var(--fg-tertiary)] focus:border-primary"
                  placeholder="+15551234567, +15559876543"
                  value={recipientText}
                  onChange={(e) => setRecipientText(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRecipientText(recipients)}
                  disabled={setSignal.isPending || recipientText === recipients}
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={saveRecipients} disabled={setSignal.isPending}>
                  Save
                </Button>
              </div>
            </label>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="muted"
                onClick={sendTest}
                disabled={sending}
              >
                {sending ? "Sending…" : "Send test notification"}
              </Button>
              {testResult && (
                <span className="flex items-center gap-1 text-xs text-[var(--status-running)]">
                  <FontAwesomeIcon icon={faCheck} className="h-3.5 w-3.5" /> {testResult}
                </span>
              )}
            </div>
          </div>
        </>
      )}

      <ChannelDisconnectDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        onConfirm={disconnect}
        pending={setSignal.isPending}
        error={disconnectError}
        channel="Signal"
        description="This removes the linked phone number and recipients from Rigel's config. Notifications stop immediately. The signal-cli-rest bridge stays deployed, so you can re-link anytime."
      />
    </ChannelCard>
  );
}
