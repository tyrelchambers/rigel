// packages/audit-cli/src/audits.ts
// Thin dispatch layer over the three pure @rigel/k8s audit engines: run the
// engine, sort its findings urgency-first, and count them. No I/O — callers
// (gather.ts + index.ts) supply already-fetched inputs.
import {
  analyzeReliability,
  analyzeSecurity,
  analyzePerformance,
  sortFindings,
  auditCounts,
  type ReliabilityAuditInput,
  type SecurityAuditInput,
  type PerformanceAuditInput,
  type ReliabilityFinding,
  type SecurityFinding,
  type PerformanceFinding,
  type AuditCounts,
} from "@rigel/k8s";

export type AuditKind = "reliability" | "security" | "performance";

export interface AuditRunResult<F> {
  audit: AuditKind;
  findings: F[];
  counts: AuditCounts;
}

export function runReliability(input: ReliabilityAuditInput): AuditRunResult<ReliabilityFinding> {
  const findings = sortFindings(analyzeReliability(input));
  return { audit: "reliability", findings, counts: auditCounts(findings) };
}

export function runSecurity(input: SecurityAuditInput): AuditRunResult<SecurityFinding> {
  const findings = sortFindings(analyzeSecurity(input));
  return { audit: "security", findings, counts: auditCounts(findings) };
}

export function runPerformance(input: PerformanceAuditInput): AuditRunResult<PerformanceFinding> {
  const findings = sortFindings(analyzePerformance(input));
  return { audit: "performance", findings, counts: auditCounts(findings) };
}
