import { toast } from "sonner";
import {
  executeAction,
  type ActionBlock,
  type ActionResult,
} from "@/lib/api";
import { runAction, onActionEvent } from "@/lib/ws";
import { ActionProgressToast } from "@/panels/chat/ActionProgressToast";

export interface BackgroundActionInfo {
  action: ActionBlock;
  result: ActionResult;
  commandString: string;
}

export interface RunBackgroundActionOptions {
  /** The confirmed action to execute. */
  action: ActionBlock;
  /** Human label shown in the toast (e.g. "Drain node k8s-truenas"). */
  label: string;
  /** The exact previewed command, forwarded to the chat result loop. */
  commandString: string;
  /** Set when the action originated from chat, so the result is reported back. */
  fromChat?: boolean;
  /** Fires once the action settles (success OR failure) when `fromChat`. */
  onResult?: (info: BackgroundActionInfo) => void;
}

/**
 * Action kinds that cannot use the streaming WS path (either they have their
 * own bespoke UI flow, or they hit a non-streaming REST endpoint). These stay
 * on the classic executeAction + toast.loading/success/error path.
 */
const REST_ONLY_KINDS = new Set(["purge", "applyManifest", "proposeRepoFix"]);

/**
 * Run a confirmed cluster mutation in the background, surfacing progress in a
 * toast instead of holding a blocking confirm modal open. The caller closes the
 * ConfirmSheet first, so the UI stays usable while the command runs.
 *
 * Streaming path (default): sends an action.run frame over the WS and renders
 * an ActionProgressToast that scrolls live output. Auto-dismisses on success
 * after ~4 s; persists on error.
 *
 * REST path (purge / applyManifest / proposeRepoFix): falls back to the classic
 * executeAction + toast.loading/success/error flow, unchanged from before.
 *
 * The chat "close the loop" behaviour (parity with Swift executeWorkload) is
 * preserved: when `fromChat` is set, `onResult` fires with the result and the
 * exact command on both success and failure.
 */
export function runActionInBackground(opts: RunBackgroundActionOptions): void {
  const { action, label, commandString, fromChat, onResult } = opts;

  const streamed = !REST_ONLY_KINDS.has(action.kind);

  if (streamed) {
    // Generate a unique run id for this action execution.
    const runId = `act-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Wire up the result/error handling BEFORE sending the run frame so we
    // never miss an early event.
    let toastId: string | number | undefined;

    // Subscribe once to close the chat loop and drive toast dismissal.
    const unsub = onActionEvent(runId, (e) => {
      if (e.type === "action.done") {
        unsub();
        const code = e.code;
        const result: ActionResult = { code, stdout: "", stderr: "" };
        if (fromChat) onResult?.({ action, result, commandString });
        if (code === 0) {
          // Auto-dismiss after 4 s on success.
          setTimeout(() => {
            if (toastId !== undefined) toast.dismiss(toastId);
          }, 4000);
        }
        // Error exits (code !== 0) leave the toast up so the user reads it.
      } else if (e.type === "action.error") {
        unsub();
        const result: ActionResult = { code: 1, stdout: "", stderr: e.message };
        if (fromChat) onResult?.({ action, result, commandString });
        // Leave error toast persistent; user must dismiss.
      }
    });

    // Render the live-progress toast (Infinity duration — we drive dismissal above).
    // The toast only reflects state; result reporting is owned by the WS
    // subscription above, so the toast needs no result callback.
    toastId = toast.custom((t) => <ActionProgressToast id={runId} label={label} toastId={t} />, {
      duration: Infinity,
    });

    // Start the action on the server.
    runAction(runId, action);
    return;
  }

  // --- REST path (purge / applyManifest / proposeRepoFix) ---
  const toastId = toast.loading(`Running: ${label}`);

  void executeAction(action)
    .then((response) => {
      // purge defers to a separate in-modal flow and never reaches here; if a
      // purge signal somehow does, treat it as a benign success.
      const result: ActionResult =
        "code" in response ? response : { code: 0, stdout: "", stderr: "" };
      if (fromChat) onResult?.({ action, result, commandString });
      if (result.code === 0) {
        toast.success(label, { id: toastId, description: "Done." });
      } else {
        toast.error(label, {
          id: toastId,
          description: trimErr(result.stderr || result.stdout) || "Command failed.",
        });
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (fromChat)
        onResult?.({
          action,
          result: { code: 1, stdout: "", stderr: message },
          commandString,
        });
      toast.error(label, {
        id: toastId,
        description: trimErr(message) || "Command failed.",
      });
    });
}

/** Collapse a command's stderr/stdout to a single tidy toast description line. */
function trimErr(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > 240 ? `${t.slice(0, 240)}…` : t;
}
