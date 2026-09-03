import { useNavigate } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangleExclamation, faChevronRight } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Button } from "@/components/ui/button";
import { queuedSuggestionId } from "@rigel/k8s";
import type { AssistantQueuedSuggestion } from "@rigel/k8s";
import type { ActionBlock } from "@/lib/api";
import { useAssistantCtx } from "../AssistantContext";
import { Card, Section } from "../components/primitives";

export function NeedsYouTab() {
  const { d, runSuggestion } = useAssistantCtx();
  const navigate = useNavigate();
  const queue = d.clusterState?.queue ?? [];
  const liveCount = d.liveIssues.length;

  return (
    <div className="space-y-3.5">
      {liveCount > 0 && (
        <button
          type="button"
          onClick={() => navigate("/issues")}
          className="flex w-full items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-3 py-2.5 transition-colors hover:border-[var(--border-strong)]"
        >
          <FontAwesomeIcon
            icon={faTriangleExclamation}
            className="size-3.5 shrink-0 text-[var(--status-failed)]"
          />
          <span className="text-sm font-medium text-[var(--fg-primary)]">
            {liveCount} live {liveCount === 1 ? "issue" : "issues"}
          </span>
          <span className="flex-1" />
          <FontAwesomeIcon icon={faChevronRight} className="size-3 text-[var(--fg-tertiary)]" />
        </button>
      )}

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
    </div>
  );
}
