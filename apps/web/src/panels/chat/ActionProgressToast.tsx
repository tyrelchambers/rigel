import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleExclamation, faChevronDown, faChevronUp, faCircleCheck, faSpinner, faXmark } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { toast } from "sonner";
import { onActionEvent } from "@/lib/ws";

interface Props {
  id: string;
  label: string;
  /** sonner toast id — lets the dismiss button close this specific toast. */
  toastId?: string | number;
}

type Status = "running" | "done" | "error";

// Status-tinted chip backgrounds, derived from the app status colors (same
// tints as the Overview .ov-chip-* classes).
const CHIP_BG: Record<Status, string> = {
  running: "var(--accent-dim)",
  done: "rgba(16,185,129,0.13)",
  error: "rgba(239,68,68,0.13)",
};

/**
 * ActionProgressToast — a compact toast card that streams action output lines
 * as they arrive over the WS action-event channel.
 *
 * Header: a tinted status chip (loader / check / alert), the action label, and a
 * status subline ("Running…" / "Done · N lines" / the error message), plus an
 * expand chevron (while there's output) and a dismiss button.
 *
 * Default: expanded while running. Success auto-dismisses (caller, ~4 s); error
 * persists until dismissed. The component only mirrors event state; result
 * reporting is owned by actionRunner's own subscription.
 */
export function ActionProgressToast({ id, label, toastId }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("running");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [expanded, setExpanded] = useState(true);
  const outputRef = useRef<HTMLDivElement>(null);

  // Subscribe to action events for this run id.
  useEffect(() => {
    const unsub = onActionEvent(id, (e) => {
      if (e.type === "action.progress") {
        setLines((prev) => [...prev, e.line]);
      } else if (e.type === "action.done") {
        if (e.code === 0) {
          setStatus("done");
        } else {
          setStatus("error");
          setErrorMsg(`Exited with code ${e.code}`);
        }
      } else if (e.type === "action.error") {
        setStatus("error");
        setErrorMsg(e.message);
      }
    });
    return unsub;
  }, [id]);

  // Auto-scroll to the newest line whenever lines change.
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  const hasOutput = status === "running" || lines.length > 0;

  return (
    <div className="bg-[var(--surface-elevated)] border border-[var(--border-subtle)] rounded-xl p-3.5 shadow-lg min-w-[280px] max-w-sm">
      {/* Header row */}
      <div className="flex items-start gap-2.5">
        {/* Tinted status chip */}
        <div
          className="mt-0.5 flex size-[26px] shrink-0 items-center justify-center rounded-[7px]"
          style={{ background: CHIP_BG[status] }}
        >
          {status === "running" && (
            <FontAwesomeIcon icon={faSpinner} className="animate-spin text-[var(--accent-primary)] size-[15px]" />
          )}
          {status === "done" && <FontAwesomeIcon icon={faCircleCheck} className="text-[var(--status-running)] size-[15px]" />}
          {status === "error" && <FontAwesomeIcon icon={faCircleExclamation} className="text-[var(--status-failed)] size-[15px]" />}
        </div>

        {/* Label + status subline */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-xs font-semibold leading-snug text-[var(--fg-primary)]">
            {label}
          </span>
          {status === "running" && (
            <span className="text-2xs text-[var(--fg-tertiary)]">Running…</span>
          )}
          {status === "done" && (
            <span className="text-2xs text-[var(--fg-tertiary)]">
              Done · {lines.length} line{lines.length !== 1 ? "s" : ""}
            </span>
          )}
          {status === "error" && errorMsg && (
            <span className="break-words font-[var(--font-mono)] text-2xs leading-snug text-red-300">
              {errorMsg}
            </span>
          )}
        </div>

        {/* Actions: expand toggle (when there's output) + dismiss */}
        <div className="mt-0.5 flex shrink-0 items-center gap-2">
          {hasOutput && (
            <button
              type="button"
              aria-label={expanded ? "Collapse output" : "Expand output"}
              onClick={() => setExpanded((v) => !v)}
              className="text-[var(--fg-tertiary)] transition-colors hover:text-[var(--fg-primary)]"
            >
              {expanded ? <FontAwesomeIcon icon={faChevronUp} className="size-[14px]" /> : <FontAwesomeIcon icon={faChevronDown} className="size-[14px]" />}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              if (toastId !== undefined) toast.dismiss(toastId);
            }}
            className="text-[var(--fg-tertiary)] transition-colors hover:text-[var(--fg-primary)]"
          >
            <FontAwesomeIcon icon={faXmark} className="size-[14px]" />
          </button>
        </div>
      </div>

      {/* Streamed output panel */}
      {expanded && hasOutput && (
        <div
          ref={outputRef}
          className="mt-2.5 max-h-48 overflow-y-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2.5 py-2"
        >
          <pre className="whitespace-pre-wrap break-all font-[var(--font-mono)] text-2xs leading-relaxed text-[var(--fg-secondary)]">
            {lines.map((line, i) => (
              <span key={i} className="block">
                {line}
              </span>
            ))}
            {status === "running" && (
              <span className="block">
                <span className="text-[var(--accent-primary)]">█</span>{" "}
                <span className="text-[var(--fg-tertiary)]">streaming…</span>
              </span>
            )}
          </pre>
        </div>
      )}
    </div>
  );
}
