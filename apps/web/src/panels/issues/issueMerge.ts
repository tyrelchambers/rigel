import { sortIssues } from "@rigel/k8s/src/issues/engine";
import { issueFingerprint, type Issue, type IssueRuleId, type IssueSeverity } from "@rigel/k8s/src/issues/types";

/** One entry of the agent's approval queue, as the agent writes it into the
 *  `assistant-state` ConfigMap. */
export interface AgentQueueItem {
  at?: string;
  incident?: string;
  suggestion?: string;
  reason?: string;
  fingerprint?: string;
}

export interface AgentIncidentState {
  queue?: AgentQueueItem[];
}

const INCIDENT_SUBJECT_KINDS: Record<string, string> = {
  unhealthyPod: "Pod",
  loggedError: "Pod",
  degradedDeployment: "Deployment",
};

const INCIDENT_SEVERITIES: Record<string, IssueSeverity> = {
  unhealthyPod: "critical",
  loggedError: "warning",
  degradedDeployment: "critical",
};

const REASON_RULES: Record<string, IssueRuleId> = {
  CrashLoopBackOff: "crashLoopBackOff",
  ImagePullBackOff: "imagePullBackOff",
  ErrImagePull: "imagePullBackOff",
  OOMKilled: "oomKilled",
  Failed: "podFailed",
};

function ruleKey(kind: string, namespace: string, name: string, rule: IssueRuleId): string {
  return [rule, kind, namespace, name].join("|");
}

function toIssue(item: AgentQueueItem): Issue | undefined {
  const parts = (item.fingerprint ?? "").split("|");
  if (parts.length !== 4) return undefined;
  const [incidentKind, namespace, name, reason] = parts;
  const kind = INCIDENT_SUBJECT_KINDS[incidentKind];
  if (!kind || !name || !reason) return undefined;
  const base: Issue = {
    fingerprint: "",
    rule: "agentIncident",
    title: `Agent flagged ${reason}`,
    category: "runtime",
    severity: INCIDENT_SEVERITIES[incidentKind] ?? "warning",
    subject: { kind, namespace, name },
    cause: reason,
    whatsWrong: item.incident ?? `${namespace}/${name}: ${reason}`,
    nextStep: item.suggestion ?? "Open the resource and investigate.",
    evidence: item.reason,
    onsetAt: item.at,
    related: [],
    source: "agent",
  };
  return { ...base, fingerprint: issueFingerprint(base) };
}

/**
 * Fold the agent's queued incidents into the client-detected issues. An
 * incident the rules already found on the same subject is dropped, so the same
 * problem is never listed twice.
 */
export function mergeAgentIssues(
  cluster: Issue[],
  agent: AgentIncidentState | null | undefined,
): Issue[] {
  const queue = agent?.queue ?? [];
  if (queue.length === 0) return cluster;

  const detected = new Set(
    cluster.map((i) => ruleKey(i.subject.kind, i.subject.namespace, i.subject.name, i.rule)),
  );

  const extra: Issue[] = [];
  for (const item of queue) {
    const issue = toIssue(item);
    if (!issue) continue;
    const equivalent = REASON_RULES[issue.cause];
    if (
      equivalent &&
      detected.has(ruleKey(issue.subject.kind, issue.subject.namespace, issue.subject.name, equivalent))
    ) {
      continue;
    }
    extra.push(issue);
  }
  if (extra.length === 0) return cluster;
  return sortIssues([...cluster, ...extra]);
}
