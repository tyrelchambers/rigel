import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Terminal, Copy, Check, AlertTriangle, Layers, Play, ArrowRight, CheckCircle2, GitPullRequest, ExternalLink } from "lucide-react";
import { fetchPreviewCommand, useAction, applyManifestYaml, proposeRepoFix, type ActionBlock, type ActionResult, type PurgeResult, type RepoFixResponse } from "@/lib/api";
import { listResources } from "@helmsman/catalog";
import { isDestructiveAction } from "@/lib/actionBlocks";

interface ConfirmSheetProps {
  /** The action to confirm and optionally execute. */
  action: ActionBlock | null;
  /** Controlled open state. */
  open: boolean;
  /** Called when the sheet should close (cancelled or after execution). */
  onClose: () => void;
  /**
   * Called when the action is a `purge` — the parent should open the
   * typed-name purge confirm sheet instead.
   */
  onPurge?: (name: string | null, namespace: string) => void;
  /**
   * Set when this sheet was opened from the chat, so the run result is reported
   * back to the parent (ChatPane) which feeds it into the claude session.
   */
  fromChat?: boolean;
  /**
   * Fires after a chat-initiated action runs (success OR failure), with the
   * result and the exact previewed command — parity with Swift's executeWorkload
   * closing the loop. Only called when `fromChat` is set.
   */
  onResult?: (info: { action: ActionBlock; result: ActionResult; commandString: string }) => void;
}

/**
 * ConfirmSheet — shows the EXACT kubectl command that will be executed before
 * running it. Mirrors the Swift `WorkloadConfirmSheet` confirm gate.
 *
 * Usage:
 *   <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
 */
