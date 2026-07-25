import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck, faCircleCheck, faCircleXmark, faCopy, faArrowsRotate } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useClusterTools, type ClusterOS, type ClusterToolStatus } from "@/lib/api";
import { useWizardHost } from "./onboarding/wizardHost";
import { sendClusterCreate, onClusterEvent } from "@/lib/ws";
import { toast } from "sonner";

/** Creating needs Docker up and at least one of kind/k3d. Shared so a host can
 *  caption the flow without duplicating the rule. */
export function clusterToolsReady(tools: ClusterToolStatus | undefined): boolean {
  return !!tools?.dockerRunning && (tools.kind || tools.k3d);
}

const VERSIONS = [
  { id: "default", label: "Latest" },
  { id: "v1.31", label: "v1.31" },
  { id: "v1.30", label: "v1.30" },
  { id: "v1.29", label: "v1.29" },
];

type Tool = "kind" | "k3d";
type Manager = "brew" | "winget" | "choco";

const OS_LABEL: Record<ClusterOS, string> = { mac: "macOS", windows: "Windows", linux: "Linux" };

// The one-liner to install each tool, per OS Rigel is running on, plus which
// package manager it leans on so a missing one can be called out. Preference is
// for what ships with the OS or is near-universal: Homebrew on macOS, winget on
// Windows (bundled on Win10/11) where the package exists, and the official
// install route on Linux. Each docs link covers the rest (scoop, arm64, etc.).
const INSTALL: Record<Tool, { cmd: Record<ClusterOS, string>; manager: Record<ClusterOS, Manager | null>; docs: string }> = {
  kind: {
    cmd: {
      mac: "brew install kind",
      windows: "winget install Kubernetes.kind",
      linux: "curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.32.0/kind-linux-amd64 && chmod +x kind && sudo mv kind /usr/local/bin/",
    },
    manager: { mac: "brew", windows: "winget", linux: null },
    docs: "https://kind.sigs.k8s.io/docs/user/quick-start/#installation",
  },
  k3d: {
    cmd: {
      mac: "brew install k3d",
      // k3d publishes no winget package, so Windows goes through Chocolatey.
      windows: "choco install k3d",
      linux: "curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash",
    },
    manager: { mac: "brew", windows: "choco", linux: null },
    docs: "https://k3d.io/stable/#installation",
  },
};

// Where to get the package manager itself when it's missing (the install command
// above is useless without it).
const INSTALLER_HELP: Record<Manager, { label: string; url: string }> = {
  brew: { label: "Homebrew", url: "https://brew.sh" },
  winget: { label: "winget (App Installer)", url: "https://aka.ms/getwinget" },
  choco: { label: "Chocolatey", url: "https://chocolatey.org/install" },
};

// Mirrors the server validateClusterName rule (apps/server/src/clusterCreate.ts).
function nameError(name: string): string | null {
  if (!name) return "Enter a cluster name.";
  if (name.length > 50) return "Name is too long (50 max).";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) return "Lowercase letters, digits, dashes only.";
  return null;
}

const INPUT_CLASS =
  "w-full rounded-md border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground " +
  "outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 " +
  "disabled:cursor-not-allowed disabled:opacity-50";
const LABEL_CLASS = "mb-1.5 block text-xs font-medium text-muted-foreground";

export interface CreateClusterBodyProps {
  /** Reset the form when the host (re)opens the flow. */
  active: boolean;
  /** Called when the flow finishes or the user backs out; the host closes itself. */
  onDone: () => void;
  /** Called when a create starts/stops, so a host can block its own dismissal. */
  onBusyChange?: (busy: boolean) => void;
}

