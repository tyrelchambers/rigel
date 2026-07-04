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

/** Is the container effectively guaranteed to run as a non-root user? A container
 *  setting wins over the pod default. */
function runsAsNonRoot(c: AuditContainer, w: AuditWorkload): boolean {
  if (c.runAsNonRoot === true) return true;
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
    }
  }
  return findings;
}
