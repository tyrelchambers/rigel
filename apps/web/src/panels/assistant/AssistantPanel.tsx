import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BellOff,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { useAssistantAction, type ActionBlock } from "@/lib/api";
import {
  DEFAULT_INSTALL_CONFIG,
  manifestYAML,
  auditEntryId,
  queuedSuggestionId,
  type AssistantInstallConfig,
  type AssistantAuditEntry,
  type AssistantQueuedSuggestion,
  type AlertScope,
} from "@helmsman/k8s";
import { useAssistant, type AssistantDerived } from "./useAssistant";
import { LoadingState } from "@/panels/components/LoadingState";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { alertRuleSummary, type SuggestedAlert, type AlertTarget, type AlertCondition } from "@/lib/alerts";
import {
  tokenLabel,
  tokenColorClass,
  outcomeGlyph,
  outcomeColorClass,
  auditCanExpand,
  relativeTime,
  spendLabel,
  auditCount,
} from "./display";

// Reusable shells -----------------------------------------------------------

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-lg border bg-card p-3 ${className}`}>{children}</div>;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-40 shrink-0 text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

const inputClass =
  "flex-1 rounded-md border bg-background px-2 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring";

// ---------------------------------------------------------------------------

export default function AssistantPanel() {
  // Install-form local state (the form's chosen install namespace also drives
  // state reads before the agent exists).
  const [config, setConfig] = useState<AssistantInstallConfig>(DEFAULT_INSTALL_CONFIG);
  const [installToken, setInstallToken] = useState("");
  const [newToken, setNewToken] = useState("");
  const [showManifest, setShowManifest] = useState(false);
  const [confirmCreateNs, setConfirmCreateNs] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [windowText, setWindowText] = useState("");
  const [webhookText, setWebhookText] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [pendingRevert, setPendingRevert] = useState<{ yaml: string; label: string } | null>(null);
  const [reverting, setReverting] = useState(false);

  const d = useAssistant(config.installNamespace.trim() || "default");
  const action = useAssistantAction();
  const working = action.isPending;

  // Seed the window/webhook inputs once the live config arrives.
  useEffect(() => {
    setWindowText(d.quietWindow || "22:00-07:00");
    setWebhookText(d.webhookURL);
    // Only when the installed state flips or values change.
  }, [d.quietWindow, d.webhookURL]);

  const namespaceMissing = useMemo(() => {
    const ns = config.installNamespace.trim();
    if (ns === "") return false;
    return !d.allNamespaceNames.includes(ns);
  }, [config.installNamespace, d.allNamespaceNames]);

  // One mutation runner: clears the previous error, runs, surfaces failures.
  function run(req: Parameters<typeof action.mutate>[0], onDone?: () => void) {
    setActionError(null);
    action.mutate(req, {
      onError: (err) => setActionError(err.message),
      onSuccess: () => onDone?.(),
    });
  }

  const ns = d.installedNamespace ?? config.installNamespace.trim() ?? "default";

  // --- Install ---
  function doInstall() {
    const token = installToken.trim();
    const image = config.image.trim();
    const namespace = config.installNamespace.trim();
    if (token === "") return setActionError("Paste the token from `claude setup-token` first.");
    if (image === "") return setActionError("Set a container image first.");
    const repoPath = image.split(":")[0] ?? image;
    if (repoPath !== repoPath.toLowerCase())
      return setActionError(
        "Image repository must be lowercase (Kubernetes rejects uppercase as InvalidImageName).",
      );
    if (namespace === "") return setActionError("Set an install namespace (e.g. default).");
    if (namespace !== namespace.toLowerCase()) return setActionError("Namespace must be lowercase.");
    run(
      {
        action: "install",
        namespace,
        token,
        image,
        spendCapUsd: config.spendCapUsd,
        monitorNamespaces: config.namespaces,
      },
      () => setInstallToken(""),
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Assistant" loading={working || !d.hydrated}>
        {d.hydrated && d.isInstalled && (
          <>
            <StatusPill enabled={d.enabled} />
            <Button
              variant={d.enabled ? "destructive" : "default"}
              size="sm"
              disabled={working}
              onClick={() => run({ action: "kill", namespace: ns, enabled: !d.enabled })}
            >
              {d.enabled ? "Pause agent" : "Resume agent"}
            </Button>
          </>
        )}
      </PanelHeader>

      <div className="flex-1 space-y-3 overflow-auto p-4">
        {/* Error banner (selectable, monospace, red) — never includes the token. */}
        {actionError && (
          <pre className="select-text rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
            {actionError}
          </pre>
        )}

      {!d.hydrated ? (
        <LoadingState message="Loading assistant…" />
      ) : d.isInstalled ? (
        <ControlCenter
          d={d}
          ns={ns}
          working={working}
          windowText={windowText}
          setWindowText={setWindowText}
          webhookText={webhookText}
          setWebhookText={setWebhookText}
          expanded={expanded}
          setExpanded={setExpanded}
          showAllActivity={showAllActivity}
          setShowAllActivity={setShowAllActivity}
          newToken={newToken}
          setNewToken={setNewToken}
          confirmUninstall={confirmUninstall}
          setConfirmUninstall={setConfirmUninstall}
          run={run}
          onRunSuggestion={(a) => setPendingAction(a)}
          onRevert={(yaml, label) => setPendingRevert({ yaml, label })}
        />
      ) : (
        <Installer
          config={config}
          setConfig={setConfig}
          installToken={installToken}
          setInstallToken={setInstallToken}
          showManifest={showManifest}
          setShowManifest={setShowManifest}
          namespaceMissing={namespaceMissing}
          allNamespaceNames={d.allNamespaceNames}
          working={working}
          onInstall={() => (namespaceMissing ? setConfirmCreateNs(true) : doInstall())}
        />
      )}

      {/* Create-namespace confirmation */}
      <Dialog open={confirmCreateNs} onOpenChange={setConfirmCreateNs}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create namespace “{config.installNamespace}”?</DialogTitle>
            <DialogDescription>
              Namespace “{config.installNamespace}” doesn't exist. Create it and install the assistant
              there?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCreateNs(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmCreateNs(false);
                doInstall();
              }}
            >
              Create &amp; install
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revert confirmation — re-applies a stored backup YAML via /api/apply. */}
      <Dialog open={!!pendingRevert} onOpenChange={(o) => !o && setPendingRevert(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Revert “{pendingRevert?.label}”?</DialogTitle>
            <DialogDescription>
              Re-applies the pre-mutation snapshot the agent captured. Review the exact YAML before it
              runs.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-72 select-text overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre">
            {pendingRevert?.yaml}
          </pre>
          <DialogFooter>
            <Button variant="outline" disabled={reverting} onClick={() => setPendingRevert(null)}>
              Cancel
            </Button>
            <Button
              disabled={reverting}
              onClick={async () => {
                if (!pendingRevert) return;
                setReverting(true);
                setActionError(null);
                try {
                  const res = await fetch("/api/apply", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ yaml: pendingRevert.yaml }),
                  });
                  const data = (await res.json().catch(() => ({}))) as {
                    error?: string;
                    code?: number;
                    stderr?: string;
                  };
                  if (!res.ok) throw new Error(data.error ?? res.statusText);
                  if (typeof data.code === "number" && data.code !== 0)
                    throw new Error(data.stderr || `exit ${data.code}`);
                  setPendingRevert(null);
                } catch (err) {
                  setActionError(err instanceof Error ? err.message : String(err));
                } finally {
                  setReverting(false);
                }
              }}
            >
              {reverting ? "Reverting…" : "Apply revert"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
      </div>
    </div>
  );
}

// --- Status pill ------------------------------------------------------------

function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
        enabled
          ? "bg-green-500/15 text-green-600 dark:text-green-400"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {enabled ? "active" : "paused"}
    </span>
  );
}

// --- Installer (not installed) ---------------------------------------------

function Installer({
  config,
  setConfig,
  installToken,
  setInstallToken,
  showManifest,
  setShowManifest,
  namespaceMissing,
  allNamespaceNames,
  working,
  onInstall,
}: {
  config: AssistantInstallConfig;
  setConfig: React.Dispatch<React.SetStateAction<AssistantInstallConfig>>;
  installToken: string;
  setInstallToken: (v: string) => void;
  showManifest: boolean;
  setShowManifest: (v: boolean) => void;
  namespaceMissing: boolean;
  allNamespaceNames: string[];
  working: boolean;
  onInstall: () => void;
}) {
  const monitored = useMemo(
    () =>
      new Set(
        config.namespaces
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    [config.namespaces],
  );
  function toggleMonitored(name: string) {
    const next = new Set(monitored);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setConfig((c) => ({ ...c, namespaces: [...next].sort().join(",") }));
  }

  return (
    <div className="space-y-3">
      <Card>
        <p className="text-sm font-semibold">Install the in-cluster assistant</p>
        <p className="mt-1 text-sm text-muted-foreground">
          A pod that watches the cluster and auto-fixes safe issues while you're away. It is caged by
          RBAC: it can read everything except secrets, and only restart/scale/rollback workloads,
          delete crashlooping pods, and cordon nodes. It can never delete namespaces, PVCs, secrets,
          or change RBAC — those only ever appear here as suggestions for you to run.
        </p>
      </Card>

      <Card>
        <p className="text-sm font-semibold">1. Subscription token</p>
        <p className="mt-1 text-sm text-muted-foreground">
          On a machine logged into your Claude plan, run:
        </p>
        <p className="select-text font-mono text-sm text-primary">claude setup-token</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste the token below — it's stored as a Kubernetes Secret, never shown again.
        </p>
        <input
          type="password"
          autoComplete="off"
          value={installToken}
          onChange={(e) => setInstallToken(e.target.value)}
          placeholder="CLAUDE_CODE_OAUTH_TOKEN"
          className={`mt-2 w-full ${inputClass}`}
        />
      </Card>

      <Card className="space-y-2">
        <p className="text-sm font-semibold">2. Configuration</p>
        <Field label="Image">
          <input
            value={config.image}
            onChange={(e) => setConfig((c) => ({ ...c, image: e.target.value }))}
            className={inputClass}
          />
        </Field>
        <Field label="Install namespace">
          <input
            value={config.installNamespace}
            onChange={(e) => setConfig((c) => ({ ...c, installNamespace: e.target.value }))}
            className={inputClass}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" title="Pick an existing namespace" />}
            >
              <ChevronDown className="size-4 text-primary" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {allNamespaceNames.map((name) => (
                <DropdownMenuItem
                  key={name}
                  onClick={() => setConfig((c) => ({ ...c, installNamespace: name }))}
                >
                  {name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </Field>
        {namespaceMissing && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            Namespace “{config.installNamespace}” doesn't exist — you'll be asked to create it on
            Install.
          </p>
        )}
        <Field label="Monitor namespaces">
          <DropdownMenu>
            <DropdownMenuTrigger className={`flex items-center justify-between ${inputClass}`}>
              <span className="truncate">
                {monitored.size === 0 ? "All namespaces" : [...monitored].sort().join(", ")}
              </span>
              <ChevronDown className="size-4 shrink-0 text-primary" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => setConfig((c) => ({ ...c, namespaces: "" }))}>
                {monitored.size === 0 ? "✓ All namespaces" : "All namespaces"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {allNamespaceNames.map((name) => (
                <DropdownMenuItem
                  key={name}
                  closeOnClick={false}
                  onClick={() => toggleMonitored(name)}
                >
                  {monitored.has(name) ? `✓ ${name}` : name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </Field>
        <Field label="Spend cap ($/mo)">
          <input
            type="number"
            min={0}
            value={config.spendCapUsd}
            onChange={(e) => setConfig((c) => ({ ...c, spendCapUsd: Math.max(0, Number(e.target.value) || 0) }))}
            className={`w-28 ${inputClass}`}
          />
        </Field>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">3. Review manifests</p>
          <Button variant="ghost" size="sm" onClick={() => setShowManifest(!showManifest)}>
            {showManifest ? "Hide" : "Show"}
          </Button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Exactly what will be applied — including the RBAC cage. Nothing is applied until you click
          Install. The token Secret is not shown here.
        </p>
        {showManifest && (
          <pre className="mt-2 max-h-56 select-text overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre">
            {manifestYAML(config)}
          </pre>
        )}
      </Card>

      <Button
        className="w-full"
        disabled={working || installToken.trim() === ""}
        onClick={onInstall}
      >
        {working ? "Installing…" : "Install"}
      </Button>
    </div>
  );
}

// --- Control center (installed) --------------------------------------------

interface ControlProps {
  d: AssistantDerived;
  ns: string;
  working: boolean;
  windowText: string;
  setWindowText: (v: string) => void;
  webhookText: string;
  setWebhookText: (v: string) => void;
  expanded: Set<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  showAllActivity: boolean;
  setShowAllActivity: (v: boolean) => void;
  newToken: string;
  setNewToken: (v: string) => void;
  confirmUninstall: boolean;
  setConfirmUninstall: (v: boolean) => void;
  run: (req: import("@/lib/api").AssistantRequest, onDone?: () => void) => void;
  onRunSuggestion: (a: ActionBlock) => void;
  onRevert: (yaml: string, label: string) => void;
}

function ControlCenter(p: ControlProps) {
  const { d, ns, working, run } = p;
  const audit = d.clusterState?.audit ?? [];
  const queue = d.clusterState?.queue ?? [];
  const report = d.clusterState?.report ?? "";
  const status = d.clusterState?.status;

  const [tab, setTab] = useState<"overview" | "needs" | "rules" | "activity" | "settings">("overview");

  return (
    <div className="space-y-3.5">
      {/* Summary strip — always visible */}
      <Card>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Stat label="Status" value={d.enabled ? "Active" : "Paused"} color={d.enabled ? "text-green-600 dark:text-green-400" : "text-muted-foreground"} />
          <Stat label="Awaiting" value={`${queue.length}`} color={queue.length === 0 ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"} />
          <Stat label="Live issues" value={`${d.liveIssues.length}`} color={d.liveIssues.length === 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"} />
          <Stat label="Fixed" value={`${auditCount(audit, "success")}`} color="text-green-600 dark:text-green-400" />
          <Stat label="Failed" value={`${auditCount(audit, "failure")}`} color={auditCount(audit, "failure") === 0 ? "text-muted-foreground" : "text-red-600 dark:text-red-400"} />
          {status && <Stat label="Spend" value={spendLabel(status.spentUsd, status.spendCapUsd)} color="text-foreground" />}
          {d.tokenExpiry && <Stat label="Token" value={tokenLabel(d.tokenExpiry)} color={tokenColorClass(d.tokenExpiry.level)} />}
        </div>
      </Card>

      {/* Pill tab bar */}
      <div className="flex flex-wrap items-center gap-1.5">
        <TabPill active={tab === "overview"} onClick={() => setTab("overview")}>Overview</TabPill>
        <TabPill active={tab === "needs"} onClick={() => setTab("needs")} badge={queue.length + d.liveIssues.length}>Needs you</TabPill>
        <TabPill active={tab === "rules"} onClick={() => setTab("rules")}>Rules</TabPill>
        <TabPill active={tab === "activity"} onClick={() => setTab("activity")} badge={audit.length}>Activity</TabPill>
        <TabPill active={tab === "settings"} onClick={() => setTab("settings")}>Settings</TabPill>
      </div>

      {/* Tab: Overview */}
      {tab === "overview" && (
        <div className="space-y-3.5">
          {report && (
            <Card>
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">Last report</p>
                <Button variant="ghost" size="sm" disabled={working} onClick={() => run({ action: "clearReport", namespace: ns })}>
                  Clear
                </Button>
              </div>
              <p className="mt-1 select-text text-sm text-muted-foreground whitespace-pre-wrap">{report}</p>
            </Card>
          )}

          {queue.length > 0 && (
            <button
              type="button"
              onClick={() => setTab("needs")}
              className="flex w-full items-center gap-2 rounded-lg border bg-card p-3 text-left hover:bg-muted/50"
            >
              <AlertTriangle className="size-4 text-amber-500" />
              <span className="text-sm font-medium">
                {queue.length} fix{queue.length === 1 ? "" : "es"} awaiting your approval
              </span>
              <ChevronRight className="ml-auto size-4 text-muted-foreground" />
            </button>
          )}

          <Section
            title="Recent activity"
            right={
              audit.length > 5 ? (
                <Button variant="ghost" size="sm" onClick={() => setTab("activity")}>
                  View all
                </Button>
              ) : undefined
            }
          >
            <Card>
              {audit.length === 0 ? (
                <p className="text-sm text-muted-foreground">No actions yet.</p>
              ) : (
                <div className="max-h-80 space-y-2 overflow-auto">
                  {audit.slice(0, 5).map((e) => (
                    <AuditRow key={auditEntryId(e)} e={e} {...p} />
                  ))}
                </div>
              )}
            </Card>
          </Section>

          {!report && queue.length === 0 && audit.length === 0 && (
            <Card>
              <p className="text-sm text-muted-foreground">
                All quiet — the agent is watching and hasn't needed to act.
              </p>
            </Card>
          )}
        </div>
      )}

      {/* Tab: Needs you */}
      {tab === "needs" && (
        <div className="space-y-3.5">
          {queue.length > 0 && (
            <Section title={`Awaiting your approval (${queue.length})`}>
              {queue.map((q: AssistantQueuedSuggestion) => (
                <Card key={queuedSuggestionId(q)} className="space-y-1.5">
                  <p className="font-mono text-sm font-medium">{q.incident}</p>
                  <p className="text-sm">{q.suggestion}</p>
                  <p className="text-xs text-muted-foreground">{q.reason}</p>
                  {q.action && (
                    <Button size="sm" onClick={() => p.onRunSuggestion(q.action as ActionBlock)}>
                      {q.action.label}
                    </Button>
                  )}
                </Card>
              ))}
            </Section>
          )}

          <Section title={`Live cluster issues (${d.liveIssues.length})`}>
            {d.liveIssues.length === 0 ? (
              <p className="text-sm text-muted-foreground">Cluster is clean — nothing to remediate.</p>
            ) : (
              d.liveIssues.map((issue) => (
                <Card key={issue.fingerprint}>
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />
                    <span className="truncate font-mono text-sm font-medium">{issue.location}</span>
                    <span className="ml-auto font-mono text-xs text-amber-600 dark:text-amber-400">{issue.reason}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Silence this incident (agent stops acting on it)"
                      disabled={working}
                      onClick={() => run({ action: "silence", namespace: ns, fingerprint: issue.fingerprint })}
                    >
                      <BellOff className="size-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                </Card>
              ))
            )}
          </Section>
        </div>
      )}

      {/* Tab: Rules */}
      {tab === "rules" && (
        <div className="space-y-3.5">
          <AlertsCard d={d} ns={ns} working={working} run={run} />

          <Card className="space-y-2">
            <p className="text-sm font-semibold">Autonomy &amp; notifications</p>
            <p className="text-xs text-muted-foreground">How the agent acts on safe fixes.</p>
            <div className="flex gap-1.5">
              {([
                ["Auto", "auto"],
                ["Advisory", "advisory"],
                ["Quiet-hours", "window"],
              ] as const).map(([label, value]) => (
                <Button
                  key={value}
                  size="sm"
                  variant={d.autonomyMode === value ? "default" : "secondary"}
                  disabled={working}
                  onClick={() => run({ action: "setMode", namespace: ns, mode: value, window: p.windowText })}
                >
                  {label}
                </Button>
              ))}
            </div>
            {d.autonomyMode === "window" && (
              <>
                <Field label="Window">
                  <input value={p.windowText} onChange={(e) => p.setWindowText(e.target.value)} placeholder="22:00-07:00" className={inputClass} />
                  <Button variant="ghost" size="sm" disabled={working} onClick={() => run({ action: "setMode", namespace: ns, mode: "window", window: p.windowText })}>
                    Save
                  </Button>
                </Field>
                <p className="text-xs text-muted-foreground">
                  Outside the window (agent timezone), safe fixes are queued for approval instead of
                  auto-run.
                </p>
              </>
            )}
            <Field label="Notify webhook">
              <input value={p.webhookText} onChange={(e) => p.setWebhookText(e.target.value)} placeholder="Slack/Discord/ntfy URL (optional)" className={inputClass} />
              <Button variant="ghost" size="sm" disabled={working} onClick={() => run({ action: "setMode", namespace: ns, mode: d.autonomyMode, window: p.windowText })}>
                Save
              </Button>
            </Field>
            <p className="border-t pt-2 text-xs text-muted-foreground">
              Signal notifications are set up in the Settings tab.
            </p>
          </Card>

          {d.silenced.length > 0 && (
            <Section title={`Silenced (${d.silenced.length})`}>
              {d.silenced.map((fp) => (
                <Card key={fp}>
                  <div className="flex items-center gap-2">
                    <BellOff className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-xs text-muted-foreground">{fp}</span>
                    <Button variant="ghost" size="sm" className="ml-auto" disabled={working} onClick={() => run({ action: "unsilence", namespace: ns, fingerprint: fp })}>
                      Unsilence
                    </Button>
                  </div>
                </Card>
              ))}
            </Section>
          )}
        </div>
      )}

      {/* Tab: Activity */}
      {tab === "activity" && (
        <div className="space-y-3.5">
          <Section
            title={`Activity (${audit.length})`}
            right={
              audit.length > 10 ? (
                <Button variant="ghost" size="sm" onClick={() => p.setShowAllActivity(true)}>
                  See all
                </Button>
              ) : undefined
            }
          >
            <Card>
              {audit.length === 0 ? (
                <p className="text-sm text-muted-foreground">No actions yet.</p>
              ) : (
                <div className="max-h-80 space-y-2 overflow-auto">
                  {audit.slice(0, 10).map((e) => (
                    <AuditRow key={auditEntryId(e)} e={e} {...p} />
                  ))}
                </div>
              )}
            </Card>
          </Section>
        </div>
      )}

      {/* Tab: Settings */}
      {tab === "settings" && (
        <div className="space-y-3.5">
          {/* Agent pod */}
          <Card>
            <p className="text-sm font-semibold">Agent pod</p>
            {d.agentPod ? (
              <div className="mt-1 flex items-center justify-between">
                <div>
                  <p className="select-text font-mono text-sm text-muted-foreground">{d.agentPod.metadata.name}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                        d.agentPodReason
                          ? "bg-red-500/15 text-red-600 dark:text-red-400"
                          : d.agentPod.status?.phase === "Running"
                            ? "bg-green-500/15 text-green-600 dark:text-green-400"
                            : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {d.agentPodReason ?? d.agentPod.status?.phase ?? "Unknown"}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {d.agentPodRestarts} restart{d.agentPodRestarts === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                No agent pod found yet — it may still be scheduling or failing to pull the image.
              </p>
            )}
          </Card>

          {/* Credentials & maintenance */}
          <Card className="space-y-2">
            <p className="text-sm font-semibold">Credentials &amp; maintenance</p>
            <p className="text-sm text-muted-foreground">
              Update the subscription token (run <span className="font-mono">claude setup-token</span> and
              paste it). Saving replaces the Secret and rolls the agent so it picks up the new token. Use
              after a 401 / token expiry.
            </p>
            <input
              type="password"
              autoComplete="off"
              value={p.newToken}
              onChange={(e) => p.setNewToken(e.target.value)}
              placeholder="New CLAUDE_CODE_OAUTH_TOKEN"
              className={`w-full ${inputClass}`}
            />
            <div className="flex gap-2">
              <Button
                disabled={working || p.newToken.trim() === ""}
                onClick={() => run({ action: "updateToken", namespace: ns, token: p.newToken.trim() }, () => p.setNewToken(""))}
              >
                Update token &amp; restart
              </Button>
              <Button variant="secondary" disabled={working} onClick={() => run({ action: "restart", namespace: ns })}>
                <RotateCcw className="size-4" /> Restart agent
              </Button>
            </div>
          </Card>

          {/* Uninstall */}
          <Card>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold">Uninstall</p>
                <p className="text-sm text-muted-foreground">
                  Removes the agent Deployment, RBAC, and token. Keeps the audit history.
                </p>
              </div>
              <Button variant="destructive" disabled={working} onClick={() => p.setConfirmUninstall(true)}>
                Uninstall
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Uninstall confirm dialog — renders regardless of tab */}
      <Dialog open={p.confirmUninstall} onOpenChange={p.setConfirmUninstall}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall the assistant?</DialogTitle>
            <DialogDescription>
              Removes the agent Deployment, RBAC, and token. Keeps the audit history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => p.setConfirmUninstall(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                p.setConfirmUninstall(false);
                run({ action: "uninstall", namespace: ns });
              }}
            >
              Uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Full activity modal — renders regardless of tab */}
      <Dialog open={p.showAllActivity} onOpenChange={p.setShowAllActivity}>
        <DialogContent className="max-h-[80vh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Activity — {audit.length} entries</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {audit.map((e) => (
              <AuditRow key={auditEntryId(e)} e={e} {...p} />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// --- Audit row --------------------------------------------------------------

function AuditRow({
  e,
  d,
  ns,
  working,
  expanded,
  setExpanded,
  run,
  onRevert,
}: ControlProps & { e: AssistantAuditEntry }) {
  const id = auditEntryId(e);
  const isOpen = expanded.has(id);
  const canExpand = auditCanExpand(e.detail, e.analysis);
  const backup = e.backupRef ? d.backupYAML(e.backupRef) : undefined;

  function toggle() {
    if (!canExpand) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="rounded-md border p-2" onContextMenu={(ev) => {
      ev.preventDefault();
      run({ action: "silence", namespace: ns, fingerprint: e.fingerprint });
    }}>
      <button className="flex w-full items-center gap-2 text-left" onClick={toggle} disabled={!canExpand}>
        <span className={outcomeColorClass(e.outcome)}>{outcomeGlyph(e.outcome)}</span>
        <span className="truncate font-mono text-sm font-medium">{e.incident}</span>
        <span className="ml-auto flex items-center gap-2">
          {canExpand && (isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />)}
          <span className="font-mono text-[9px] uppercase text-muted-foreground">{e.tier}</span>
          <span className="font-mono text-[10px] text-muted-foreground" title={e.at}>
            {relativeTime(e.at)}
          </span>
        </span>
      </button>
      {e.proposal && <p className="mt-1 text-sm text-muted-foreground">{e.proposal}</p>}
      {e.command && <p className="select-text font-mono text-[10px] text-muted-foreground">{e.command}</p>}
      {e.detail && (
        <p className={`select-text font-mono text-[10px] text-muted-foreground ${isOpen ? "whitespace-pre-wrap" : "line-clamp-3"}`}>
          {e.detail}
        </p>
      )}
      {isOpen && e.analysis && (
        <div className="mt-1 border-t pt-1">
          <p className="font-mono text-[9px] uppercase text-muted-foreground">Helmsman's analysis</p>
          <p className="select-text whitespace-pre-wrap text-xs text-muted-foreground">{e.analysis}</p>
        </div>
      )}
      {backup && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-1"
          disabled={working}
          onClick={() => onRevert(backup, e.proposal ?? e.incident)}
        >
          <Undo2 className="size-3.5" /> Revert
        </Button>
      )}
    </div>
  );
}

// --- Bits -------------------------------------------------------------------

function TabPill({
  active,
  onClick,
  children,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
      {badge != null && badge > 0 && (
        <span
          className={cn(
            "rounded-full px-1.5 text-[10px] font-semibold tabular-nums",
            active ? "bg-primary-foreground/20" : "bg-muted-foreground/25",
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[9px] font-medium uppercase text-muted-foreground">{label}</span>
      <span className={`text-sm font-semibold ${color}`}>{value}</span>
    </div>
  );
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-muted-foreground">{title}</p>
        {right}
      </div>
      {children}
    </div>
  );
}

// --- Alerts card ------------------------------------------------------------

type AlertKind = "Deployment" | "StatefulSet" | "DaemonSet";
type AlertCondType =
  | "podRestarts"
  | "crashLoop"
  | "oomKilled"
  | "pendingTooLong"
  | "notReady"
  | "deploymentDegraded";

const COND_LABELS: Record<AlertCondType, string> = {
  podRestarts: "Restarts spike",
  crashLoop: "Crash-looping",
  oomKilled: "OOM-killed",
  pendingTooLong: "Stuck pending",
  notReady: "Not ready",
  deploymentDegraded: "Deployment degraded",
};

// Conditions valid for deploymentDegraded scope restriction
const DEGRADED_SCOPES: AlertScope[] = ["cluster", "namespace", "workload"];

function AlertsCard({
  d,
  ns,
  working,
  run,
}: {
  d: AssistantDerived;
  ns: string;
  working: boolean;
  run: ControlProps["run"];
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<AlertScope>("workload");
  const [namespace, setNamespace] = useState("default");
  const [kind, setKind] = useState<AlertKind>("Deployment");
  const [name, setName] = useState("");
  const [condType, setCondType] = useState<AlertCondType>("crashLoop");
  const [threshold, setThreshold] = useState(3);
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [minutes, setMinutes] = useState(5);
  const [cooldown, setCooldown] = useState(0);
  const [label, setLabel] = useState("");

  const needsNamespace = scope !== "cluster";
  const needsName = scope === "workload" || scope === "pod" || scope === "database";
  const allowsDegraded = DEGRADED_SCOPES.includes(scope);

  function handleScopeChange(newScope: AlertScope) {
    setScope(newScope);
    // If the current condType becomes unavailable, reset to crashLoop
    if (condType === "deploymentDegraded" && !DEGRADED_SCOPES.includes(newScope)) {
      setCondType("crashLoop");
    }
  }

  function defaultLabel() {
    const verb: Record<AlertCondType, string> = {
      podRestarts: "restart spikes",
      crashLoop: "crash-looping",
      oomKilled: "OOM kills",
      pendingTooLong: "stuck pending",
      notReady: "not ready",
      deploymentDegraded: "degraded",
    };
    const subject =
      scope === "cluster"
        ? "cluster"
        : scope === "namespace"
          ? namespace
          : name || scope;
    return `${subject} ${verb[condType]}`;
  }

  const valid =
    (!needsNamespace || namespace.trim() !== "") &&
    (!needsName || name.trim() !== "") &&
    (condType !== "podRestarts" || (threshold > 0 && windowMinutes > 0)) &&
    (condType !== "pendingTooLong" || minutes >= 0) &&
    (condType !== "notReady" || minutes >= 0) &&
    (condType !== "deploymentDegraded" || minutes >= 0);

  function create() {
    const target: AlertTarget = { scope };
    if (needsNamespace) target.namespace = namespace.trim();
    if (needsName) target.name = name.trim();
    if (scope === "workload") target.kind = kind;

    let condition: AlertCondition;
    if (condType === "podRestarts") {
      condition = { type: "podRestarts", threshold: Number(threshold), windowMinutes: Number(windowMinutes) };
    } else if (condType === "pendingTooLong" || condType === "notReady" || condType === "deploymentDegraded") {
      condition = { type: condType, minutes: Number(minutes) };
    } else {
      condition = { type: condType };
    }

    const text = label.trim() || defaultLabel();
    const alert: SuggestedAlert = {
      label: `Alert: ${text}`,
      text,
      target,
      condition,
      ...(cooldown > 0 ? { cooldownMinutes: Number(cooldown) } : {}),
    };

    run({ action: "saveAlert", namespace: ns, alert }, () => {
      setOpen(false);
      setName("");
      setLabel("");
    });
  }

  const namePlaceholder =
    scope === "pod" ? "pod name" : scope === "database" ? "CNPG cluster name" : "deployment name";

  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">Alerts</p>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          + New alert
        </Button>
      </div>

      {d.alertRules.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No alerts yet. Click <strong>+ New alert</strong>, or ask in chat —{" "}
          <em>"text me if any pod in default restarts more than 3 times in 5 minutes"</em>.
        </p>
      ) : (
        <div className="space-y-2">
          {d.alertRules.map((rule) => (
            <div
              key={rule.id}
              className={`flex items-start justify-between gap-2 rounded-md border p-2 ${
                rule.enabled ? "" : "opacity-50"
              }`}
            >
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{rule.text}</span>
                <span className="text-sm text-muted-foreground"> — {alertRuleSummary(rule)}</span>
                {!rule.enabled && (
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    disabled
                  </span>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={working}
                  onClick={() =>
                    run({ action: "toggleAlert", namespace: ns, alertId: rule.id, alertEnabled: !rule.enabled })
                  }
                >
                  {rule.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={working}
                  onClick={() => run({ action: "deleteAlert", namespace: ns, alertId: rule.id })}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* New alert dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New alert</DialogTitle>
            <DialogDescription>
              Get notified when a resource hits a condition. Or just ask in chat —{" "}
              <em>"text me if…"</em>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {/* Watch scope */}
            <Field label="Watch">
              <select
                value={scope}
                onChange={(e) => handleScopeChange(e.target.value as AlertScope)}
                className={inputClass}
              >
                <option value="cluster">Cluster</option>
                <option value="namespace">Namespace</option>
                <option value="workload">Workload</option>
                <option value="pod">Pod</option>
                <option value="database">Database</option>
              </select>
            </Field>

            {/* Kind — only for workload */}
            {scope === "workload" && (
              <Field label="Kind">
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as AlertKind)}
                  className={inputClass}
                >
                  <option value="Deployment">Deployment</option>
                  <option value="StatefulSet">StatefulSet</option>
                  <option value="DaemonSet">DaemonSet</option>
                </select>
              </Field>
            )}

            {/* Namespace picker */}
            {needsNamespace && (
              <Field label="Namespace">
                <select
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value)}
                  className={inputClass}
                >
                  {d.allNamespaceNames.length > 0 ? (
                    d.allNamespaceNames.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))
                  ) : (
                    <option value={namespace}>{namespace}</option>
                  )}
                </select>
              </Field>
            )}

            {/* Resource name */}
            {needsName && (
              <Field label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={namePlaceholder}
                  className={inputClass}
                />
              </Field>
            )}

            {/* Condition type */}
            <Field label="When">
              <select
                value={condType}
                onChange={(e) => setCondType(e.target.value as AlertCondType)}
                className={inputClass}
              >
                {(Object.keys(COND_LABELS) as AlertCondType[])
                  .filter((c) => c !== "deploymentDegraded" || allowsDegraded)
                  .map((c) => (
                    <option key={c} value={c}>
                      {COND_LABELS[c]}
                    </option>
                  ))}
              </select>
            </Field>

            {/* Condition params */}
            {condType === "podRestarts" && (
              <Field label="Threshold / window">
                <div className="flex flex-1 items-center gap-2 text-sm">
                  <input
                    type="number"
                    min={1}
                    value={threshold}
                    onChange={(e) => setThreshold(Math.max(1, Number(e.target.value) || 1))}
                    className="w-16 rounded-md border bg-background px-2 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  <span className="text-muted-foreground">times in</span>
                  <input
                    type="number"
                    min={1}
                    value={windowMinutes}
                    onChange={(e) => setWindowMinutes(Math.max(1, Number(e.target.value) || 1))}
                    className="w-16 rounded-md border bg-background px-2 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  <span className="text-muted-foreground">min</span>
                </div>
              </Field>
            )}

            {(condType === "pendingTooLong" ||
              condType === "notReady" ||
              condType === "deploymentDegraded") && (
              <Field label="For (minutes)">
                <input
                  type="number"
                  min={0}
                  value={minutes}
                  onChange={(e) => setMinutes(Math.max(0, Number(e.target.value) || 0))}
                  className={inputClass}
                />
              </Field>
            )}

            {/* Cooldown */}
            <Field label="Cooldown (min)">
              <div className="flex flex-1 flex-col gap-0.5">
                <input
                  type="number"
                  min={0}
                  value={cooldown}
                  onChange={(e) => setCooldown(Math.max(0, Number(e.target.value) || 0))}
                  className={inputClass}
                />
                <span className="text-xs text-muted-foreground">0 = default</span>
              </div>
            </Field>

            {/* Label */}
            <Field label="Label">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={defaultLabel()}
                className={inputClass}
              />
            </Field>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} disabled={working || !valid}>
              Create alert
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