export function CreateClusterBody({ active, onDone, onBusyChange }: CreateClusterBodyProps) {
  const { data: tools, refetch, isFetching } = useClusterTools();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [tool, setTool] = useState<"kind" | "k3d">("kind");
  const [version, setVersion] = useState("default");
  const [creating, setCreating] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const onDoneRef = useRef(onDone);
  const onBusyChangeRef = useRef(onBusyChange);
  useEffect(() => { onDoneRef.current = onDone; onBusyChangeRef.current = onBusyChange; });

  useEffect(() => { onBusyChangeRef.current?.(creating); }, [creating]);

  useEffect(() => {
    if (active) { setName(""); setVersion("default"); setTool("kind"); setCreating(false); setLines([]); setError(null); setCopied(false); }
  }, [active]);

  // Brief "Copied" confirmation on the install command, then revert.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  // Default to kind, but if only k3d is installed prefer it. Runs after the reset
  // above (which restores kind) so reopening always starts from a clean default.
  useEffect(() => {
    if (active && tools && !tools.kind && tools.k3d) setTool("k3d");
  }, [active, tools]);

  useEffect(() => {
    if (!creating) return;
    const off = onClusterEvent((e) => {
      if (e.type === "cluster.progress" && e.line) setLines((p) => [...p, e.line!]);
      else if (e.type === "cluster.error") { setError(e.message ?? "create failed"); setCreating(false); }
      else if (e.type === "cluster.done") {
        qc.invalidateQueries({ queryKey: ["contexts"] });
        setCreating(false);
        onDoneRef.current();
        toast.success(`Cluster "${e.context ?? name}" created`, {
          description: e.backupPath
            ? `Kubeconfig backed up to ${e.backupPath}`
            : "Your kubeconfig couldn't be backed up.",
        });
      }
    });
    return off;
  }, [creating, qc]);

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [lines]);

  const dockerOk = !!tools?.dockerRunning;
  // Readiness follows the SELECTED tool, not "any tool": picking one that isn't
  // installed is a legitimate choice that asks for install instructions, so it
  // blocks the create without disabling the option.
  const toolOk = tools ? (tool === "kind" ? tools.kind : tools.k3d) : false;
  const blocked = !dockerOk || !toolOk;
  // Inside the wizard the head and the single footer action belong to the host,
  // so the body renders neither its intro nor its own button row.
  const host = useWizardHost();
  const nameErr = nameError(name);
  const canCreate = !blocked && !nameErr && !creating;
  const install = INSTALL[tool];
  const os = tools?.os ?? "mac";
  const installCmd = install.cmd[os];
  const manager = install.manager[os];
  // Only warn about a manager the probe actually looked for and did not find.
  const managerMissing = manager && tools?.installer?.id === manager && !tools.installer.present;

  function start() {
    setError(null); setLines([]); setCreating(true);
    sendClusterCreate({ tool, name, version });
  }

  function copyInstall(text: string) {
    navigator.clipboard?.writeText(text);
    setCopied(true);
  }

  if (!tools) {
    return <p className="text-sm text-muted-foreground">Checking your environment…</p>;
  }

  const recheck = (
    <Button
      variant={host ? "default" : "ghost"}
      size={host ? undefined : "sm"}
      onClick={() => refetch()}
      disabled={isFetching}
      className={host ? undefined : "bg-white/[0.08] text-white hover:bg-white/[0.12]"}
    >
      <FontAwesomeIcon icon={faArrowsRotate} className={cn("size-3.5", isFetching && "animate-spin")} />
      {isFetching ? "Checking…" : "Re-check"}
    </Button>
  );

  const create = (
    <Button onClick={start} disabled={!canCreate}>
      {creating ? "Creating…" : "Create cluster"}
    </Button>
  );

  return (
    <div className="flex flex-col gap-5">
      {!host && (
        <p className="text-sm leading-relaxed text-muted-foreground">
          kind and k3d run the cluster as Docker containers on this machine. It shows up in Rigel once it's ready.
        </p>
      )}

      {/* Both tools are always listed and both stay selectable, each saying
          whether it was found. Picking the one that isn't installed is how you
          ask for its install instructions, so it leads the form: selecting it
          swaps everything below, and disabling it would strand a user who wants
          that tool with no way to learn how to get it. */}
      <div>
        <span className={LABEL_CLASS}>Tool</span>
        <div className="flex w-full gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-1">
          {(["kind", "k3d"] as const).map((t) => {
            const available = t === "kind" ? tools.kind : tools.k3d;
            const selected = tool === t;
            return (
              <button
                key={t}
                type="button"
                disabled={creating}
                onClick={() => setTool(t)}
                className={cn(
                  "flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md px-3.5 py-2.5 transition-colors",
                  selected ? "bg-white/[0.07]" : "bg-transparent",
                )}
              >
                <span className={cn("text-sm font-semibold", selected ? "text-foreground" : "text-muted-foreground")}>
                  {t}
                </span>
                <span className="text-xs text-[var(--fg-tertiary)]">{available ? "detected" : "not installed"}</span>
              </button>
            );
          })}
        </div>
      </div>

      {blocked ? (
        <>
          {/* How to get the SELECTED tool, on the platform Rigel is running on. */}
          {!toolOk && (
            <div className="flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">
                Install {tool} on {OS_LABEL[os]}
              </div>
              <div className="flex items-center justify-between overflow-hidden rounded-[10px] border border-white/[0.08] bg-[var(--surface-sunken)] pl-4">
                <code className="flex min-w-0 flex-1 items-center gap-2.5 overflow-x-auto py-3.5 font-mono text-xs whitespace-nowrap">
                  <span className="shrink-0 text-[var(--fg-tertiary)]">{os === "windows" ? ">" : "$"}</span>
                  <span className="text-[var(--fg-primary)]">{installCmd}</span>
                </code>
                <button
                  type="button"
                  onClick={() => copyInstall(installCmd)}
                  className="flex shrink-0 items-center gap-1.5 self-stretch border-l border-white/[0.08] px-4 text-xs font-semibold text-[var(--accent-primary)] transition-colors hover:bg-white/[0.03]"
                >
                  {copied ? <FontAwesomeIcon icon={faCheck} className="size-3.5" /> : <FontAwesomeIcon icon={faCopy} className="size-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              {managerMissing && manager && (
                <p className="text-xs leading-relaxed text-[var(--status-pending)]">
                  {INSTALLER_HELP[manager].label} isn't installed, so this command won't run yet.{" "}
                  <a href={INSTALLER_HELP[manager].url} target="_blank" rel="noreferrer" className="font-medium underline">
                    Install {manager}
                  </a>{" "}
                  first, or use the manual steps.
                </p>
              )}
              <a
                href={install.docs}
                target="_blank"
                rel="noreferrer"
                className="self-start text-xs text-[var(--accent-primary)] hover:underline"
              >
                Other ways to install {tool}
              </a>
            </div>
          )}

          {/* What is still missing, for the tool actually selected. */}
          <div className="flex flex-col divide-y divide-white/[0.04] overflow-hidden rounded-[10px] border border-white/[0.08] bg-[var(--surface-sunken)]">
            <StatusRow
              ok={toolOk}
              okText={`${tool} is installed`}
              badText={`${tool} is not installed`}
              badSub="Install it with the command above, then re-check"
              badStatus="Not found"
            />
            <StatusRow
              ok={dockerOk}
              okText="Docker is running"
              badText="Docker is not running"
              badSub="Start Docker, then re-check"
              badStatus="Not running"
            />
          </div>

          {host
            ? host.actionSlot && createPortal(recheck, host.actionSlot)
            : (
              <div className="flex items-center gap-3">
                {recheck}
                <span className="text-xs text-muted-foreground">Run the steps above, then re-check.</span>
              </div>
            )}
        </>
      ) : (
        <>
          <div>
            <label htmlFor="cc-name" className={LABEL_CLASS}>Cluster name</label>
            <input
              id="cc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="dev"
              disabled={creating}
              autoComplete="off"
              spellCheck={false}
              className={INPUT_CLASS}
            />
            {name && nameErr && <p className="mt-1.5 text-xs text-destructive">{nameErr}</p>}
          </div>

          <div>
            <label htmlFor="cc-version" className={LABEL_CLASS}>Kubernetes version</label>
            <select
              id="cc-version"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              disabled={creating}
              className={INPUT_CLASS + " cursor-pointer"}
            >
              {VERSIONS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </div>

          {(creating || lines.length > 0 || error) && (
            <div className="flex flex-col gap-2">
              {creating && (
                <p className="text-xs text-muted-foreground">
                  Creating the cluster inside Docker. This usually takes under a minute.
                </p>
              )}
              {(lines.length > 0 || error) && (
                <pre
                  ref={logRef}
                  className="max-h-52 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground"
                >
                  {lines.join("\n")}
                  {error ? `\n✗ ${error}` : ""}
                </pre>
              )}
            </div>
          )}

          {host ? (
            host.actionSlot && createPortal(create, host.actionSlot)
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Creates a local cluster with {tool}.
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => onDone()} disabled={creating}>
                  Cancel
                </Button>
                {create}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatusRow({
  ok,
  okText,
  badText,
  badSub,
  badStatus,
}: {
  ok: boolean;
  okText: string;
  badText: string;
  /** What to do about it, shown only while the check is failing. */
  badSub: string;
  badStatus: string;
}) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-3">
      {ok ? (
        <FontAwesomeIcon icon={faCircleCheck} className="size-[17px] shrink-0 text-[var(--status-running)]" />
      ) : (
        <FontAwesomeIcon icon={faCircleXmark} className="size-[17px] shrink-0 text-[var(--status-failed)]" />
      )}
      <span className="flex flex-col gap-0.5">
        <span className={cn("text-sm font-medium", ok ? "text-foreground" : "text-zinc-300")}>
          {ok ? okText : badText}
        </span>
        {!ok && <span className="text-xs text-muted-foreground">{badSub}</span>}
      </span>
      <span
        className={cn(
          "ml-auto text-xs font-medium",
          ok ? "text-muted-foreground" : "text-[var(--status-failed)]",
        )}
      >
        {ok ? "OK" : badStatus}
      </span>
    </div>
  );
}
