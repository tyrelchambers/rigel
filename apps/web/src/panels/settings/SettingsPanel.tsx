// Settings panel — Signal notifications bridge + self-host install defaults.
// Web port of the Swift Settings panel (docs/parity/settings.md).
//
// Two cards:
//   1. Signal bridge — deploy signal-cli-rest, link a phone (QR via a brief
//      server-side port-forward), configure recipients, send a test, and toggle
//      two-way replies. The 5-state status machine (notDeployed → deploying →
//      starting → ready → linked) is derived from the live deployments watch +
//      the assistant-config ConfigMap.
//   2. Self-host defaults — per-kubectl-context localStorage values fed into the
//      catalog install wizard. No kubectl runs here.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { LoaderCircle, Check, ChevronDown, ChevronRight, AlertTriangle, Key, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  signalBridgeManifest,
  signalStatusColor,
  signalStatusLabel,
  signalApiUrl,
  parseRecipients,
} from "@helmsman/k8s";
import { useAssistantAction, useChatConfig, useSetChatToken, useAuthStatus, useLogout } from "@/lib/api";
import { fetchSignalQR, fetchSignalAccounts, sendSignalTest } from "@/lib/api";
import {
  useSettings,
  loadSelfHostDefaults,
  saveSelfHostDefaults,
  EMPTY_SELF_HOST_DEFAULTS,
  type SelfHostDefaults,
} from "./useSettings";

// The kubectl context keys the self-host localStorage. The server resolves the
// active context; the client reads it once from /api/health-adjacent state.
// Until a dedicated endpoint exists, the context name is read from the cluster
// store's connection (falls back to a stable "default" bucket).
function useKubectlContext(): string {
  // Self-host defaults are namespaced per context; absent a context endpoint we
  // bucket under "default" so the round-trip is still isolated and stable.
  return "default";
}

