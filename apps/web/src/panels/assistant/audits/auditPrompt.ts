// apps/web/src/panels/assistant/audits/auditPrompt.ts
// Build the chat handoff prompt for the Reliability audit. The deterministic
// engine has already produced the findings; this prompt seeds them so Rigel
// presents them (grouped by severity) and emits confirm-gated fix action blocks,
// rather than re-deriving detection. See buildRightSizing / AlertsCard handoff.
//
// On a large cluster the raw finding set can be huge, so we keep the prompt small:
//   1. Seed only compact rows (drop the constant rationale/fix strings — they are
//      identical per finding type; Rigel explains from the type + the action map).
//   2. Cap the seeded rows to the highest-severity SEED_CAP findings (the list is
//      already severity-sorted) and summarize the long tail as counts, so nothing
//      is silently dropped and the chat context stays bounded.
import { auditCounts, type ReliabilityFinding } from "@rigel/k8s";

/** Max findings seeded as rows; the rest are summarized as counts. */
export const SEED_CAP = 40;

/** "3 critical, 12 warning, 5 info" for a finding set (omits zero buckets). */
function severityBreakdown(findings: ReliabilityFinding[]): string {
  const c = auditCounts(findings);
  const parts: string[] = [];
  if (c.critical) parts.push(`${c.critical} critical`);
  if (c.warning) parts.push(`${c.warning} warning`);
  if (c.info) parts.push(`${c.info} info`);
  return parts.join(", ");
}

/** "noReadinessProbe 8, missingResourceRequests 6, …", most-common first. */
function typeBreakdown(findings: ReliabilityFinding[]): string {
  const byType = new Map<string, number>();
  for (const f of findings) byType.set(f.type, (byType.get(f.type) ?? 0) + 1);
  return [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t} ${n}`)
    .join(", ");
}

export function buildReliabilityAuditPrompt(findings: ReliabilityFinding[]): string {
  if (findings.length === 0) {
    return [
      "Run the **Reliability / SRE audit**.",
      "A deterministic pre-scan found no reliability issues across the cluster's workloads",
      "(single replicas, missing probes, PodDisruptionBudgets, anti-affinity, resource requests,",
      "mutable :latest images, hostPath volumes).",
      "Confirm the cluster looks healthy on these dimensions and mention anything else worth checking.",
    ].join(" ");
  }

  // Findings arrive severity-sorted (sortFindings); take the top tier as rows and
  // summarize the remainder. Rows are compact — no rationale/fix (constant per type).
  const seeded = findings.slice(0, SEED_CAP);
  const overflow = findings.slice(SEED_CAP);
  const counts = auditCounts(findings);
  const rows = seeded.map((f) => ({
    type: f.type,
    severity: f.severity,
    kind: f.kind,
    namespace: f.namespace,
    name: f.name,
    ...(f.container ? { container: f.container } : {}),
  }));

  const lines = [
    "Run the **Reliability / SRE audit**. A deterministic pre-scan of the cluster's workloads has already run.",
    "",
    `Found ${findings.length} issue${findings.length === 1 ? "" : "s"} across ${counts.workloadsAffected} workload${counts.workloadsAffected === 1 ? "" : "s"} (${severityBreakdown(findings)}).`,
    "",
    overflow.length > 0
      ? `Below are the ${seeded.length} highest-severity findings. Walk these first; ask me to "show the rest" or filter by severity/type to pull in the others.`
      : "Findings are below.",
    "",
    "Present them grouped by severity (Critical, then Warning, then Info) as a markdown list. For each, name the workload (kind namespace/name, container if given) and explain in one plain sentence why it is a reliability risk.",
    "",
    "For each finding, emit an ```action block (a confirm-gated button) using the right kind:",
    "- singleReplica → scale (2 or more replicas)",
    "- latestImageTag → setImage (inspect the live image first, then pin to a specific tag or digest)",
    "- missingResourceRequests → setResources (set cpu and memory requests on the container)",
    "- noLivenessProbe, noReadinessProbe, noAntiAffinity, hostPathVolume, noPodDisruptionBudget → applyManifest (read the live spec with `kubectl get -o yaml` first, then attach the patched YAML)",
    "",
    "Do not re-run detection or invent findings beyond this list, but you may use read-only kubectl to gather what you need to write a correct fix.",
    "",
    "Findings JSON:",
    "```json",
    JSON.stringify(rows, null, 2),
    "```",
  ];

  if (overflow.length > 0) {
    lines.push(
      "",
      `Not shown: ${overflow.length} more (${severityBreakdown(overflow)}; by type: ${typeBreakdown(overflow)}).`,
    );
  }

  return lines.join("\n");
}
