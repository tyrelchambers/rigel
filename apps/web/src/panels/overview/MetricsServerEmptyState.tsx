import { Button } from "@/components/ui/button";
import { useInstallMetricsServer } from "@/lib/api";

/**
 * Node-overview empty state. When metrics-server is installed but hasn't reported
 * node data yet (`available`), show a neutral waiting note; otherwise offer a
 * one-click install (live CPU/mem needs metrics-server).
 */
export function MetricsServerEmptyState({ available }: { available: boolean }) {
  const install = useInstallMetricsServer();
  if (available) {
    return (
      <div className="flex flex-col items-center justify-center gap-3.5 px-[18px] py-8 text-center">
        <div className="h-0.5 w-7 rounded-[1px] bg-[var(--border-strong)]" />
        <span className="text-xs leading-relaxed text-[var(--fg-tertiary)]">
          Waiting for node metrics — metrics-server is installed but hasn't reported node data yet.
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-3.5 px-[18px] py-8 text-center">
      <div className="h-0.5 w-7 rounded-[1px] bg-[var(--border-strong)]" />
      <span className="text-xs leading-relaxed text-[var(--fg-tertiary)]">
        Live node metrics aren't available — install metrics-server to see CPU and memory.
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
        <span role="alert" className="text-2xs text-[var(--status-failed)]">{install.error.message}</span>
      )}
    </div>
  );
}
