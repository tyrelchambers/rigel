// ActivityTab — the assistant's activity feed.
// Built to Pencil frame "Assistant — Activity (improved)": a header row
// ("Activity" + count, "See all" / "Clear all") above a list of rich cards.

import { useEffect, useRef, useState } from "react";
import { auditEntryId } from "@rigel/k8s";
import { cn } from "@/lib/utils";
import { useAssistantCtx } from "../AssistantContext";
import { ActivityCard } from "../ActivityCard";

export function ActivityTab() {
  const { d, openAllActivity, run, ns, working } = useAssistantCtx();
  const audit = d.clusterState?.audit ?? [];

  // Two-step inline confirm: first click arms, second click within a few seconds
  // clears. Arms revert on timeout or once the list is empty.
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (audit.length === 0 && confirming) setConfirming(false);
  }, [audit.length, confirming]);

  function disarm() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setConfirming(false);
  }

  function onClear() {
    if (!confirming) {
      setConfirming(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setConfirming(false), 4000);
      return;
    }
    disarm();
    run({ action: "clearActivity", namespace: ns });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Activity header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-[var(--fg-primary)]">Activity</span>
          <span className="font-mono text-xs text-[var(--fg-tertiary)]">{audit.length}</span>
        </div>
        <div className="flex items-center gap-4">
          {audit.length > 10 && (
            <button
              type="button"
              onClick={openAllActivity}
              className="text-xs font-medium text-[var(--accent-primary)] hover:underline"
            >
              See all
            </button>
          )}
          <button
            type="button"
            disabled={working || audit.length === 0}
            onClick={onClear}
            className={cn(
              "text-xs transition-colors disabled:opacity-40",
              confirming
                ? "font-semibold text-red-500"
                : "text-[var(--fg-tertiary)] hover:text-[var(--fg-secondary)]",
            )}
          >
            {confirming ? "Confirm clear" : "Clear all"}
          </button>
        </div>
      </div>

      {/* List */}
      {audit.length === 0 ? (
        <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-6 py-8 text-center">
          <p className="text-sm text-[var(--fg-tertiary)]">No activity yet.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {audit.slice(0, 10).map((e) => (
            <ActivityCard key={auditEntryId(e)} e={e} />
          ))}
        </div>
      )}
    </div>
  );
}
