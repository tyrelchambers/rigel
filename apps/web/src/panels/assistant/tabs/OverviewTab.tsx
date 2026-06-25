// OverviewTab — last report, pending-approval banner, recent activity, and the
// owned-resources card.

import { AlertTriangle, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { auditEntryId } from "@rigel/k8s";
import { useAssistantCtx } from "../AssistantContext";
import { Card, Section } from "../components/primitives";
import { AuditRow } from "../AuditRow";
import { OwnedResources } from "../OwnedResources";

export function OverviewTab() {
  const { d, ns, working, run, setTab, openAllActivity } = useAssistantCtx();
  const audit = d.clusterState?.audit ?? [];
  const queue = d.clusterState?.queue ?? [];
  const report = d.clusterState?.report ?? "";

  return (
    <div className="space-y-3.5">
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

      <Section
        title="Recent activity"
        right={
          audit.length > 5 ? (
            <Button variant="ghost" size="sm" onClick={() => setTab("activity")}>
              View all
            </Button>
          ) : undefined
        }
      >
        <Card>
          {audit.length === 0 ? (
            <p className="text-sm text-muted-foreground">No actions yet.</p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-auto">
              {audit.slice(0, 5).map((e) => (
                <AuditRow key={auditEntryId(e)} e={e} />
              ))}
            </div>
          )}
        </Card>
      </Section>

      {!report && queue.length === 0 && audit.length === 0 && (
        <Card>
          <p className="text-sm text-muted-foreground">
            All quiet — the agent is watching and hasn't needed to act.
          </p>
        </Card>
      )}

      <OwnedResources />

      {/* Suppress unused variable warning */}
      {void openAllActivity}
    </div>
  );
}
