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

// The one-liner to install kind, per OS Rigel is running on. Each is an
// out-of-the-box option: Homebrew (macOS), winget (bundled on Win10/11 — not
// Chocolatey, which isn't preinstalled), and the official version-pinned binary
// download on Linux. The docs link covers everything else (scoop, arm64, etc.).
const KIND_INSTALL: Record<ClusterOS, string> = {
  mac: "brew install kind",
  windows: "winget install Kubernetes.kind",
  linux: "curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.32.0/kind-linux-amd64 && chmod +x kind && sudo mv kind /usr/local/bin/",
};
const KIND_DOCS = "https://kind.sigs.k8s.io/docs/user/quick-start/#installation";

// Where to get the package manager itself when it's missing (the install command
// above is useless without it).
const INSTALLER_HELP: Record<"brew" | "winget", { label: string; url: string }> = {
  brew: { label: "Homebrew", url: "https://brew.sh" },
  winget: { label: "winget (App Installer)", url: "https://aka.ms/getwinget" },
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
  const ready = clusterToolsReady(tools);
  // Inside the wizard the head and the single footer action belong to the host,
  // so the body renders neither its intro nor its own button row.
  const host = useWizardHost();
  const nameErr = nameError(name);
  const canCreate = ready && !nameErr && !creating;
  const kindCmd = KIND_INSTALL[tools?.os ?? "mac"];

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

  if (!ready) {
    // ── Setup state: explain what's needed and how to get it ──────────────
    return (
      <div className="flex flex-col gap-5">
        {!host && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            This runs a real Kubernetes cluster on your own machine inside Docker, using{" "}
            <span className="font-medium text-foreground">kind</span> or{" "}
            <span className="font-medium text-foreground">k3d</span>. Once it's up, you can deploy to
            it and manage it from Rigel like any other cluster. You just need one of them installed,
            plus Docker running.
          </p>
        )}

        {/* Step 1: install a tool (only when neither is present) */}
        {!tools.kind && !tools.k3d && (
          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium text-muted-foreground">Install a tool (kind is the simplest)</div>
            <div className="flex items-center justify-between overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#161619] pl-4">
              <code className="flex min-w-0 flex-1 items-center gap-2.5 overflow-x-auto py-3.5 font-mono text-xs whitespace-nowrap">
                <span className="shrink-0 text-[#5E6168]">{tools.os === "windows" ? ">" : "$"}</span>
                <span className="text-[#D6D6DC]">{kindCmd}</span>
              </code>
              <button
                type="button"
                onClick={() => copyInstall(kindCmd)}
                className="flex shrink-0 items-center gap-1.5 self-stretch border-l border-white/[0.08] px-4 text-xs font-semibold text-[#4FB0F2] transition-colors hover:bg-white/[0.03]"
              >
                {copied ? <FontAwesomeIcon icon={faCheck} className="size-3.5" /> : <FontAwesomeIcon icon={faCopy} className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            {tools.installer && !tools.installer.present && (
              <p className="text-xs leading-relaxed text-[var(--status-pending)]">
                {INSTALLER_HELP[tools.installer.id].label} isn't installed, so this command won't run yet.{" "}
                <a
                  href={INSTALLER_HELP[tools.installer.id].url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline"
                >
                  Install {tools.installer.id}
                </a>{" "}
                first, or use the manual steps.
              </p>
            )}
            <a
              href={KIND_DOCS}
              target="_blank"
              rel="noreferrer"
              className="self-start text-xs text-[var(--accent-primary)] hover:underline"
            >
              Other ways to install kind
            </a>
          </div>
        )}

        {/* Status checks */}
        <div className="flex flex-col divide-y divide-white/[0.04] overflow-hidden rounded-[10px] border border-white/[0.08] bg-[var(--surface-sunken)]">
          <StatusRow
            ok={tools.kind || tools.k3d}
            okText="kind or k3d installed"
            badText="No cluster tool found"
            badSub="Install kind or k3d to continue"
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
      </div>
    );
  }

  const create = (
    <Button onClick={start} disabled={!canCreate}>
      {creating ? "Creating…" : "Create cluster"}
    </Button>
  );

  // ── Form state: ready to create ───────────────────────────────────────
  return (
    <div className="flex flex-col gap-5">
      {!host && (
        <p className="text-sm leading-relaxed text-muted-foreground">
          kind and k3d run the cluster as Docker containers on this machine. It shows up in Rigel once it's ready.
        </p>
      )}

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

      {/* Both tools are always listed, each saying whether it was found. Hiding
          the one that isn't installed reads as a missing option and leaves the
          user with no idea which tool is about to run. */}
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
                disabled={!available || creating}
                onClick={() => setTool(t)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-md px-3.5 py-2.5 transition-colors",
                  selected ? "bg-white/[0.07]" : "bg-transparent",
                  available ? "cursor-pointer" : "cursor-not-allowed",
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
