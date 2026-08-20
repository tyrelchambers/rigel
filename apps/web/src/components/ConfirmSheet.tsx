import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faTerminal,
  faCopy,
  faCheck,
  faTriangleExclamation,
  faLayerGroup,
  faPlay,
  faArrowRight,
  faCircleCheck,
  faCodePullRequest,
  faArrowUpRightFromSquare,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import {
  fetchPreviewCommand,
  useAction,
  applyManifestYaml,
  proposeRepoFix,
  useContexts,
  type ActionBlock,
  type ActionResult,
  type PurgeResult,
  type RepoFixResponse,
} from "@/lib/api";
import { listResources } from "@rigel/catalog";
import { isDestructiveAction } from "@/lib/actionBlocks";
import { CommandBlock } from "@/components/CommandBlock";
import { runActionInBackground } from "@/lib/actionRunner";
import { DiffView } from "@/components/DiffView";
import { useCluster } from "@/store/cluster";
import { classifyProvider } from "@/shell/clusterTile";
import { resolveIconId, loadIconOverrides } from "@/shell/clusterIconStore";
import { ClusterIcon } from "@/shell/clusterIcons";

interface ConfirmSheetProps {
  /** The action to confirm and optionally execute. */
  action: ActionBlock | null;
  /** Optional caution shown above the command — e.g. a major-version upgrade
   *  warning. Advisory only; it never blocks the action. */
  notice?: string | null;
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
  onResult?: (info: {
    action: ActionBlock;
    result: ActionResult;
    commandString: string;
  }) => void;
}

/**
 * ConfirmSheet — shows the EXACT kubectl command that will be executed before
 * running it. Mirrors the Swift `WorkloadConfirmSheet` confirm gate.
 *
 * Usage:
 *   <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
 */
