import { toast } from "sonner";
import {
  executeAction,
  type ActionBlock,
  type ActionResult,
} from "@/lib/api";

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
 * Run a confirmed cluster mutation in the background, surfacing progress in a
 * toast instead of holding a blocking confirm modal open. The caller closes the
 * ConfirmSheet first, so the UI stays usable while the command runs.
 *
 * The chat "close the loop" behaviour (parity with Swift executeWorkload) is
 * preserved: when `fromChat` is set, `onResult` fires with the result and the
 * exact command on both success and failure.
 */
export function runActionInBackground(opts: RunBackgroundActionOptions): void {
  const { action, label, commandString, fromChat, onResult } = opts;
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
