import { Link } from "react-router";
import { useFailoverState } from "@/lib/api";

export function FailoverBanner() {
  const live = useFailoverState();
  const active = live.data?.failedOverTo;
  if (!active) return null;
  return (
    <div className="flex items-center gap-3 border-b border-[var(--status-pending)] bg-[var(--surface-elevated)] px-5 py-2 text-xs">
      <span className="font-semibold text-[var(--fg-primary)]">Failover is active</span>
      <span className="text-[var(--fg-secondary)]">
        Copy running as {active.context}
        {active.lbAddress ? ` at ${active.lbAddress}` : ""}.
      </span>
      <Link to="/failover" className="ml-auto font-bold text-[var(--accent-primary)] hover:underline">
        Open Failover
      </Link>
    </div>
  );
}
