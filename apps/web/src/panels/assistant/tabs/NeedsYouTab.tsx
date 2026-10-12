import { useState } from "react";
import { useNavigate } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faTriangleExclamation,
  faChevronRight,
  faCodePullRequest,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogIcon,
  DialogTitle,
} from "@/components/ui/dialog";
import { queuedSuggestionId } from "@rigel/k8s";
import type { AssistantQueuedSuggestion } from "@rigel/k8s";
import type { ActionBlock } from "@/lib/api";
import { useAssistantCtx } from "../AssistantContext";
import { Card, Section } from "../components/primitives";

export function NeedsYouTab() {
  const { d, ns, working, run, runSuggestion } = useAssistantCtx();
  const navigate = useNavigate();
  const queue = d.clusterState?.queue ?? [];
  const liveCount = d.liveIssues.length;
  const [pendingFix, setPendingFix] = useState<AssistantQueuedSuggestion | null>(null);
  const fix = pendingFix?.action;

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
                <Button
                  size="sm"
                  onClick={() =>
                    q.action?.kind === "openFixPR"
                      ? setPendingFix(q)
                      : runSuggestion(q.action as ActionBlock)
                  }
                >
                  {q.action.label}
                </Button>
              )}
            </Card>
          ))}
        </Section>
      )}

      <Dialog open={!!pendingFix} onOpenChange={(o) => !o && setPendingFix(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogIcon>
              <FontAwesomeIcon icon={faCodePullRequest} className="size-3.5" />
            </DialogIcon>
            <DialogTitle>Open this fix PR?</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <DialogDescription>
              Rigel opens this pull request against the workload's repo the next time it checks in.
            </DialogDescription>
            <div className="space-y-1">
              <p className="text-xs text-[var(--fg-tertiary)]">Title</p>
              <p className="text-sm font-medium text-[var(--fg-primary)]">{fix?.title || fix?.label}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-[var(--fg-tertiary)]">File</p>
              <p className="select-text font-mono text-xs text-[var(--fg-primary)]">{fix?.filePath}</p>
            </div>
            {fix?.body && (
              <div className="space-y-1">
                <p className="text-xs text-[var(--fg-tertiary)]">Description</p>
                <pre className="max-h-72 select-text overflow-auto rounded-md bg-[var(--surface-sunken)] p-2 font-mono text-2xs whitespace-pre-wrap text-[var(--fg-secondary)]">
                  {fix.body}
                </pre>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingFix(null)}>
              Cancel
            </Button>
            <Button
              disabled={working}
              onClick={() => {
                if (!pendingFix) return;
                run({
                  action: "approveQueuedFix",
                  namespace: ns,
                  queuedId: queuedSuggestionId(pendingFix),
                  fingerprint: pendingFix.fingerprint,
                });
                setPendingFix(null);
              }}
            >
              <FontAwesomeIcon icon={faCodePullRequest} className="size-3.5" /> Open fix PR
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
