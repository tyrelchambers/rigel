import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Check, ChevronDown, CloudOff, Copy, ExternalLink, RefreshCw, ShieldAlert, UserRound } from "lucide-react";
import { FaApple, FaLinux, FaWindows } from "react-icons/fa";
import {
  type ProviderDescriptor, type CloudCluster, type CheckResult, type ParamSpec, nextStepFromCheck, diagnoseError,
} from "@rigel/cloud-connect/src/index";
import {
  cloudCheck as defaultCheck, cloudListClusters as defaultList, cloudConnect as defaultConnect,
  cloudParamOptions as defaultParamOptions,
  type CloudProvider,
} from "@/lib/api";

interface Actions {
  check: (provider: CloudProvider) => Promise<CheckResult>;
  list: (provider: CloudProvider, params: Record<string, string>) => Promise<{ clusters?: CloudCluster[]; error?: string; stderr?: string }>;
  connect: (provider: CloudProvider, cluster: CloudCluster, params: Record<string, string>) => Promise<{ context?: string; backupPath?: string | null }>;
  paramOptions: (provider: CloudProvider, key: string) => Promise<{ options: string[]; default?: string }>;
}

const defaultActions: Actions = {
  check: defaultCheck, list: defaultList, connect: defaultConnect, paramOptions: defaultParamOptions,
};

type Phase = "checking" | "needs-cli" | "needs-extra" | "needs-login" | "needs-params" | "listing" | "pick" | "connecting" | "error";

type ParamField = { spec: ParamSpec; options: string[]; value: string; fromDefault: boolean };

/** Detect the current OS from the user agent. */
function detectOS(): "macos" | "linux" | "windows" | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "macos";
  if (/Win/i.test(ua)) return "windows";
  if (/Linux/i.test(ua)) return "linux";
  return null;
}

/** Map a command's first token to a human-readable package manager label. */
function pkgLabel(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const map: Record<string, string> = {
    brew: "Homebrew",
    snap: "Snap",
    scoop: "Scoop",
    apt: "APT",
    choco: "Chocolatey",
    winget: "winget",
  };
  return map[first] ?? first;
}

/** Split a command at a `#` into { primary, alt }. */
function splitCommand(command: string): { primary: string; alt: string | null } {
  const idx = command.indexOf("#");
  if (idx === -1) return { primary: command.trim(), alt: null };
  const primary = command.slice(0, idx).trim();
  let alt = command.slice(idx + 1).trim();
  // Strip leading "or:" or "or " prefix
  alt = alt.replace(/^or:\s*/i, "").replace(/^or\s+/i, "").trim();
  return { primary, alt: alt || null };
}