export function ConfirmSheet({
  action,
  notice,
  open,
  onClose,
  onPurge,
  fromChat,
  onResult,
}: ConfirmSheetProps) {
  const [previewCommand, setPreviewCommand] = useState<string[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [applyState, setApplyState] = useState<{
    pending: boolean;
    result?: ActionResult;
    error?: string;
  }>({ pending: false });
  // proposeRepoFix: two-step diff preview → open PR.
  const [fix, setFix] = useState<{
    phase: "diffing" | "preview" | "opening" | "done";
    diff?: string;
    result?: RepoFixResponse;
    error?: string;
  }>({ phase: "diffing" });

  const { mutate, isPending, isSuccess, isError, error, data, reset } =
    useAction();

  // The active cluster context is the real execution target now that REST
  // follows the rail (X-Rigel-Context) — shown so the user knows exactly
  // where this action will run.
  const activeContext = useCluster((s) => s.activeContext);
  const { data: contexts } = useContexts();
  const activeContextObj = contexts?.find((c) => c.name === activeContext);
  const clusterProvider = classifyProvider(
    activeContextObj ?? { name: activeContext ?? "", server: "" },
  );
  const clusterIconId = resolveIconId(
    activeContext ?? "",
    clusterProvider,
    loadIconOverrides(),
  );

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
    if (
      action.kind === "purge" ||
      action.kind === "applyManifest" ||
      action.kind === "proposeRepoFix"
    ) {
      setPreviewCommand(null);
      setPreviewError(null);
      return;
    }

    let cancelled = false;
    setPreviewCommand(null);
    setPreviewError(null);
    fetchPreviewCommand(action)
      .then((cmd) => {
        if (!cancelled) setPreviewCommand(cmd);
      })
      .catch((err: Error) => {
        if (!cancelled) setPreviewError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [action, open, reset]);

  async function handleApply() {
    const act = action;
    if (!act?.manifest) return;
    const cmd = act.label ?? "kubectl apply -f -";
    setApplyState({ pending: true });
    try {
      const result = await applyManifestYaml(act.manifest, false, act.applySource);
      setApplyState({ pending: false, result });
      if (fromChat) onResult?.({ action: act, result, commandString: cmd });
      if (result.code === 0) setTimeout(() => handleClose(), 1200);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setApplyState({ pending: false, error: message });
      if (fromChat)
        onResult?.({
          action: act,
          result: { code: 1, stdout: "", stderr: message },
          commandString: cmd,
        });
    }
  }

  // proposeRepoFix: fetch the git diff preview when the sheet opens.
  useEffect(() => {
    if (!action || !open || action.kind !== "proposeRepoFix") return;
    setFix({ phase: "diffing" });
    let cancelled = false;
    proposeRepoFix(action, true)
      .then((r) => {
        if (!cancelled)
          setFix({
            phase: "preview",
            diff: r.diff,
            error: r.ok ? undefined : r.message,
          });
      })
      .catch((e: Error) => {
        if (!cancelled) setFix({ phase: "preview", error: e.message });
      });
    return () => {
      cancelled = true;
    };
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
      if (fromChat)
        onResult?.({
          action: act,
          result: { code: 1, stdout: "", stderr: message },
          commandString: label,
        });
    }
  }

  function handleExecute() {
    if (!action) return;
    const act = action;
    const cmd = previewCommand
      ? previewCommand.join(" ")
      : (act.label ?? "kubectl");

    // Purge is a quick discovery step that opens the typed-name removal sheet,
    // so it stays in-modal: run it through the mutation and defer to onPurge.
    if (act.kind === "purge") {
      mutate(act, {
        onSuccess: (result) => {
          if ("purge" in result && result.purge) {
            const p = result as PurgeResult;
            onPurge?.(p.name, p.namespace);
            onClose();
          }
        },
      });
      return;
    }

    // Real cluster mutations run in the background: close the confirm modal
    // immediately so the UI isn't locked behind a blocking dialog, and surface
    // progress in a toast. The chat result loop (parity with Swift
    // executeWorkload) is preserved via onResult inside the runner.
    handleClose();
    runActionInBackground({
      action: act,
      label: act.label ?? "Confirm action",
      commandString: cmd,
      fromChat,
      onResult,
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
  // Destructive treatment is reserved for actions that REMOVE or evict a
  // resource: the delete/drain/purge family, or anything the model explicitly
  // flags `destructive` (e.g. a scale-down). Additive applies (install/create)
  // and in-place patches are not destructive — they take the neutral brand
  // treatment via the isApply / default branches below. A proposeRepoFix only
  // opens a PR (nothing applied), so it is NOT destructive either.
  const isDestructive = action ? isDestructiveAction(action) : false;
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
      const t = setTimeout(() => {
        reset();
        onClose();
      }, 1200);
      return () => clearTimeout(t);
    }
  }, [isSuccess, data, reset, onClose]);

  // Accent follows risk: destructive actions go red, everything else the
  // brand purple. Header tint, icon chip, command prompt, and the primary
  // button all key off this single color.
  const accentColor = isDestructive
    ? "var(--status-failed)"
    : "var(--accent-primary)";
  const HeaderIcon = isFix
    ? faCodePullRequest
    : isApply
      ? faLayerGroup
      : isDestructive
        ? faTriangleExclamation
        : faTerminal;
  const riskLabel = isDestructive
    ? "Destructive"
    : isApply
      ? "Apply"
      : isFix
        ? "Pull request"
        : "Safe";

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
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) handleClose();
      }}
    >
      <DialogContent
        className="max-w-3xl"
        style={{
          border: `1px solid ${accentColor}40`,
          boxShadow:
            "0 24px 60px -20px rgba(0,0,0,0.7), 0 8px 24px rgba(0,0,0,0.6)",
        }}
      >
        {/* Header — icon chip + title + risk pill over an accent-tinted wash.
            No close X here — the sheet is intentionally dismissed only via
            Cancel/backdrop/escape, matching the prior showCloseButton={false}. */}
        <DialogHeader
          showClose={false}
          className="items-start gap-3.5 px-5 pb-4 pt-5"
          style={{
            background: `linear-gradient(180deg, ${accentColor}1A 0%, transparent 100%)`,
            borderBottom: `1px solid ${accentColor}24`,
          }}
        >
          <div
            className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg"
            style={{
              background: `${accentColor}22`,
              border: `1px solid ${accentColor}45`,
            }}
          >
            <FontAwesomeIcon
              icon={HeaderIcon}
              className="size-[18px]"
              style={{ color: accentColor }}
            />
          </div>
          <DialogTitle className="min-w-0 flex-1 text-base leading-snug line-clamp-2 break-words">
            {title}
          </DialogTitle>
          <span
            className="shrink-0 rounded-full px-2 py-0.5 text-3xs font-semibold uppercase tracking-wider"
            style={{
              background: `${accentColor}1F`,
              color: accentColor,
              border: `1px solid ${accentColor}3D`,
            }}
          >
            {riskLabel}
          </span>
        </DialogHeader>

        {/* Body */}
        <DialogBody className="flex flex-col gap-4">
          <DialogDescription className="text-xs leading-relaxed">
            {description}
          </DialogDescription>

          {notice && (
            <p
              role="alert"
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-500"
            >
              {notice}
            </p>
          )}

          {/* Target cluster — the active rail context, which REST actually
              executes against via X-Rigel-Context. */}
          {activeContext && (
            <div className="flex items-center gap-2">
              <span className="text-2xs text-muted-foreground">Runs on</span>
              <span
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-foreground/90"
                style={{ background: "#08080A", border: "1px solid #26272B" }}
              >
                <ClusterIcon id={clusterIconId} className="size-[13px]" />
                {activeContext}
              </span>
            </div>
          )}

          {/* Apply manifest resource summary */}
          {isApply &&
            action?.manifest &&
            (() => {
              const resources = listResources(action.manifest);
              return (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">
                    Applies{" "}
                    <span className="font-semibold text-foreground">
                      {resources.length}
                    </span>{" "}
                    resource{resources.length === 1 ? "" : "s"}:
                  </p>
                  <ul
                    className="max-h-60 space-y-0.5 overflow-auto rounded-lg p-1.5 text-xs"
                    style={{
                      background: "#08080A",
                      border: "1px solid #26272B",
                    }}
                  >
                    {resources.map((r, i) => (
                      <li
                        key={i}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 font-mono hover:bg-white/[0.03]"
                      >
                        <span
                          className="shrink-0 font-semibold"
                          style={{ color: accentColor }}
                        >
                          {r.kind}
                        </span>
                        <span className="truncate text-foreground/90">
                          {r.name || "—"}
                        </span>
                        {r.namespace && (
                          <span className="ml-auto shrink-0 text-3xs text-muted-foreground">
                            {r.namespace}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {applyState.error && (
                    <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {applyState.error}
                    </p>
                  )}
                  {applyState.result &&
                    (applyState.result.code === 0 ? (
                      <p className="flex items-center gap-1.5 text-xs text-emerald-400">
                        <FontAwesomeIcon icon={faCircleCheck} className="size-3.5" /> Applied.
                      </p>
                    ) : (
                      <pre className="rounded-lg bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap">
                        {applyState.result.stderr || applyState.result.stdout}
                      </pre>
                    ))}
                </div>
              );
            })()}

          {/* proposeRepoFix — git diff preview + PR result */}
          {isFix && action && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">
                  {action.source}
                </span>
                {" · "}
                <span className="font-mono">{action.filePath}</span>
              </p>
              {fix.phase === "diffing" && (
                <p className="text-xs text-muted-foreground">
                  Cloning repo and computing diff…
                </p>
              )}
              {fix.error && fix.phase !== "done" && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive whitespace-pre-wrap">
                  {fix.error}
                </p>
              )}
              {(fix.phase === "preview" || fix.phase === "opening") &&
                fix.diff && <DiffView diff={fix.diff} />}
              {fix.phase === "done" &&
                (fix.result?.ok ? (
                  <a
                    href={fix.result.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 text-sm font-medium text-emerald-400 hover:underline"
                  >
                    <FontAwesomeIcon icon={faCircleCheck} className="size-4" /> Pull request opened{" "}
                    <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="size-3.5" />
                  </a>
                ) : (
                  <pre className="rounded-lg bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap">
                    {fix.error ?? "Failed to open PR."}
                  </pre>
                ))}
            </div>
          )}

          {/* Command preview — rendered as a small terminal window */}
          {!isPurge &&
            !isApply &&
            !isFix &&
            (previewError ? (
              <p className="rounded-lg bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
                {previewError}
              </p>
            ) : commandString ? (
              <CommandBlock
                command={commandString}
                accent={accentColor}
                trailing={
                  <button
                    type="button"
                    onClick={handleCopy}
                    aria-label={copied ? "Copied" : "Copy command"}
                    className="absolute right-2.5 top-2.5 z-10 flex items-center gap-1 rounded-md px-2 py-1 text-3xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
                  >
                    {copied ? (
                      <FontAwesomeIcon icon={faCheck} className="size-3" style={{ color: "#28C840" }} />
                    ) : (
                      <FontAwesomeIcon icon={faCopy} className="size-3" />
                    )}
                    {copied ? "Copied" : "Copy"}
                  </button>
                }
              />
            ) : (
              // Skeleton sized like the command block so the layout doesn't jump.
              <div
                className="space-y-2 rounded-xl px-4 py-4"
                style={{ background: "#08080A", border: "1px solid #26272B" }}
              >
                <div className="h-3 w-4/5 animate-pulse rounded bg-white/10" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-white/[0.07]" />
              </div>
            ))}

          {/* Result feedback */}
          {isSuccess &&
            data &&
            !("purge" in data && data.purge) &&
            ("code" in data && data.code !== 0 ? (
              <pre className="rounded-lg bg-destructive/10 px-3 py-2.5 text-xs font-mono text-destructive whitespace-pre-wrap">
                {data.stderr || data.stdout}
              </pre>
            ) : (
              <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                <FontAwesomeIcon icon={faCircleCheck} className="size-4" /> Command succeeded.
              </p>
            ))}

          {isError && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
              {error.message}
            </p>
          )}
        </DialogBody>

        {/* Footer */}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={
              isPending || applyState.pending || fix.phase === "opening"
            }
          >
            {isFix && fix.phase === "done" ? "Close" : "Cancel"}
          </Button>
          {!(isFix && fix.phase === "done") && (
            <Button
              variant={isDestructive ? "destructive" : "default"}
              className="transition-transform active:scale-[0.98]"
              onClick={
                isFix ? handlePropose : isApply ? handleApply : handleExecute
              }
              disabled={
                isFix
                  ? fix.phase !== "preview" || !!fix.error
                  : isApply
                    ? applyState.pending
                    : isPending || (!isPurge && !commandString && !previewError)
              }
            >
              {isFix ? (
                fix.phase === "opening" ? (
                  "Opening PR…"
                ) : (
                  <>
                    <FontAwesomeIcon icon={faCodePullRequest} className="size-3.5" /> Open PR
                  </>
                )
              ) : isApply ? (
                applyState.pending ? (
                  "Applying…"
                ) : (
                  <>
                    <FontAwesomeIcon icon={faLayerGroup} className="size-3.5" /> Apply
                  </>
                )
              ) : isPending ? (
                "Running…"
              ) : isPurge ? (
                <>
                  Continue to removal <FontAwesomeIcon icon={faArrowRight} className="size-3.5" />
                </>
              ) : (
                <>
                  <FontAwesomeIcon icon={faPlay} className="size-3.5 fill-current" /> Execute
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

