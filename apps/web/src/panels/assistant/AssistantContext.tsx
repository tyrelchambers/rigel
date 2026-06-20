// AssistantContext — provider + hook for the entire Assistant panel.
// All cross-cutting state (tab, dialogs, expanded rows, action runner) lives
// here so leaf components never receive prop-drilled values.

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { useAssistantAction, type ActionBlock, type AssistantRequest } from "@/lib/api";
import { useAssistant, type AssistantDerived } from "./useAssistant";
import type { AssistantAuditEntry } from "@rigel/k8s";
import { outcomeGlyph, outcomeColorClass, relativeTime } from "./display";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TabKey = "overview" | "needs" | "rules" | "activity" | "settings";

/**
 * Coarse render phase, debounced so the Installer never flashes during load.
 * - "loading": deployments not in yet, OR in but the agent hasn't appeared and
 *   we haven't waited long enough to be sure it isn't there.
 * - "install": deployments settled with no agent present → genuinely not installed.
 * - "ready": the agent deployment exists → show the installed tabs.
 */
export type AssistantPhase = "loading" | "install" | "ready";

export interface AssistantContextValue {
  d: AssistantDerived;
  /** Debounced render phase (drives skeleton vs install vs installed). */
  phase: AssistantPhase;
  ns: string;
  working: boolean;
  /** Currently selected tab (only meaningful when installed). */
  tab: TabKey;
  setTab: (t: TabKey) => void;
  /** Last action error message, or null. */
  actionError: string | null;
  /** Set of expanded audit-row IDs. */
  expanded: Set<string>;
  toggleExpanded: (id: string) => void;
  /** Run an assistant action: clears the previous error, mutates, surfaces failures. */
  run: (req: AssistantRequest, onDone?: () => void) => void;
  /** Open the revert dialog for a backup YAML. */
  openRevert: (yaml: string, label: string) => void;
  /** Queue an action for the ConfirmSheet. */
  runSuggestion: (a: ActionBlock) => void;
  openUninstall: () => void;
  openAllActivity: () => void;
  /**
   * Open the create-namespace confirmation dialog. The caller supplies the
   * `doInstall` callback which the dialog will invoke on confirm.
   */
  openConfirmCreateNs: (doInstall: () => void) => void;
  /** Namespace chosen by the install form (before agent is installed). */
  installNamespace: string;
  setInstallNamespace: (ns: string) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const AssistantContext = createContext<AssistantContextValue | null>(null);

export function useAssistantCtx(): AssistantContextValue {
  const ctx = use(AssistantContext);
  if (!ctx) throw new Error("useAssistantCtx must be used inside <AssistantProvider>");
  return ctx;
}

// ---------------------------------------------------------------------------
// Minimal audit row for the full-activity dialog (avoids circular dep with
// the full AuditRow.tsx which handles expand/revert).
// ---------------------------------------------------------------------------

function AuditRowSummary({ e }: { e: AssistantAuditEntry }) {
  const { run, ns, openRevert, d } = useAssistantCtx();
  const backup = e.backupRef ? d.backupYAML(e.backupRef) : undefined;
  return (
    <div
      className="rounded-md border p-2"
      onContextMenu={(ev) => {
        ev.preventDefault();
        run({ action: "silence", namespace: ns, fingerprint: e.fingerprint });
      }}
    >
      <div className="flex items-center gap-2">
        <span className={outcomeColorClass(e.outcome)}>{outcomeGlyph(e.outcome)}</span>
        <span className="truncate font-mono text-sm font-medium">{e.incident}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground" title={e.at}>
          {relativeTime(e.at)}
        </span>
      </div>
      {e.proposal && <p className="mt-1 text-sm text-muted-foreground">{e.proposal}</p>}
      {e.command && (
        <p className="select-text font-mono text-[10px] text-muted-foreground">{e.command}</p>
      )}
      {backup && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-1"
          onClick={() => openRevert(backup, e.proposal ?? e.incident)}
        >
          Revert
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs rendered inside the provider (co-located so they share state
// without prop-drilling).
// ---------------------------------------------------------------------------

interface DialogsProps {
  pendingAction: ActionBlock | null;
  setPendingAction: (a: ActionBlock | null) => void;
  pendingRevert: { yaml: string; label: string } | null;
  setPendingRevert: (r: { yaml: string; label: string } | null) => void;
  reverting: boolean;
  setReverting: (v: boolean) => void;
  confirmUninstall: boolean;
  setConfirmUninstall: (v: boolean) => void;
  showAllActivity: boolean;
  setShowAllActivity: (v: boolean) => void;
  confirmCreateNs: boolean;
  setConfirmCreateNs: (v: boolean) => void;
  doInstallRef: React.RefObject<(() => void) | null>;
  setActionError: (e: string | null) => void;
}

function AssistantDialogs(p: DialogsProps) {
  const { d, ns, run, installNamespace } = useAssistantCtx();
  const audit = d.clusterState?.audit ?? [];

  return (
    <>
      {/* Create-namespace confirmation (install flow) */}
      <Dialog open={p.confirmCreateNs} onOpenChange={p.setConfirmCreateNs}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create namespace "{installNamespace}"?</DialogTitle>
            <DialogDescription>
              Namespace "{installNamespace}" doesn't exist. Create it and install the assistant
              there?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => p.setConfirmCreateNs(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                p.setConfirmCreateNs(false);
                p.doInstallRef.current?.();
              }}
            >
              Create &amp; install
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revert dialog */}
      <Dialog
        open={!!p.pendingRevert}
        onOpenChange={(o) => !o && p.setPendingRevert(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Revert "{p.pendingRevert?.label}"?</DialogTitle>
            <DialogDescription>
              Re-applies the pre-mutation snapshot the agent captured. Review the exact YAML before
              it runs.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-72 select-text overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre">
            {p.pendingRevert?.yaml}
          </pre>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={p.reverting}
              onClick={() => p.setPendingRevert(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={p.reverting}
              onClick={async () => {
                if (!p.pendingRevert) return;
                p.setReverting(true);
                p.setActionError(null);
                try {
                  const res = await fetch("/api/apply", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ yaml: p.pendingRevert.yaml }),
                  });
                  const data = (await res.json().catch(() => ({}))) as {
                    error?: string;
                    code?: number;
                    stderr?: string;
                  };
                  if (!res.ok) throw new Error(data.error ?? res.statusText);
                  if (typeof data.code === "number" && data.code !== 0)
                    throw new Error(data.stderr || `exit ${data.code}`);
                  p.setPendingRevert(null);
                } catch (err) {
                  p.setActionError(err instanceof Error ? err.message : String(err));
                } finally {
                  p.setReverting(false);
                }
              }}
            >
              {p.reverting ? "Reverting…" : "Apply revert"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Uninstall confirm dialog */}
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

      {/* Full activity modal */}
      <Dialog open={p.showAllActivity} onOpenChange={p.setShowAllActivity}>
        <DialogContent className="max-h-[80vh] overflow-auto max-w-2xl">
          <DialogHeader>
            <DialogTitle>Activity — {audit.length} entries</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {audit.map((e) => (
              <AuditRowSummary key={`${e.incident}-${e.at}`} e={e} />
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirm sheet for queued suggestions */}
      <ConfirmSheet
        action={p.pendingAction}
        open={!!p.pendingAction}
        onClose={() => p.setPendingAction(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const [installNamespace, setInstallNamespace] = useState("default");
  const [tab, setTab] = useState<TabKey>("overview");
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [pendingRevert, setPendingRevert] = useState<{ yaml: string; label: string } | null>(null);
  const [reverting, setReverting] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [confirmCreateNs, setConfirmCreateNs] = useState(false);

  // Ref to hold the install callback when namespace-create confirmation is needed.
  const doInstallRef = useRef<(() => void) | null>(null);

  const d = useAssistant(installNamespace);
  const action = useAssistantAction();
  const working = action.isPending;

  const ns = d.installedNamespace ?? installNamespace ?? "default";

  // Debounce the "not installed" verdict. Deployments arrive as a stream of
  // ADDED deltas (the server's first snapshot is empty), so the helmsman-assistant
  // deployment can show up a moment after the first few deployments. Without this,
  // `!isInstalled` reads true for that gap and the Installer flashes. So we only
  // conclude "not installed" after deployments have been present (with no agent)
  // for a beat; the instant the agent appears we jump straight to "ready".
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (d.isInstalled || !d.ready.deployments) {
      setSettled(false);
      return;
    }
    const t = setTimeout(() => setSettled(true), 1000);
    return () => clearTimeout(t);
  }, [d.isInstalled, d.ready.deployments]);

  const phase: AssistantPhase = d.isInstalled
    ? "ready"
    : d.ready.deployments && settled
      ? "install"
      : "loading";

  const run = useCallback(
    (req: AssistantRequest, onDone?: () => void) => {
      setActionError(null);
      action.mutate(req, {
        onError: (err) => setActionError(err.message),
        onSuccess: () => onDone?.(),
      });
    },
    [action],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openRevert = useCallback((yaml: string, label: string) => {
    setPendingRevert({ yaml, label });
  }, []);

  const runSuggestion = useCallback((a: ActionBlock) => {
    setPendingAction(a);
  }, []);

  const openUninstall = useCallback(() => {
    setConfirmUninstall(true);
  }, []);

  const openAllActivity = useCallback(() => {
    setShowAllActivity(true);
  }, []);

  const openConfirmCreateNs = useCallback((doInstall: () => void) => {
    doInstallRef.current = doInstall;
    setConfirmCreateNs(true);
  }, []);

  const value = useMemo<AssistantContextValue>(
    () => ({
      d,
      phase,
      ns,
      working,
      tab,
      setTab,
      actionError,
      expanded,
      toggleExpanded,
      run,
      openRevert,
      runSuggestion,
      openUninstall,
      openAllActivity,
      openConfirmCreateNs,
      installNamespace,
      setInstallNamespace,
    }),
    [
      d, phase, ns, working, tab, actionError, expanded,
      toggleExpanded, run, openRevert, runSuggestion,
      openUninstall, openAllActivity, openConfirmCreateNs,
      installNamespace,
    ],
  );

  return (
    <AssistantContext value={value}>
      {children}
      <AssistantDialogs
        pendingAction={pendingAction}
        setPendingAction={setPendingAction}
        pendingRevert={pendingRevert}
        setPendingRevert={setPendingRevert}
        reverting={reverting}
        setReverting={setReverting}
        confirmUninstall={confirmUninstall}
        setConfirmUninstall={setConfirmUninstall}
        showAllActivity={showAllActivity}
        setShowAllActivity={setShowAllActivity}
        confirmCreateNs={confirmCreateNs}
        setConfirmCreateNs={setConfirmCreateNs}
        doInstallRef={doInstallRef}
        setActionError={setActionError}
      />
    </AssistantContext>
  );
}
