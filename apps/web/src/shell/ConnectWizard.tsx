import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Check, CloudOff, Copy, ExternalLink, RefreshCw, UserRound } from "lucide-react";
import { FaApple, FaLinux, FaWindows } from "react-icons/fa";
import {
  type ProviderDescriptor, type CloudCluster, type CheckResult, nextStepFromCheck,
} from "@rigel/cloud-connect/src/index";
import {
  cloudCheck as defaultCheck, cloudListClusters as defaultList, cloudConnect as defaultConnect,
  type CloudProvider,
} from "@/lib/api";

interface Actions {
  check: (provider: CloudProvider) => Promise<CheckResult>;
  list: (provider: CloudProvider) => Promise<{ clusters?: CloudCluster[]; error?: string; stderr?: string }>;
  connect: (provider: CloudProvider, cluster: CloudCluster) => Promise<{ context?: string; backupPath?: string | null }>;
}

const defaultActions: Actions = { check: defaultCheck, list: defaultList, connect: defaultConnect };

type Phase = "checking" | "needs-cli" | "needs-extra" | "needs-login" | "listing" | "pick" | "connecting" | "error";

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
  const detectedOS = detectOS();

  async function runCheck() {
    setPhase("checking");
    setError(null);
    try {
      const check = await actions.check(provider);
      setAccount(check.account ?? null);
      const step = nextStepFromCheck(check);
      if (step === "ready") {
        setPhase("listing");
        const res = await actions.list(provider);
        if (res.error) { setError(res.stderr || res.error); setPhase("error"); return; }
        setClusters(res.clusters ?? []);
        setPhase("pick");
      } else {
        setPhase(step);
      }
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
      const r = await actions.connect(provider, cluster);
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

  if (phase === "needs-cli" || phase === "needs-extra") {
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
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ color: "var(--destructive)", fontSize: 13 }}>{error}</div>
        <div><Button onClick={() => void runCheck()}>Try again</Button></div>
      </div>
    );
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