const DOT_CLASS: Record<string, string> = {
  gray: "bg-muted-foreground/50",
  amber: "bg-amber-500",
  blue: "bg-blue-500",
  green: "bg-green-500",
};

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-lg border bg-card p-3 ${className}`}>{children}</div>;
}

export default function SettingsPanel() {
  const [applying, setApplying] = useState(false);
  const derived = useSettings(applying);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      <AccountSection />
      <CopilotSection />
      <SignalSection derived={derived} applying={applying} setApplying={setApplying} />
      <SelfHostSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account / session
// ---------------------------------------------------------------------------

function AccountSection() {
  const { data: auth } = useAuthStatus();
  const logout = useLogout();
  // Only meaningful when the server enforces a password.
  if (!auth?.authRequired) return null;
  return (
    <Card>
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Account</h2>
        <span className="ml-auto text-xs text-muted-foreground">Signed in</span>
        <button
          type="button"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
          className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          {logout.isPending ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// AI copilot (Rigel) — Claude subscription token
// ---------------------------------------------------------------------------

function CopilotSection() {
  const navigate = useNavigate();
  const { data: config } = useChatConfig();
  const setToken = useSetChatToken();
  const [token, setTokenInput] = useState("");

  const configured = config?.configured ?? false;
  const envManaged = config?.source === "env";

  async function save() {
    await setToken.mutateAsync(token.trim());
    setTokenInput("");
  }

  return (
    <Card>
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Rigel (AI copilot)</h2>
        <span
          className={`ml-auto inline-flex items-center gap-1.5 text-xs ${
            configured ? "text-green-500" : "text-muted-foreground"
          }`}
        >
          <span
            className={`inline-block size-2 rounded-full ${configured ? "bg-green-500" : "bg-muted-foreground/50"}`}
          />
          {configured ? (envManaged ? "configured (env)" : "configured") : "not configured"}
        </span>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        Chat needs a Claude subscription token. On a machine with the Claude CLI, run{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">claude setup-token</code> and paste
        the <code className="rounded bg-muted px-1 py-0.5 font-mono">sk-ant-oat-…</code> token below.
        Panels work without it; only chat is affected.
      </p>

      {envManaged ? (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">
            The token is set via the <code className="font-mono">CLAUDE_CODE_OAUTH_TOKEN</code>{" "}
            environment variable, sourced from a Secret in your deployment.
          </p>
          {config?.secret && (
            <button
              type="button"
              onClick={() => navigate(`/secrets?q=${encodeURIComponent(config.secret!.name)}`)}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              <Key className="size-3" />
              Edit Secret {config.secret.name}
              <ArrowRight className="size-3" />
            </button>
          )}
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="sk-ant-oat-…"
            className="flex-1 rounded-md border bg-background px-3 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="button"
            disabled={!token.trim() || setToken.isPending}
            onClick={save}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {setToken.isPending ? "Saving…" : "Save"}
          </button>
          {configured && (
            <button
              type="button"
              disabled={setToken.isPending}
              onClick={() => setToken.mutate("")}
              className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              Clear
            </button>
          )}
        </div>
      )}
      {setToken.isError && (
        <p className="mt-2 text-xs text-destructive">{setToken.error.message}</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Signal bridge
// ---------------------------------------------------------------------------

function SignalSection({
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

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Signal notifications</h2>
        <span className="font-mono text-[10px] text-muted-foreground">ns: {namespace}</span>
      </div>

      {/* Status row */}
      <div className="mb-3 flex items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} />
        <span className="font-mono text-xs">{label}</span>
        {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="select-text">{error}</span>
        </div>
      )}

      {/* notDeployed → deploy + manifest disclosure */}
      {status === "notDeployed" && (
        <div className="space-y-2">
          <Button size="sm" disabled={applying} onClick={deploy}>
            {applying ? "Deploying…" : "Deploy Signal bridge"}
          </Button>
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowManifest((s) => !s)}
          >
            {showManifest ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Show manifest
          </button>
          {showManifest && (
            <pre className="max-h-72 select-text overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre">
              {signalBridgeManifest(namespace)}
            </pre>
          )}
        </div>
      )}

      {/* deploying/starting → progress, controls disabled */}
      {busy && (
        <p className="text-xs text-muted-foreground">
          {status === "deploying" ? "Applying manifest…" : "Waiting for the bridge pod to start…"}
        </p>
      )}

      {/* ready → link a phone (with QR while linking) */}
      {status === "ready" && (
        <div className="space-y-2">
          {!linking && (
            <Button size="sm" onClick={startLinking}>
              Link phone
            </Button>
          )}
          {linking && (
            <div className="space-y-2">
              {qrUrl ? (
                <>
                  <img
                    src={qrUrl}
                    alt="Signal link QR code"
                    className="h-48 w-48 rounded-md border bg-white p-1"
                  />
                  <p className="text-xs text-muted-foreground">
                    Scan in Signal → Settings → Linked devices → Link new device. Waiting for the
                    link…
                  </p>
                </>
              ) : (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  Opening link channel…
                </p>
              )}
              <Button size="sm" variant="outline" onClick={stopLinking}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}

      {/* linked → number, re-link, recipients, test, two-way */}
      {status === "linked" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs">Linked as {signalNumber}</span>
            <Button size="sm" variant="outline" onClick={startLinking} disabled={linking}>
              Re-link
            </Button>
          </div>

          {linking && (
            <div className="space-y-2">
              {qrUrl ? (
                <img
                  src={qrUrl}
                  alt="Signal link QR code"
                  className="h-48 w-48 rounded-md border bg-white p-1"
                />
              ) : (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  Opening link channel…
                </p>
              )}
              <Button size="sm" variant="outline" onClick={stopLinking}>
                Cancel
              </Button>
            </div>
          )}

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">
              Recipients (comma-separated). Empty sends to yourself.
            </span>
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-md border bg-background px-2 py-1 text-sm"
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
            <Button size="sm" variant="outline" onClick={sendTest} disabled={sending}>
              {sending ? "Sending…" : "Send test notification"}
            </Button>
            {testResult && (
              <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                <Check className="h-3.5 w-3.5" /> {testResult}
              </span>
            )}
          </div>

          <button
            className="flex items-center gap-2 text-left"
            onClick={toggleInbound}
            disabled={setSignal.isPending}
          >
            <span
              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                inbound ? "bg-green-500" : "bg-muted-foreground/40"
              }`}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                  inbound ? "translate-x-3.5" : "translate-x-0.5"
                }`}
              />
            </span>
            <span className="text-xs">Let me text the assistant back (two-way)</span>
          </button>
          <p className="text-[11px] text-muted-foreground">
            When on, the assistant polls the bridge for replies from your recipients and acts on
            them.
          </p>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Self-host defaults (localStorage)
// ---------------------------------------------------------------------------

function SelfHostSection() {
  const context = useKubectlContext();
  const [fields, setFields] = useState<SelfHostDefaults>(EMPTY_SELF_HOST_DEFAULTS);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setFields(loadSelfHostDefaults(context));
    setSaved(false);
  }, [context]);

  function update(key: keyof SelfHostDefaults, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
    setSaved(false); // editing resets the saved checkmark
  }

  function save() {
    saveSelfHostDefaults(context, fields);
    setFields(loadSelfHostDefaults(context)); // reflect the trimmed values
    setSaved(true);
  }

  const rows: Array<{ key: keyof SelfHostDefaults; label: string; placeholder: string }> = [
    { key: "ingressDomain", label: "Ingress domain", placeholder: "apps.example.com" },
    { key: "imagePullSecret", label: "Image pull secret", placeholder: "(none)" },
    { key: "redirectMiddleware", label: "Redirect middleware", placeholder: "(none)" },
    { key: "edgeIP", label: "Edge IP", placeholder: "(optional)" },
  ];

  return (
    <Card>
      <h2 className="mb-2 text-sm font-semibold">Self-hosted app defaults</h2>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Defaults fed into the catalog install wizard. Stored locally per cluster context — no
        cluster writes.
      </p>
      <div className="space-y-2">
        {rows.map(({ key, label, placeholder }) => (
          <label key={key} className="grid grid-cols-[10rem_1fr] items-center gap-2">
            <span className="text-xs text-muted-foreground">{label}</span>
            <input
              className="rounded-md border bg-background px-2 py-1 text-sm"
              placeholder={placeholder}
              value={fields[key]}
              onChange={(e) => update(key, e.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" onClick={save}>
          Save defaults
        </Button>
        {saved && (
          <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        )}
      </div>
    </Card>
  );
}