/** A copyable command row with a divider-separated Copy button. */
function CommandField({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { primary, alt } = splitCommand(command);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  function handleCopy() {
    if (!navigator.clipboard) return;
    if (copyTimer.current) clearTimeout(copyTimer.current);
    navigator.clipboard.writeText(primary).then(() => {
      setCopied(true);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center",
        background: "var(--surface-sunken)", border: "1px solid var(--border-strong)",
        borderRadius: 8, overflow: "hidden",
      }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", minWidth: 0 }}>
          <span style={{ color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)", fontSize: 12, flexShrink: 0 }}>$</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {primary}
          </span>
        </div>
        <div style={{ width: 1, alignSelf: "stretch", background: "var(--border-strong)" }} />
        <button
          type="button"
          aria-label="Copy"
          onClick={handleCopy}
          style={{
            display: "flex", alignItems: "center", gap: 4, padding: "7px 10px",
            background: "transparent", border: "none", cursor: "pointer",
            color: copied ? "var(--fg-secondary)" : "var(--accent-primary)",
            fontFamily: "var(--font-mono)", fontSize: 12, whiteSpace: "nowrap", flexShrink: 0,
          }}
        >
          {copied
            ? <><Check size={12} /> Copied</>
            : <><Copy size={12} /> Copy</>
          }
        </button>
      </div>
      {alt && (
        <div style={{ marginTop: 4, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--fg-tertiary)" }}>
          or &nbsp;{alt}
        </div>
      )}
    </div>
  );
}

/** A compact inline copyable command chip (no $ prefix, no alt). */
function CopyChip({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  function handleCopy() {
    if (!navigator.clipboard) return;
    if (copyTimer.current) clearTimeout(copyTimer.current);
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <div style={{
      display: "inline-flex", alignItems: "center",
      background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)",
      borderRadius: 7, overflow: "hidden",
    }}>
      <span style={{
        padding: "6px 10px",
        fontFamily: "var(--font-mono)", fontSize: 12,
        color: "var(--fg-primary)", whiteSpace: "nowrap",
      }}>
        {command}
      </span>
      <button
        type="button"
        aria-label="Copy command"
        onClick={handleCopy}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "6px 8px", background: "transparent", border: "none",
          borderLeft: "1px solid var(--border-subtle)", cursor: "pointer",
          color: copied ? "var(--fg-secondary)" : "var(--accent-primary)",
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}

type PlatformEntry = {
  os: "macos" | "linux" | "windows";
  name: string;
  Icon: React.ComponentType<{ size?: number }>;
};

const PLATFORMS: PlatformEntry[] = [
  { os: "macos", name: "macOS", Icon: FaApple },
  { os: "linux", name: "Linux", Icon: FaLinux },
  { os: "windows", name: "Windows", Icon: FaWindows },
];

/** A single platform install card. */
function PlatformCard({
  entry,
  command,
  detected,
}: {
  entry: PlatformEntry;
  command: string;
  detected: boolean;
}) {
  const { Icon } = entry;
  const label = pkgLabel(command);

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 12,
      background: "var(--surface-elevated)",
      border: detected ? "1px solid var(--accent-primary)" : "1px solid var(--border-subtle)",
      borderRadius: 12, padding: 14,
    }}>
      {/* Card header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <Icon size={14} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-primary)" }}>{entry.name}</span>
          {detected && (
            <span style={{
              fontSize: 10, borderRadius: 6, padding: "1px 6px",
              background: "var(--accent-dim)", color: "var(--accent-primary)",
              fontWeight: 500,
            }}>
              Detected
            </span>
          )}
        </div>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-tertiary)" }}>
          {label}
        </span>
      </div>
      {/* Command field */}
      <CommandField command={command} />
    </div>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
      <div style={{
        width: 18, height: 18, borderRadius: "50%", flexShrink: 0,
        background: "var(--accent-dim)", display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, color: "var(--accent-primary)" }}>{n}</span>
      </div>
      <span style={{ fontSize: 13, color: "var(--fg-secondary)", lineHeight: 1.5 }}>{text}</span>
    </div>
  );
}

function ErrorPanel({ descriptor, error, account, onRetry }: { descriptor: ProviderDescriptor; error: string; account: string | null; onRetry: () => void }) {
  const hint = diagnoseError(descriptor, error);
  const [showDetails, setShowDetails] = useState(!hint);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  function copyError() {
    if (!navigator.clipboard) return;
    if (copyTimer.current) clearTimeout(copyTimer.current);
    navigator.clipboard.writeText(error).then(() => {
      setCopied(true);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Head */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8, flexShrink: 0,
          background: "var(--surface-elevated)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <ShieldAlert size={19} color="var(--status-failed)" />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-primary)" }}>
            {hint ? hint.title : `Couldn't reach ${descriptor.displayName}`}
          </div>
          <div style={{ fontSize: 13, color: "var(--fg-secondary)", lineHeight: 1.5 }}>
            {hint
              ? "Grant the access below, then try again."
              : `This is usually a permissions or configuration issue on the ${descriptor.displayName} side.`}
          </div>
          {account ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
              <UserRound size={13} color="var(--fg-tertiary)" style={{ flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: "var(--fg-tertiary)", flexShrink: 0 }}>Signed in as</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-secondary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account}</span>
            </div>
          ) : null}
        </div>
      </div>

      {/* How to fix */}
      {hint && (
        <div style={{
          display: "flex", flexDirection: "column", gap: 11, padding: 14, borderRadius: 12,
          background: "var(--surface-elevated)", border: "1px solid var(--border-subtle)",
        }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.04em", color: "var(--fg-tertiary)" }}>HOW TO FIX</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {hint.steps.map((s, i) => <Step key={s} n={i + 1} text={s} />)}
          </div>
        </div>
      )}

      {/* Error details */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button type="button" onClick={() => setShowDetails((v) => !v)} style={{
            display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "none",
            cursor: "pointer", color: "var(--fg-secondary)", fontSize: 12, padding: 0,
          }}>
            <ChevronDown size={15} style={{ transform: showDetails ? "rotate(180deg)" : "rotate(0deg)" }} />
            Error details
          </button>
          <button type="button" aria-label={copied ? "Copied" : "Copy error"} onClick={copyError} style={{
            display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none",
            cursor: "pointer", color: copied ? "var(--fg-secondary)" : "var(--accent-primary)", fontSize: 12,
          }}>
            {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
          </button>
        </div>
        {showDetails && (
          <div style={{
            padding: "10px 12px", borderRadius: 8,
            background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)",
          }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--fg-secondary)", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {error}
            </span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 6 }}>
        {hint?.docsUrl ? (
          <a href={hint.docsUrl} target="_blank" rel="noreferrer" style={{
            display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--accent-primary)", textDecoration: "none",
          }}>
            {hint.docsLabel ?? "Docs"} <ExternalLink size={11} />
          </a>
        ) : <span />}
        <Button onClick={onRetry}>
          <RefreshCw size={14} style={{ marginRight: 6 }} /> Try again
        </Button>
      </div>
    </div>
  );
}

export function ConnectWizard({
  descriptor, actions = defaultActions, onConnected,
}: {
  descriptor: ProviderDescriptor;
  actions?: Actions;
  onConnected: (context?: string) => void;
}) {
  const qc = useQueryClient();
  const provider = descriptor.id;
  const [phase, setPhase] = useState<Phase>("checking");
  const [clusters, setClusters] = useState<CloudCluster[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [paramFields, setParamFields] = useState<ParamField[]>([]);
  const [params, setParams] = useState<Record<string, string>>({});
  const detectedOS = detectOS();

  async function listClusters(p: Record<string, string>) {
    setParams(p);
    setPhase("listing");
    try {
      const res = await actions.list(provider, p);
      if (res.error) { setError(res.stderr || res.error); setPhase("error"); return; }
      setClusters(res.clusters ?? []);
      setPhase("pick");
    } catch (e) {
      setError(e instanceof Error ? e.message : "list failed");
      setPhase("error");
    }
  }

  async function runCheck() {
    setPhase("checking");
    setError(null);
    try {
      const check = await actions.check(provider);
      setAccount(check.account ?? null);
      const step = nextStepFromCheck(check);
      if (step !== "ready") { setPhase(step); return; }
      if (descriptor.requiredParams.length > 0) {
        const fields: ParamField[] = [];
        for (const spec of descriptor.requiredParams) {
          let opts;
          try { opts = await actions.paramOptions(provider, spec.key); }
          catch { setError(`Couldn't load ${spec.label.toLowerCase()} options.`); setPhase("error"); return; }
          const options = opts.default && !opts.options.includes(opts.default)
            ? [opts.default, ...opts.options]
            : opts.options;
          fields.push({ spec, options, value: opts.default ?? options[0] ?? "", fromDefault: !!opts.default });
        }
        setParamFields(fields);
        setPhase("needs-params");
        return;
      }
      await listClusters({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "check failed");
      setPhase("error");
    }
  }

  useEffect(() => { void runCheck(); /* eslint-disable-next-line */ }, []);

  async function connect(cluster: CloudCluster) {
    setPhase("connecting");
    setError(null);
    try {
      const r = await actions.connect(provider, cluster, params);
      qc.invalidateQueries({ queryKey: ["contexts"] });
      toast.success(`Connected to "${cluster.name}"`, {
        description: r.backupPath ? `Kubeconfig backed up to ${r.backupPath}` : undefined,
      });
      onConnected(r.context);
    } catch (e) {
      setError(e instanceof Error ? e.message : "connect failed");
      setPhase("error");
    }
  }

  if (phase === "checking" || phase === "listing" || phase === "connecting") {
    const msg =
      phase === "connecting" ? "Connecting…"
      : phase === "listing" ? "Loading clusters…"
      : "Checking your setup…";
    return <div style={{ fontSize: 13, color: "var(--fg-secondary)" }}>{msg}</div>;
  }

  if (phase === "needs-cli") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Heading */}
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-primary)" }}>
            Install the {descriptor.displayName} CLI
          </div>
          <div style={{ fontSize: 13, color: "var(--fg-secondary)", lineHeight: 1.5 }}>
            Pick your platform, run the command in your terminal, then re-check.
          </div>
        </div>

        {/* Per-platform cards */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {PLATFORMS.map((entry) => (
            <PlatformCard
              key={entry.os}
              entry={entry}
              command={descriptor.installHelp[entry.os]}
              detected={detectedOS === entry.os}
            />
          ))}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <a
            href={descriptor.installHelp.docsUrl}
            target="_blank"
            rel="noreferrer"
            style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--accent-primary)", textDecoration: "none" }}
          >
            Install docs <ExternalLink size={11} />
          </a>
          <Button onClick={() => void runCheck()}>Re-check</Button>
        </div>
      </div>
    );
  }

  if (phase === "needs-extra" && descriptor.extraInstallHelp) {
    const x = descriptor.extraInstallHelp;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-primary)" }}>Install {x.binary}</div>
          <div style={{ fontSize: 13, color: "var(--fg-secondary)", lineHeight: 1.5 }}>
            kubectl needs {x.binary} to reach {descriptor.displayName} clusters. Install it, then re-check.
          </div>
        </div>
        <CommandField command={x.command} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <a href={x.docsUrl} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--accent-primary)", textDecoration: "none" }}>
            Plugin docs <ExternalLink size={11} />
          </a>
          <Button onClick={() => void runCheck()}>Re-check</Button>
        </div>
      </div>
    );
  }

  if (phase === "needs-extra") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13, color: "var(--fg-secondary)", lineHeight: 1.5 }}>
          kubectl needs an extra command-line tool to reach {descriptor.displayName} clusters. Install it from the {descriptor.displayName} docs, then re-check.
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button onClick={() => void runCheck()}>Re-check</Button>
        </div>
      </div>
    );
  }

  if (phase === "needs-params") {
    const submit = () => void listClusters(Object.fromEntries(paramFields.map((f) => [f.spec.key, f.value])));
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {paramFields.map((f, i) => (
          <div key={f.spec.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor={`param-${f.spec.key}`} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-tertiary)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              {f.spec.label}
            </label>
            <select
              id={`param-${f.spec.key}`}
              value={f.value}
              onChange={(e) => {
                const v = e.target.value;
                setParamFields((prev) => prev.map((p, j) => (j === i ? { ...p, value: v } : p)));
              }}
              style={{
                width: "100%", appearance: "none", cursor: "pointer",
                background: "var(--surface-sunken)", color: "var(--fg-primary)",
                border: "1px solid var(--border-strong)", borderRadius: 8,
                padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: 13,
              }}
            >
              {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            {f.fromDefault ? (
              <span style={{ fontSize: 11.5, color: "var(--fg-tertiary)", lineHeight: 1.4 }}>
                Pre-selected from your {descriptor.displayName} CLI config.
              </span>
            ) : null}
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button onClick={submit} disabled={paramFields.some((f) => !f.value)}>Continue</Button>
        </div>
      </div>
    );
  }

  if (phase === "needs-login") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 13, color: "var(--fg-secondary)" }}>{descriptor.loginHelp.explanation}</div>
        <CommandField command={descriptor.loginHelp.command} />
        <div><Button onClick={() => void runCheck()}>Re-check</Button></div>
      </div>
    );
  }

  if (phase === "error") {
    return <ErrorPanel descriptor={descriptor} error={error ?? "The connection failed."} account={account} onRetry={() => void runCheck()} />;
  }

  // pick
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {clusters.length === 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Account bar */}
          {account && (
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              background: "var(--surface-elevated)", border: "1px solid var(--border-subtle)",
              borderRadius: 10, padding: "11px 14px",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: "50%",
                  background: "var(--accent-dim)", border: "1px solid var(--accent-primary)",
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                  <UserRound size={14} color="var(--accent-primary)" />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-tertiary)",
                    letterSpacing: "0.06em", textTransform: "uppercase",
                  }}>
                    Connected Account
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-primary)" }}>
                    {account}
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: "var(--status-running)", flexShrink: 0,
                }} />
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 11,
                  color: "var(--status-running)",
                }}>
                  Authenticated
                </span>
              </div>
            </div>
          )}

          {/* Focal block */}
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            gap: 12, padding: "10px 0", textAlign: "center",
          }}>
            <div style={{
              width: 56, height: 56, borderRadius: "50%",
              background: "var(--surface-elevated)", border: "1px solid var(--border-subtle)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <CloudOff size={24} color="var(--fg-secondary)" />
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--fg-primary)" }}>
              No clusters in this account
            </div>
            <div style={{
              fontSize: 13, color: "var(--fg-secondary)", lineHeight: 1.5,
              maxWidth: 380, textAlign: "center",
            }}>
              This {descriptor.displayName} account doesn't have any Kubernetes clusters yet. Create one, then re-check.
            </div>
          </div>

          {/* Actions row */}
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 10 }}>
            {descriptor.consoleUrl && (
              <a
                href={descriptor.consoleUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  background: "var(--accent-primary)", color: "var(--fg-inverse)",
                  borderRadius: 9, padding: "11px 18px",
                  fontSize: 13, fontWeight: 600, textDecoration: "none",
                }}
              >
                <ExternalLink size={14} />
                Open {descriptor.displayName}
              </a>
            )}
            <button
              type="button"
              onClick={() => void runCheck()}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                background: "var(--surface-elevated)", color: "var(--fg-primary)",
                border: "1px solid var(--border-subtle)", borderRadius: 9,
                padding: "11px 18px", fontSize: 13, fontWeight: 500, cursor: "pointer",
              }}
            >
              <RefreshCw size={14} />
              Re-check
            </button>
          </div>

          {/* Switch line */}
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, color: "var(--fg-tertiary)" }}>Wrong account?</span>
            <CopyChip command={descriptor.loginHelp.command} />
          </div>
        </div>
      ) : (
        <>
          {account && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--fg-tertiary)", marginBottom: 2 }}>
              <UserRound size={12} />
              <span>Connected as {account}</span>
            </div>
          )}
          {clusters.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-label={`Connect ${c.name}`}
              onClick={() => void connect(c)}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px",
                borderRadius: 8, cursor: "pointer", textAlign: "left",
                background: "var(--surface-primary)", border: "1px solid var(--border-strong)", color: "var(--fg-primary)",
              }}
            >
              <span style={{ fontWeight: 600 }}>{c.name}</span>
              <span style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>{c.region}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
