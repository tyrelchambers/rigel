import { SEVERITY_RANK } from "../auditCommon";
import { issueFingerprint, subjectKey, type Issue, type IssueGroup, type IssueInput } from "./types";
import { runtimeRules } from "./rules/runtime";
import { referenceRules } from "./rules/references";
import { storageRules } from "./rules/storage";
import { certRules } from "./rules/certs";

export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const at = a.onsetAt ? Date.parse(a.onsetAt) : Number.POSITIVE_INFINITY;
    const bt = b.onsetAt ? Date.parse(b.onsetAt) : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return subjectKey(a.subject).localeCompare(subjectKey(b.subject));
  });
}

export function rollUpIssues(issues: Issue[]): IssueGroup[] {
  const groups = new Map<string, Issue[]>();
  for (const i of sortIssues(issues)) {
    const key = `${i.rule}|${i.cause}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(i);
    else groups.set(key, [i]);
  }
  const out: IssueGroup[] = [];
  for (const [key, members] of groups) out.push({ key, lead: members[0], members });
  return out.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.lead.severity] - SEVERITY_RANK[b.lead.severity];
    if (bySeverity !== 0) return bySeverity;
    const at = a.lead.onsetAt ? Date.parse(a.lead.onsetAt) : Number.POSITIVE_INFINITY;
    const bt = b.lead.onsetAt ? Date.parse(b.lead.onsetAt) : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return a.key.localeCompare(b.key);
  });
}

export function detectIssues(input: IssueInput): Issue[] {
  const found = [
    ...runtimeRules(input),
    ...referenceRules(input),
    ...storageRules(input),
    ...certRules(input),
  ];
  return sortIssues(found.map((i) => ({ ...i, fingerprint: issueFingerprint(i) })));
}
