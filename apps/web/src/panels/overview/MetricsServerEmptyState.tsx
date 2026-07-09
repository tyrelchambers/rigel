import { Button } from "@/components/ui/button";
import { useInstallMetricsServer } from "@/lib/api";

/**
 * Empty state for the Node overview when metrics-server isn't installed. Live
 * node CPU/memory comes from `kubectl top` (the metrics.k8s.io API), which
 * returns nothing until metrics-server is deployed — so offer the one-click
 * install right here instead of only describing the problem. On success the
 * metrics query is invalidated and the table replaces this on its next refetch.
 */
export function MetricsServerEmptyState() {
  const install = useInstallMetricsServer();
  return (
    <div className="flex flex-col items-center justify-center gap-3.5 px-[18px] py-8 text-center">
      <div className="h-0.5 w-7 rounded-[1px] bg-[var(--border-strong)]" />
      <span className="text-xs leading-relaxed text-[var(--fg-tertiary)]">
        metrics-server isn't installed — install it to see live node CPU and memory.
      </span>
      <Button
        variant="subtle"
        size="sm"
        disabled={install.isPending || install.isSuccess}
        onClick={() => install.mutate()}
      >
        {install.isPending ? "Installing…" : install.isSuccess ? "Installed" : "Install metrics-server"}
      </Button>
      {install.isError && (
        <span className="text-2xs text-[var(--status-failed)]">{install.error.message}</span>
      )}
    </div>
  );
}
