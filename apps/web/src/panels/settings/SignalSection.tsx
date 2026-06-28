// Signal bridge section for the Settings page.
//
// Manages the 5-state status machine (notDeployed → deploying → starting →
// ready → linked) derived from the live deployments watch + the
// assistant-config ConfigMap. Styled to match the Matrix channel card.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, AlertTriangle, MessageCircle } from "lucide-react";
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
import { fetchSignalQR, fetchSignalAccounts, sendSignalTest } from "@/lib/api";
import { useSettings } from "./useSettings";
import { GreenToggle } from "./MatrixWizardParts";

const DOT_CLASS: Record<string, string> = {
  gray: "bg-muted-foreground/50",
  amber: "bg-[var(--status-pending)]",
  blue: "bg-primary",
  green: "bg-[var(--status-running)]",
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
  const { status, namespace, signalNumber, recipients, inbound } = derived;
  const setSignal = useAssistantAction();

  const [error, setError] = useState<string | null>(null);
  const [showManifest, setShowManifest] = useState(false);

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

  const dot = DOT_CLASS[signalStatusColor(status)];
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
      const res = await fetch("/api/apply", {
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
      inbound,
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
        inbound,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleInbound() {
    setError(null);
    try {
      await setSignal.mutateAsync({
        action: "setSignal",
        namespace,
        apiUrl: signalApiUrl(namespace),
        number: signalNumber,
        recipients,
        inbound: !inbound,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    <div className="flex flex-col gap-4 rounded-[14px] border border-[var(--border-subtle)] bg-card p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-[var(--accent-dim)]">
            <MessageCircle className="size-4 text-primary" />
          </div>
          <div className="flex flex-col gap-[3px]">
            <span className="text-sm font-semibold text-foreground">Signal</span>
            <div className="flex items-center gap-[7px]">
              <span className={`inline-block size-1.5 rounded-full ${dot}`} />
              <span className="text-xs text-muted-foreground">{label}</span>
              {busy && <Loader size={12} className="text-muted-foreground" />}
            </div>
          </div>
        </div>

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
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-foreground">Two-way</span>
              <GreenToggle
                on={inbound}
                onClick={toggleInbound}
                disabled={setSignal.isPending}
                label="Let me text the assistant back"
              />
            </div>
            <Button
              size="sm"
              variant="muted"
              onClick={startLinking}
              disabled={linking}
            >
              Re-link
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
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
            {showManifest ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Show manifest
          </button>
          {showManifest && (
            <pre className="max-h-72 select-text overflow-auto rounded-md bg-[var(--surface-sunken)] p-2 font-mono text-[11px] whitespace-pre">
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
              <span className="text-[10px] uppercase tracking-wide text-[var(--fg-tertiary)]">Sender</span>
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
                  <Check className="h-3.5 w-3.5" /> {testResult}
                </span>
              )}
            </div>

            <p className="text-[11px] text-[var(--fg-tertiary)]">
              With two-way on, the assistant polls the bridge for replies from your recipients and acts
              on them.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
