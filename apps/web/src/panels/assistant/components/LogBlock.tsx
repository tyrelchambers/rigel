import { useState } from "react";
import { Check, ChevronDown, Copy, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Colour a log line by a light heuristic (errors red, stack frames dimmed). */
function lineClass(l: string): string {
  if (/error|fatal|panic|exception|fail/i.test(l)) return "text-[var(--status-failed)]";
  if (/^\s*at\s|node_modules|\.[jt]s:\d/.test(l)) return "text-[var(--fg-tertiary)]";
  return "text-[var(--fg-secondary)]";
}

const LOG_CAP = 6;

/** A terminal-styled log/detail viewer (Pencil "log" component): a labelled
 *  header with copy, colour-coded lines with a bottom fade, and a show-full-log
 *  expander when the content spans more than a handful of lines. */
export function LogBlock({ label, detail }: { label: string; detail: string }) {
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = detail.split("\n");
  const overflow = lines.length > LOG_CAP;
  const shown = full || !overflow ? lines : lines.slice(0, LOG_CAP);

  function copy() {
    void navigator.clipboard?.writeText(detail);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.05] bg-white/[0.02] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="size-1.5 shrink-0 rounded-full bg-[var(--status-failed)]" aria-hidden />
          <span className="truncate font-mono text-3xs uppercase tracking-wider text-[var(--fg-tertiary)]">
            {label}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {overflow && (
            <button
              type="button"
              onClick={() => setFull((v) => !v)}
              aria-label={full ? "Collapse log" : "Expand log"}
              className="text-[var(--fg-tertiary)] transition-colors hover:text-[var(--fg-secondary)]"
            >
              <Maximize2 className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={copy}
            aria-label="Copy log"
            className="text-[var(--fg-tertiary)] transition-colors hover:text-[var(--fg-secondary)]"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        </div>
      </div>
      <div className={cn("relative overflow-auto px-3.5 py-2.5", full ? "max-h-72" : "max-h-40")}>
        <div className="select-text font-mono text-2xs leading-relaxed">
          {shown.map((l, i) => (
            <div key={i} className={cn("whitespace-pre-wrap break-words", lineClass(l))}>
              {l || " "}
            </div>
          ))}
        </div>
        {overflow && !full && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-[var(--surface-sunken)]"
            aria-hidden
          />
        )}
      </div>
      {overflow && (
        <button
          type="button"
          onClick={() => setFull((v) => !v)}
          className="flex w-full items-center justify-between border-t border-white/[0.05] bg-white/[0.02] px-3 py-2 text-left"
        >
          <span className="font-mono text-3xs text-[var(--fg-tertiary)]">
            {full ? `${lines.length} lines` : `${shown.length} of ${lines.length} lines`}
          </span>
          <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--fg-secondary)]">
            {full ? "Show less" : "Show full log"}
            <ChevronDown className={cn("size-3.5 transition-transform", full && "rotate-180")} />
          </span>
        </button>
      )}
    </div>
  );
}
