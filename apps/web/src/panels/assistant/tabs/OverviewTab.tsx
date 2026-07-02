// OverviewTab — contextual banners (last report, pending approvals, open PRs),
// the Recent-activity section (rich "all quiet" empty state or the latest audit
// rows), and the owned-resources grid. Built to Pencil frame
// "Assistant — Overview (improved)".

import { AlertTriangle, ChevronRight, GitPullRequest, Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { auditEntryId } from "@rigel/k8s";
import { useAssistantCtx } from "../AssistantContext";
import { Card } from "../components/primitives";
import { relativeTime } from "../display";
import { AuditRow } from "../AuditRow";
import { OwnedResources } from "../OwnedResources";

export function OverviewTab() {
  const { d, ns, working, run, setTab } = useAssistantCtx();
  const audit = d.clusterState?.audit ?? [];
  const queue = d.clusterState?.queue ?? [];
  const report = d.clusterState?.report ?? "";
  const prCount = d.pullRequests.length;

  return (
    <div className="space-y-5">
      {report && (
        <Card>
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Last report</p>
            <Button
              variant="ghost"
              size="sm"
              disabled={working}
              onClick={() => run({ action: "clearReport", namespace: ns })}
            >
              Clear
            </Button>
          </div>
          <p className="mt-1 select-text text-sm text-muted-foreground whitespace-pre-wrap">
            {report}
          </p>
        </Card>
      )}

      {queue.length > 0 && (
        <button
          type="button"
          onClick={() => setTab("needs")}
          className="flex w-full items-center gap-2 rounded-lg border bg-card p-3 text-left hover:bg-muted/50"
        >
          <AlertTriangle className="size-4 text-amber-500" />
          <span className="text-sm font-medium">
            {queue.length} fix{queue.length === 1 ? "" : "es"} awaiting your approval
          </span>
          <ChevronRight className="ml-auto size-4 text-muted-foreground" />
        </button>
      )}

      {prCount > 0 && (
        <button
          type="button"
          onClick={() => setTab("autofix")}
          className="flex w-full items-center gap-2 rounded-lg border bg-card p-3 text-left hover:bg-muted/50"
        >
          <GitPullRequest className="size-4 text-[var(--status-running)]" />
          <span className="text-sm font-medium">
            Agent opened {prCount} pull request{prCount === 1 ? "" : "s"}
          </span>
          <ChevronRight className="ml-auto size-4 text-muted-foreground" />
        </button>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-[var(--fg-primary)]">Recent activity</h3>
          <button
            type="button"
            onClick={() => setTab("activity")}
            className="text-xs font-semibold text-[var(--accent-primary)] hover:underline"
          >
            View all in Activity →
          </button>
        </div>

        {audit.length === 0 ? (
          <RecentActivityEmpty updatedAt={d.clusterState?.updatedAt} />
        ) : (
          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3">
            <div className="max-h-80 space-y-2 overflow-auto">
              {audit.slice(0, 5).map((e) => (
                <AuditRow key={auditEntryId(e)} e={e} />
              ))}
            </div>
          </div>
        )}
      </section>

      <OwnedResources />
    </div>
  );
}

/** The "all quiet" empty state — a radar glyph and a reassuring line, shown when
 *  the agent has watched without needing to act. */
function RecentActivityEmpty({ updatedAt }: { updatedAt?: string }) {
  const rel = updatedAt ? relativeTime(updatedAt) : "";
  const checked = !updatedAt || rel === "" || rel === "0s" ? "just now" : `${rel} ago`;
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-6 py-8 text-center">
      <div className="flex size-[46px] items-center justify-center rounded-full bg-[rgba(16,185,129,0.09)]">
        <Radar className="size-[22px] text-[var(--status-running)]" />
      </div>
      <p className="text-base font-semibold text-[var(--fg-primary)]">All quiet</p>
      <p className="text-[13px] text-[var(--fg-secondary)]">
        The agent is watching and hasn't needed to act.
      </p>
      <p className="font-mono text-[11px] tracking-[0.03em] text-[var(--fg-tertiary)]">
        Checked {checked} · 0 actions today
      </p>
    </div>
  );
}
