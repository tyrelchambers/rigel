// apps/web/src/panels/assistant/audits/auditPrompt.ts
// Build the chat handoff prompt for the Reliability audit. The deterministic
// engine has already produced the findings; this prompt seeds them so Rigel
// presents them (grouped by severity) and emits confirm-gated fix action blocks,
// rather than re-deriving detection. See buildRightSizing / AlertsCard handoff.
import type { ReliabilityFinding } from "@rigel/k8s";

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

  return [
    "Run the **Reliability / SRE audit**. A deterministic pre-scan of the cluster's workloads has already run; its findings are the JSON below.",
    "",
    "Present them to me grouped by severity (Critical, then Warning, then Info) as a markdown list. For each finding, name the workload (kind namespace/name, and container if given) and explain in one plain sentence why it is a reliability risk.",
    "",
    "For each finding, emit an ```action block so it renders as a confirm-gated button, using the right kind:",
    "- singleReplica → scale (2 or more replicas)",
    "- latestImageTag → setImage (inspect the live image first, then pin to a specific tag or digest)",
    "- noLivenessProbe, noReadinessProbe, missingResourceRequests, noAntiAffinity, hostPathVolume, noPodDisruptionBudget → applyManifest (read the live spec with `kubectl get -o yaml` first, then attach the patched YAML)",
    "",
    "Do not re-run detection or invent findings beyond this list, but you may use read-only kubectl to gather what you need to write a correct fix.",
    "",
    "Findings JSON:",
    "```json",
    JSON.stringify(findings, null, 2),
    "```",
  ].join("\n");
}
