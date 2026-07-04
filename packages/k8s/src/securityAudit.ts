// Security audit — HELM-19 / the second HELM-20 audit skill. Pure, deterministic,
// spec-based (pod/container securityContext + pod spec). Reuses the shared audit
// core; mirrors analyzeReliability's structure.
import {
  type AuditWorkload,
  type AuditContainer,
  type AuditFinding,
  type AuditWorkloadKind,
} from "./auditCommon";

export type SecurityFindingType =
  | "privilegedContainer"
  | "hostNamespace"
  | "runsAsRoot"
  | "allowsPrivilegeEscalation"
  | "addedCapabilities"
  | "writableRootFilesystem"
  | "hostPort";

export interface SecurityFinding extends AuditFinding {
  type: SecurityFindingType;
  kind: AuditWorkloadKind;
}

export interface SecurityAuditInput {
  workloads: AuditWorkload[];
}

/** Capabilities worth calling out explicitly in the rationale. */
const DANGEROUS_CAPS = new Set(["SYS_ADMIN", "NET_ADMIN", "NET_RAW", "ALL"]);

/** Is the container effectively guaranteed to run as a non-root user? A container
 *  setting wins over the pod default. */
function runsAsNonRoot(c: AuditContainer, w: AuditWorkload): boolean {
  if (c.runAsNonRoot === true) return true;
  if (c.runAsNonRoot === false) return false;
  if (c.runAsUser !== undefined) return c.runAsUser !== 0;
  if (w.podRunAsNonRoot === true) return true;
  if (w.podRunAsUser !== undefined) return w.podRunAsUser !== 0;
  return false; // nothing establishes non-root
}

export function analyzeSecurity(input: SecurityAuditInput): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const w of input.workloads) {
    const base = { kind: w.kind, name: w.name, namespace: w.namespace } as const;

    const hostNs = [
      w.hostNetwork ? "hostNetwork" : null,
      w.hostPID ? "hostPID" : null,
      w.hostIPC ? "hostIPC" : null,
    ].filter(Boolean);
    if (hostNs.length > 0) {
      findings.push({
        ...base,
        type: "hostNamespace",
        severity: "critical",
        rationale: `Pod shares the host's ${hostNs.join(", ")}, breaking the container's isolation from the node.`,
        fix: `Remove ${hostNs.join("/")} from the pod spec unless strictly required.`,
      });
    }

    for (const c of w.containers) {
      const cbase = { ...base, container: c.name } as const;

      if (c.privileged === true) {
        findings.push({
          ...cbase,
          type: "privilegedContainer",
          severity: "critical",
          rationale: "Container runs privileged, giving it near-root access to the host kernel and devices.",
          fix: "Remove securityContext.privileged (grant only the specific capabilities actually needed).",
        });
      }

      if (!runsAsNonRoot(c, w)) {
        findings.push({
          ...cbase,
          type: "runsAsRoot",
          severity: "warning",
          rationale: "Container is not pinned to a non-root user, so it may run as root and widen the blast radius of a compromise.",
          fix: "Set securityContext.runAsNonRoot: true (and a non-zero runAsUser).",
        });
      }

      if (c.allowPrivilegeEscalation !== false) {
        findings.push({
          ...cbase,
          type: "allowsPrivilegeEscalation",
          severity: "warning",
          rationale: "Container allows privilege escalation, so a process can gain more privileges than its parent (e.g. via setuid).",
          fix: "Set securityContext.allowPrivilegeEscalation: false.",
        });
      }

      if (c.addedCapabilities && c.addedCapabilities.length > 0) {
        const flagged = c.addedCapabilities.filter((cap) => DANGEROUS_CAPS.has(cap));
        const note = flagged.length > 0 ? ` including ${flagged.join(", ")}` : "";
        findings.push({
          ...cbase,
          type: "addedCapabilities",
          severity: "warning",
          rationale: `Container adds Linux capabilities${note}, expanding what a compromised process can do to the host.`,
          fix: "Drop unneeded capabilities (capabilities.drop: [ALL], then add back only what is required).",
        });
      }

      if (c.readOnlyRootFilesystem !== true) {
        findings.push({
          ...cbase,
          type: "writableRootFilesystem",
          severity: "info",
          rationale: "Container's root filesystem is writable, so a compromise can persist changes or drop tooling into the image.",
          fix: "Set securityContext.readOnlyRootFilesystem: true (mount an emptyDir for paths that need writes).",
        });
      }

      if (c.hostPorts && c.hostPorts.length > 0) {
        findings.push({
          ...cbase,
          type: "hostPort",
          severity: "info",
          rationale: `Container binds host port ${c.hostPorts.join(", ")}, exposing it directly on the node and pinning scheduling.`,
          fix: "Expose the container through a Service instead of a hostPort.",
        });
      }
    }
  }
  return findings;
}
