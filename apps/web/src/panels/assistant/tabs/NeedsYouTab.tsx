// NeedsYouTab — queued suggestions + live cluster issues.

import { AlertTriangle, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { queuedSuggestionId } from "@helmsman/k8s";
import type { AssistantQueuedSuggestion } from "@helmsman/k8s";
import type { ActionBlock } from "@/lib/api";
import { useAssistantCtx } from "../AssistantContext";
import { Card, Section } from "../components/primitives";

export function NeedsYouTab() {
  const { d, ns, working, run, runSuggestion } = useAssistantCtx();
  const queue = d.clusterState?.queue ?? [];

  return (
    <div className="space-y-3.5">
      {queue.length > 0 && (
        <Section title={`Awaiting your approval (${queue.length})`}>
          {queue.map((q: AssistantQueuedSuggestion) => (
            <Card key={queuedSuggestionId(q)} className="space-y-1.5">
              <p className="font-mono text-sm font-medium">{q.incident}</p>
              <p className="text-sm">{q.suggestion}</p>
              <p className="text-xs text-muted-foreground">{q.reason}</p>
              {q.action && (
                <Button size="sm" onClick={() => runSuggestion(q.action as ActionBlock)}>
                  {q.action.label}
                </Button>
              )}
            </Card>
          ))}
        </Section>
      )}

      <Section title={`Live cluster issues (${d.liveIssues.length})`}>
        {d.liveIssues.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Cluster is clean — nothing to remediate.
          </p>
        ) : (
          d.liveIssues.map((issue) => (
            <Card key={issue.fingerprint}>
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />
                <span className="truncate font-mono text-sm font-medium">{issue.location}</span>
                <span className="ml-auto font-mono text-xs text-amber-600 dark:text-amber-400">
                  {issue.reason}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Silence this incident (agent stops acting on it)"
                  disabled={working}
                  onClick={() =>
                    run({ action: "silence", namespace: ns, fingerprint: issue.fingerprint })
                  }
                >
                  <BellOff className="size-3.5 text-muted-foreground" />
                </Button>
              </div>
            </Card>
          ))
        )}
      </Section>
    </div>
  );
}
