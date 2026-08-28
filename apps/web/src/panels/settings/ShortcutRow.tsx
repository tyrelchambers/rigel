import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { formatShortcut, type ShortcutSpec } from "@/lib/platform";
import type { CommandDef } from "@/lib/shortcuts/registry";

export function ShortcutRow({
  command,
  spec,
  overridden,
  recording,
  problem,
  onRecord,
  onCapture,
  onCancel,
  onReset,
}: {
  command: CommandDef;
  spec: ShortcutSpec | null;
  overridden: boolean;
  recording: boolean;
  problem: string | null;
  onRecord: () => void;
  onCapture: (e: KeyboardEvent) => void;
  onCancel: () => void;
  onReset: () => void;
}) {
  useEffect(() => {
    if (!recording) return;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      onCapture(e);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onCapture, onCancel]);

  return (
    <div className="flex flex-col border-b border-[var(--border-subtle)]">
      <div className="flex items-center gap-2 py-2.5">
        <span className="text-sm text-[var(--fg-primary)]">{command.label}</span>
        <div className="flex-1" />
        {recording ? (
          <span className="text-2xs font-semibold text-[var(--accent-soft)]">
            Press a key combination, Escape to cancel
          </span>
        ) : spec ? (
          <kbd className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-1.5 py-1 font-mono text-2xs font-semibold tracking-wide text-[var(--fg-secondary)]">
            {formatShortcut(spec)}
          </kbd>
        ) : (
          <span className="text-2xs font-semibold text-[var(--fg-tertiary)]">Not bound</span>
        )}
        <Button variant="outline" size="sm" aria-label={`Record ${command.label}`} onClick={onRecord}>
          Record
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Reset ${command.label}`}
          disabled={!overridden}
          onClick={onReset}
        >
          Reset
        </Button>
      </div>
      {problem && (
        <span className="pb-2.5 text-2xs font-semibold text-[var(--status-pending)]">{problem}</span>
      )}
    </div>
  );
}
