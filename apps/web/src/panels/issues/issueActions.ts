import type { Issue, IssueFix, IssueSubject } from "@rigel/k8s/src/issues/types";
import { handoffToChat } from "@/lib/chatHandoff";
import { goToIssueSubject } from "@/lib/resourceNav";

type NavigateFn = (to: string) => void;

function locationOf(subject: IssueSubject): string {
  return subject.namespace ? `${subject.namespace}/${subject.name}` : subject.name;
}

/** The plain-language prompt the Diagnose action hands to the chat pane. */
export function diagnosePrompt(issue: Issue): string {
  const lines = [
    `Diagnose a problem in my Kubernetes cluster: ${issue.subject.kind} ${locationOf(issue.subject)}.`,
    `Problem: ${issue.title}`,
    `Cause: ${issue.cause}`,
    `What is wrong: ${issue.whatsWrong}`,
  ];
  if (issue.evidence) lines.push(`Evidence: ${issue.evidence}`);
  if (issue.related.length > 0) {
    lines.push(
      `Related resources: ${issue.related.map((r) => `${r.kind} ${locationOf(r)}`).join(", ")}`,
    );
  }
  lines.push(`Suggested next step: ${issue.nextStep}`);
  lines.push("Confirm the root cause from the live cluster and tell me what to do. Do not change anything without asking first.");
  return lines.join("\n");
}

/** Hand the issue to the chat pane in a fresh thread. */
export function runDiagnose(issue: Issue): void {
  handoffToChat(diagnosePrompt(issue), { newThread: true });
}

/** Open the panel that owns the issue's subject. */
export function openIssueSubject(navigate: NavigateFn, issue: Issue): void {
  goToIssueSubject(navigate, issue.subject);
}

export interface IssueFixAction extends IssueFix {
  /** The full command as the confirmation dialog shows it. */
  commandLine: string;
}

/** The issue's one-click fix, with its command rendered for confirmation. */
export function issueFixAction(issue: Issue): IssueFixAction | undefined {
  if (!issue.fix) return undefined;
  return { ...issue.fix, commandLine: `kubectl ${issue.fix.command.join(" ")}` };
}
