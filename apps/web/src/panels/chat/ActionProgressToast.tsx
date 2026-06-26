import { useEffect, useRef, useState } from "react";
import { AlertCircle, ChevronDown, ChevronUp, CircleCheck, LoaderCircle } from "lucide-react";
import { onActionEvent } from "@/lib/ws";

interface Props {
  id: string;
  label: string;
}

type Status = "running" | "done" | "error";

/**
 * ActionProgressToast — a compact inline toast card that streams action output
 * lines as they arrive over the WS action-event channel.
 *
 * States:
 *   running  — spinning loader + label + chevron toggle; output panel when expanded
 *   done     — check icon + label + "Done · N lines" meta
 *   error    — alert icon + label + error message
 *
 * Default: expanded while running (output visible immediately).
 * Success: auto-dismissed by the caller after ~4 s.
 * Error: persists until the user dismisses the toast.
 *
 * The component only updates its own state from events; result reporting (the
 * chat "close the loop" call) is owned by actionRunner's own subscription.
 */
export function ActionProgressToast({ id, label }: Props) {
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

  return (
    <div className="bg-[var(--surface-elevated)] border border-[var(--border-subtle)] rounded-xl p-3.5 shadow-md min-w-[260px] max-w-sm">
      {/* Header row */}
      <div className="flex items-start gap-2">
        {/* Status icon */}
        <div className="mt-0.5 shrink-0">
          {status === "running" && (
            <LoaderCircle
              size={15}
              className="animate-spin text-[var(--accent-primary)]"
            />
          )}
          {status === "done" && (
            <CircleCheck size={15} className="text-[var(--status-running)]" />
          )}
          {status === "error" && (
            <AlertCircle size={15} className="text-[var(--status-failed)]" />
          )}
        </div>

        {/* Label */}
        <span className="flex-1 text-[13px] font-semibold leading-snug text-[var(--fg-primary)]">
          {status === "running" ? `Running: ${label}` : label}
        </span>

        {/* Chevron toggle — only meaningful while running or when there are lines */}
        {(status === "running" || lines.length > 0) && (
          <button
            type="button"
            aria-label={expanded ? "Collapse output" : "Expand output"}
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 mt-0.5 text-[var(--fg-tertiary)] hover:text-[var(--fg-primary)] transition-colors"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>

      {/* Meta line for done state */}
      {status === "done" && (
        <p className="mt-1 ml-[23px] text-[11px] text-[var(--fg-tertiary)]">
          Done · {lines.length} line{lines.length !== 1 ? "s" : ""}
        </p>
      )}

      {/* Error message */}
      {status === "error" && errorMsg && (
        <p className="mt-1 ml-[23px] text-[11px] text-[var(--status-failed)] break-words">
          {errorMsg}
        </p>
      )}

      {/* Streamed output panel */}
      {expanded && (status === "running" || lines.length > 0) && (
        <div
          ref={outputRef}
          className="mt-2 bg-[var(--surface-sunken)] border border-[var(--border-subtle)] rounded-lg px-2.5 py-2 max-h-48 overflow-y-auto"
        >
          <pre className="text-[11px] text-[var(--fg-secondary)] font-[var(--font-mono)] whitespace-pre-wrap break-all leading-relaxed">
            {lines.map((line, i) => (
              <span key={i} className="block">
                {line}
              </span>
            ))}
            {status === "running" && (
              <span className="text-[var(--fg-tertiary)]">█ streaming…</span>
            )}
          </pre>
        </div>
      )}
    </div>
  );
}