export function ConfirmSheet({ action, open, onClose, onPurge, fromChat, onResult }: ConfirmSheetProps) {
  const [previewCommand, setPreviewCommand] = useState<string[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [applyState, setApplyState] = useState<{ pending: boolean; result?: ActionResult; error?: string }>({ pending: false });
  // proposeRepoFix: two-step diff preview → open PR.
  const [fix, setFix] = useState<{ phase: "diffing" | "preview" | "opening" | "done"; diff?: string; result?: RepoFixResponse; error?: string }>({ phase: "diffing" });

  const { mutate, isPending, isSuccess, isError, error, data, reset } = useAction();

  // Fetch the preview command whenever the action changes
  useEffect(() => {
    if (!action || !open) {
      setPreviewCommand(null);
      setPreviewError(null);
      setApplyState({ pending: false });
      reset();
      return;
    }

    // purge, applyManifest, and proposeRepoFix have no kubectl preview
    if (action.kind === "purge" || action.kind === "applyManifest" || action.kind === "proposeRepoFix") {
      setPreviewCommand(null);
      setPreviewError(null);
      return;
    }

    let cancelled = false;
    setPreviewCommand(null);
    setPreviewError(null);
    fetchPreviewCommand(action)
      .then((cmd) => { if (!cancelled) setPreviewCommand(cmd); })
      .catch((err: Error) => { if (!cancelled) setPreviewError(err.message); });
    return () => { cancelled = true; };
  }, [action, open, reset]);

  async function handleApply() {
    const act = action;
    if (!act?.manifest) return;
    const cmd = act.label ?? "kubectl apply -f -";
    setApplyState({ pending: true });
    try {
      const result = await applyManifestYaml(act.manifest);
      setApplyState({ pending: false, result });
      if (fromChat) onResult?.({ action: act, result, commandString: cmd });
      if (result.code === 0) setTimeout(() => handleClose(), 1200);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setApplyState({ pending: false, error: message });
      if (fromChat) onResult?.({ action: act, result: { code: 1, stdout: "", stderr: message }, commandString: cmd });
    }
  }

  // proposeRepoFix: fetch the git diff preview when the sheet opens.
  useEffect(() => {
    if (!action || !open || action.kind !== "proposeRepoFix") return;
    setFix({ phase: "diffing" });
    let cancelled = false;
    proposeRepoFix(action, true)
      .then((r) => { if (!cancelled) setFix({ phase: "preview", diff: r.diff, error: r.ok ? undefined : r.message }); })
      .catch((e: Error) => { if (!cancelled) setFix({ phase: "preview", error: e.message }); });
    return () => { cancelled = true; };
  }, [action, open]);

  async function handlePropose() {
    const act = action;
    if (!act) return;
    setFix((f) => ({ ...f, phase: "opening" }));
    const label = act.title ?? act.label ?? "Propose fix";
    try {
      const r = await proposeRepoFix(act, false);
      setFix({ phase: "done", result: r, error: r.ok ? undefined : r.message });
      if (fromChat) {
        const result: ActionResult = r.ok
          ? { code: 0, stdout: `Opened pull request: ${r.prUrl}`, stderr: "" }
          : { code: 1, stdout: "", stderr: r.message ?? "failed to open PR" };
        onResult?.({ action: act, result, commandString: label });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setFix({ phase: "done", error: message });
      if (fromChat) onResult?.({ action: act, result: { code: 1, stdout: "", stderr: message }, commandString: label });
    }
  }

  function handleExecute() {
    if (!action) return;
    const act = action;
    const cmd = previewCommand ? previewCommand.join(" ") : (act.label ?? "kubectl");
    mutate(act, {
      onSuccess: (result) => {
        // If the server signals this is a purge, defer to the purge flow
        if ("purge" in result && result.purge) {
          const p = result as PurgeResult;
          onPurge?.(p.name, p.namespace);
          onClose();
          return;
        }
        // Close the loop: hand the result back to the chat session (parity with
        // Swift executeWorkload) so the model knows it ran and can continue.
        if (fromChat) onResult?.({ action: act, result: result as ActionResult, commandString: cmd });
      },
      onError: (err) => {
        // A failed run still closes the loop so the model can diagnose it.
        if (fromChat) {
          const message = err instanceof Error ? err.message : String(err);
          onResult?.({ action: act, result: { code: 1, stdout: "", stderr: message }, commandString: cmd });
        }
      },
    });
  }

  function handleClose() {
    reset();
    setApplyState({ pending: false });
    setFix({ phase: "diffing" });
    onClose();
  }

  const isPurge = action?.kind === "purge";
  const isApply = action?.kind === "applyManifest";
  const isFix = action?.kind === "proposeRepoFix";
  // Destructive treatment follows the shared rule (delete/drain/purge family or
  // the model's `destructive` hint), plus applyManifest which is app-specific.
  // A proposeRepoFix only opens a PR (nothing applied), so it is NOT destructive.
  const isDestructive = (action ? isDestructiveAction(action) : false) || isApply;
  const commandString = previewCommand ? previewCommand.join(" ") : null;

  function handleCopy() {
    if (!commandString) return;
    void navigator.clipboard.writeText(commandString).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  // Auto-close on success for non-purge actions (purge defers to onPurge callback)
  useEffect(() => {
    if (isSuccess && data && !("purge" in data && data.purge)) {
      // Give a moment so the user sees the result, then close
      const t = setTimeout(() => { reset(); onClose(); }, 1200);
      return () => clearTimeout(t);
    }
  }, [isSuccess, data, reset, onClose]);

  // Accent follows risk: destructive actions go red, everything else the
  // brand purple. Header tint, icon chip, command prompt, and the primary
  // button all key off this single color.
  const accentColor = isDestructive ? "var(--status-failed)" : "var(--accent-primary)";
  const HeaderIcon = isFix ? GitPullRequest : isApply ? Layers : isDestructive ? AlertTriangle : Terminal;
  const riskLabel = isDestructive ? "Destructive" : isApply ? "Apply" : isFix ? "Pull request" : "Safe";

  const title = isPurge
    ? "Remove application"
    : isFix
    ? (action?.title ?? action?.label ?? "Propose fix")
    : isApply
    ? (action?.label ?? "Apply manifest")
    : (action?.label ?? "Confirm action");
  const description = isPurge
    ? "Opens the application removal flow. Nothing is deleted until you confirm in the next step."
    : isFix
    ? "Review the change below, then open a pull request. Nothing is applied to the cluster — you merge & sync."
    : isApply
    ? "Review the resources below, then apply them to the cluster."
    : "This is the exact command that will run against your cluster.";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="overflow-hidden p-0 gap-0 sm:max-w-xl"
        style={{ border: `1px solid ${accentColor}40`, boxShadow: "0 24px 60px -20px rgba(0,0,0,0.7), 0 8px 24px rgba(0,0,0,0.6)" }}
      >
        {/* Header — icon chip + title + risk pill over an accent-tinted wash */}
        <DialogHeader
          className="min-w-0 flex-row items-start gap-3.5 px-5 pb-4 pt-5"
          style={{
            background: `linear-gradient(180deg, ${accentColor}1A 0%, transparent 100%)`,
            borderBottom: `1px solid ${accentColor}24`,
          }}
        >
          <div
            className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg"
            style={{ background: `${accentColor}22`, border: `1px solid ${accentColor}45` }}
          >
            <HeaderIcon className="size-[18px]" style={{ color: accentColor }} strokeWidth={2} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <DialogTitle className="text-[15px] leading-snug line-clamp-2 break-words">{title}</DialogTitle>
            <DialogDescription className="text-[13px] leading-relaxed">{description}</DialogDescription>
          </div>
          <span
            className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
            style={{ background: `${accentColor}1F`, color: accentColor, border: `1px solid ${accentColor}3D` }}
          >
            {riskLabel}
          </span>
        </DialogHeader>

        {/* Body */}
        <div className="flex flex-col gap-4 px-5 py-5">

        {/* Apply manifest resource summary */}
        {isApply && action?.manifest && (() => {
          const resources = listResources(action.manifest);
          return (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                Applies <span className="font-semibold text-foreground">{resources.length}</span> resource{resources.length === 1 ? "" : "s"}:
              </p>
              <ul
                className="max-h-60 space-y-0.5 overflow-auto rounded-lg p-1.5 text-xs"
                style={{ background: "#08080A", border: "1px solid #26272B" }}
              >
                {resources.map((r, i) => (
                  <li key={i} className="flex items-center gap-2 rounded-md px-2 py-1.5 font-mono hover:bg-white/[0.03]">
                    <span className="shrink-0 font-semibold" style={{ color: accentColor }}>{r.kind}</span>
                    <span className="truncate text-foreground/90">{r.name || "—"}</span>
                    {r.namespace && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{r.namespace}</span>}
                  </li>
                ))}
              </ul>
              {applyState.error && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{applyState.error}</p>
              )}
              {applyState.result && (applyState.result.code === 0
                ? <p className="flex items-center gap-1.5 text-xs text-emerald-400"><CheckCircle2 className="size-3.5" /> Applied.</p>
                : <pre className="rounded-lg bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap">{applyState.result.stderr || applyState.result.stdout}</pre>
              )}
            </div>
          );
        })()}

        {/* proposeRepoFix — git diff preview + PR result */}
        {isFix && action && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{action.source}</span>
              {" · "}
              <span className="font-mono">{action.filePath}</span>
            </p>
            {fix.phase === "diffing" && <p className="text-xs text-muted-foreground">Cloning repo and computing diff…</p>}
            {fix.error && fix.phase !== "done" && (
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive whitespace-pre-wrap">{fix.error}</p>
            )}
            {(fix.phase === "preview" || fix.phase === "opening") && fix.diff && (
              <pre className="max-h-72 overflow-auto rounded-lg p-3 text-xs font-mono whitespace-pre-wrap" style={{ background: "#08080A", border: "1px solid #26272B" }}>
                {fix.diff}
              </pre>
            )}
            {fix.phase === "done" && (
              fix.result?.ok ? (
                <a href={fix.result.prUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-sm font-medium text-emerald-400 hover:underline">
                  <CheckCircle2 className="size-4" /> Pull request opened <ExternalLink className="size-3.5" />
                </a>
              ) : (
                <pre className="rounded-lg bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap">{fix.error ?? "Failed to open PR."}</pre>
              )
            )}
          </div>
        )}

        {/* Command preview — rendered as a small terminal window */}
        {!isPurge && !isApply && !isFix && (
          previewError ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
              {previewError}
            </p>
          ) : commandString ? (
            <div className="relative overflow-hidden rounded-xl" style={{ background: "#08080A", border: "1px solid #26272B" }}>
              <button
                type="button"
                onClick={handleCopy}
                aria-label={copied ? "Copied" : "Copy command"}
                className="absolute right-2.5 top-2.5 flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
              >
                {copied ? <Check className="size-3" style={{ color: "#28C840" }} /> : <Copy className="size-3" />}
                {copied ? "Copied" : "Copy"}
              </button>
              <pre className="overflow-x-auto px-4 py-3.5 pr-16 font-mono text-[12.5px] leading-6 whitespace-pre-wrap break-all">
                <span className="select-none font-semibold" style={{ color: accentColor }}>$ </span>
                <HighlightedCommand command={commandString} accent={accentColor} />
              </pre>
            </div>
          ) : (
            // Skeleton sized like the command block so the layout doesn't jump.
            <div className="space-y-2 rounded-xl px-4 py-4" style={{ background: "#08080A", border: "1px solid #26272B" }}>
              <div className="h-3 w-4/5 animate-pulse rounded bg-white/10" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-white/[0.07]" />
            </div>
          )
        )}

        {/* Result feedback */}
        {isSuccess && data && !("purge" in data && data.purge) && (
          "code" in data && data.code !== 0 ? (
            <pre className="rounded-lg bg-destructive/10 px-3 py-2.5 text-xs font-mono text-destructive whitespace-pre-wrap">
              {data.stderr || data.stdout}
            </pre>
          ) : (
            <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
              <CheckCircle2 className="size-4" /> Command succeeded.
            </p>
          )
        )}

        {isError && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
            {error.message}
          </p>
        )}

        </div>{/* end body */}

        {/* Footer */}
        <DialogFooter
          className="mx-0 mb-0 border-t px-5 py-4"
          style={{ borderColor: "#1F1F24", background: "#0C0C0F" }}
        >
          <Button variant="outline" onClick={handleClose} disabled={isPending || applyState.pending || fix.phase === "opening"}>
            {isFix && fix.phase === "done" ? "Close" : "Cancel"}
          </Button>
          {!(isFix && fix.phase === "done") && (
            <Button
              className="gap-1.5 font-medium transition-transform active:scale-[0.98]"
              style={{ background: accentColor, color: "var(--fg-primary)", border: "none" }}
              onClick={isFix ? handlePropose : isApply ? handleApply : handleExecute}
              disabled={
                isFix
                  ? fix.phase !== "preview" || !!fix.error
                  : isApply
                  ? applyState.pending
                  : isPending || (!isPurge && !commandString && !previewError)
              }
            >
              {isFix ? (
                fix.phase === "opening" ? "Opening PR…" : <><GitPullRequest className="size-3.5" /> Open PR</>
              ) : isApply ? (
                applyState.pending ? "Applying…" : <><Layers className="size-3.5" /> Apply</>
              ) : isPending ? (
                "Running…"
              ) : isPurge ? (
                <>Continue to removal <ArrowRight className="size-3.5" /></>
              ) : (
                <><Play className="size-3.5 fill-current" /> Execute</>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Renders a shell command with light syntax emphasis: the binary in the accent
 * color, flags dimmed, everything else in the foreground. Whitespace is
 * preserved so the `pre` still wraps/breaks naturally.
 */
function HighlightedCommand({ command, accent }: { command: string; accent: string }) {
  const parts = command.split(/(\s+)/);
  let sawBinary = false;
  return (
    <>
      {parts.map((tok, i) => {
        if (/^\s+$/.test(tok) || tok === "") return <span key={i}>{tok}</span>;
        if (!sawBinary) {
          sawBinary = true;
          return <span key={i} style={{ color: accent }} className="font-medium">{tok}</span>;
        }
        if (tok.startsWith("-")) return <span key={i} className="text-muted-foreground">{tok}</span>;
        return <span key={i} className="text-foreground/90">{tok}</span>;
      })}
    </>
  );
}
