// apps/web/src/panels/assistant/audits/useReliabilityAudit.ts
// Reliability audit data hook: subscribe to the workload + PDB + HPA watch kinds
// (cluster-wide, like useRightSizing — the store slice is keyed by kind only),
// adapt the live store into engine inputs, and run the pure engine. Read-only.
import { useEffect, useMemo } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import {
  analyzeReliability,
  sortFindings,
  auditCounts,
  type ReliabilityFinding,
  type AuditCounts,
} from "@rigel/k8s";
import { extractAuditInputs } from "./extractAuditInputs";

const WATCH_KINDS = [
  "deployments",
  "statefulsets",
  "daemonsets",
  "poddisruptionbudgets",
  "horizontalpodautoscalers",
];

export interface ReliabilityAuditData {
  findings: ReliabilityFinding[];
  counts: AuditCounts;
}

export function useReliabilityAudit(): ReliabilityAuditData {
  const resources = useCluster((s) => s.resources);

  useEffect(() => {
    WATCH_KINDS.forEach((k) => subscribe(k, "*"));
    return () => WATCH_KINDS.forEach((k) => unsubscribe(k, "*"));
  }, []);

  return useMemo(() => {
    const findings = sortFindings(analyzeReliability(extractAuditInputs(resources)));
    return { findings, counts: auditCounts(findings) };
  }, [resources]);
}
