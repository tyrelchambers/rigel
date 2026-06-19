// NeedsYouTab — queued suggestions + live cluster issues.

import { useNavigate } from "react-router";
import { AlertTriangle, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { queuedSuggestionId } from "@helmsman/k8s";
import type { AssistantQueuedSuggestion } from "@helmsman/k8s";
import type { ActionBlock } from "@/lib/api";
import { useCluster } from "@/store/cluster";
import { useAssistantCtx } from "../AssistantContext";
import { Card, Section } from "../components/primitives";

/**
 * Resolve a live issue to the panel that owns its workload, using the
 * fingerprint prefix (everything before the first "|"). The reveal contract is
 * the same one the command palette uses (see commandPaletteLogic.ts /
 * DeploymentsPanel): `kind` is the singular resource kind and `key` is
 * "namespace/name", which DeploymentsPanel matches as a uid fallback.
 */
function issueTarget(fingerprint: string): { route: string; kind: string } {
  const prefix = fingerprint.split("|")[0] ?? "";
  // A degraded Deployment opens the Deployments panel; anything pod-related
  // (e.g. "unhealthyPod") opens the Pods panel.
  return prefix === "degradedDeployment"
    ? { route: "/deployments", kind: "deployment" }
    : { route: "/pods", kind: "pod" };
}

export function NeedsYouTab() {
  const { d, ns, working, run, runSuggestion } = useAssistantCtx();
  const navigate = useNavigate();
  const setNamespaceFilter = useCluster((s) => s.setNamespaceFilter);
  const setFocusRequest = useCluster((s) => s.setFocusRequest);
  const queue = d.clusterState?.queue ?? [];

  // Open the workload behind a live issue: scope the namespace filter to the
  // issue's namespace, navigate to the owning panel, and request a reveal of
  // the specific resource (DeploymentsPanel consumes this; PodsPanel ignores it
  // for now, in which case the namespace-scoped panel is the actionable result).
  function openIssue(location: string, fingerprint: string) {
    const [issueNs, name] = location.split("/");
    const { route, kind } = issueTarget(fingerprint);
    if (issueNs) setNamespaceFilter(issueNs);
    navigate(route);
    if (issueNs && name) {
      setFocusRequest({ route, kind, key: `${issueNs}/${name}` });
    }
  }

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
            <Card
              key={issue.fingerprint}
              className="p-0 transition-colors hover:bg-accent"
            >
              <div
                role="button"
                tabIndex={0}
                title="Open workload"
                className="flex cursor-pointer items-center gap-2 rounded-lg p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => openIssue(issue.location, issue.fingerprint)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openIssue(issue.location, issue.fingerprint);
                  }
                }}
              >
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
                  onClick={(e) => {
                    e.stopPropagation();
                    run({ action: "silence", namespace: ns, fingerprint: issue.fingerprint });
                  }}
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
