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

export function analyzeSecurity(input: SecurityAuditInput): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const w of input.workloads) {
    const base = { kind: w.kind, name: w.name, namespace: w.namespace } as const;

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
    }
  }
  return findings;
}
