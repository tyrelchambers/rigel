// High-availability / failure-tolerance audit — the fourth HELM-20 audit skill.
// Unlike the reliability/security/performance audits (which reason over one
// workload at a time), this one reasons over cluster topology: control-plane /
// etcd quorum, node redundancy and failure domains, and the cluster-critical
// singletons (CoreDNS, ingress) whose loss takes everything down. Pure and
// deterministic; the assistant only presents these findings in chat. Reuses the
// shared audit core (severity/sort/counts) so findings flow through the same CLI.

import { type AuditFinding } from "./auditCommon";

export type HaFindingType =
  | "singleNodeCluster"
  | "controlPlaneSinglePoint"
  | "controlPlaneNoFailureTolerance"
  | "controlPlaneEvenCount"
  | "controlPlaneQuorumInOneFailureDomain"
  | "controlPlaneSchedulable"
  | "dnsSinglePoint"
  | "dnsNotSpread"
  | "dnsNoPodDisruptionBudget"
  | "ingressSinglePoint"
  | "ingressNotSpread";

export interface HaFinding extends AuditFinding {
  type: HaFindingType;
}

export interface HaNode {
  name: string;
  ready: boolean;
  /** Carries the control-plane (or legacy master) role label. Also an etcd member
   *  in the common embedded-etcd topology. */
  isControlPlane: boolean;
  /** Accepts general workloads: not cordoned and no NoSchedule control-plane taint. */
  schedulable: boolean;
  /** Failure domain (topology.kubernetes.io/zone), when the node is labeled. */
  zone?: string;
}

export type HaComponentRole = "dns" | "ingress";

/** A cluster-critical singleton Deployment (CoreDNS, ingress controller) whose
 *  availability every workload depends on. */
export interface HaComponent {
  role: HaComponentRole;
  name: string;
  namespace: string;
  replicas: number;
  /** topologySpreadConstraints or pod anti-affinity forces replicas apart. */
  spread: boolean;
  /** A PodDisruptionBudget selects this component. */
  hasPdb: boolean;
}

export interface HaAuditInput {
  nodes: HaNode[];
  components: HaComponent[];
}

/** The etcd/control-plane majority needed to serve writes: floor(n/2)+1. */
export function quorum(members: number): number {
  return Math.floor(members / 2) + 1;
}

/** How many simultaneous member losses still leave a quorum. 1→0, 2→0, 3→1,
 *  4→1, 5→2: only odd growth buys tolerance. */
export function toleratedFailures(members: number): number {
  return members - quorum(members);
}

export function analyzeHa(input: HaAuditInput): HaFinding[] {
  const findings: HaFinding[] = [];
  const ready = input.nodes.filter((n) => n.ready);
  const controlPlane = ready.filter((n) => n.isControlPlane);
  const cpCount = controlPlane.length;
  const hasDedicatedWorkers = ready.some((n) => !n.isControlPlane);

  const cluster = { kind: "Cluster", name: "cluster", namespace: "" } as const;
  const cp = { kind: "Cluster", name: "control-plane", namespace: "" } as const;

  if (ready.length <= 1) {
    // A single-node cluster has no redundancy anywhere; the quorum checks below
    // would be redundant noise, so report only this.
    findings.push({
      ...cluster,
      type: "singleNodeCluster",
      severity: "warning",
      rationale:
        "The cluster has a single Ready node, so the control plane and every workload share one failure domain — losing that node takes the whole cluster down.",
      fix: "Add nodes so workloads (and control-plane quorum) can survive a node failure.",
    });
    return appendComponentFindings(findings, input);
  }

  if (cpCount === 1) {
    findings.push({
      ...cp,
      type: "controlPlaneSinglePoint",
      severity: "critical",
      rationale:
        "Only one control-plane node runs etcd and the API server, so losing it freezes the whole cluster (no scheduling, scaling, or self-healing) even though the workers keep running.",
      fix: "Run 3 control-plane nodes so etcd keeps quorum through a single failure.",
    });
  } else if (cpCount === 2) {
    findings.push({
      ...cp,
      type: "controlPlaneNoFailureTolerance",
      severity: "critical",
      rationale:
        "Two control-plane nodes form an etcd quorum of 2, which tolerates zero failures — losing either one loses quorum and freezes the control plane.",
      fix: "Add a third control-plane node (3 members tolerate 1 failure).",
    });
  } else if (cpCount >= 4 && cpCount % 2 === 0) {
    findings.push({
      ...cp,
      type: "controlPlaneEvenCount",
      severity: "warning",
      rationale: `An even number of control-plane nodes (${cpCount}) tolerates the same ${toleratedFailures(
        cpCount,
      )} failures as ${cpCount - 1} would, while adding split-vote risk — even member counts don't improve quorum.`,
      fix: `Use an odd number of control-plane nodes (${cpCount - 1} or ${cpCount + 1}).`,
    });
  }

  // Majority of control-plane members in a single failure domain: the domain is a
  // hidden single point of failure because losing it loses quorum. Needs zone
  // labels on every control-plane node and at least two distinct zones.
  if (cpCount >= 2) {
    const zoned = controlPlane.filter((n) => n.zone);
    if (zoned.length === cpCount) {
      const byZone = new Map<string, number>();
      for (const n of zoned) byZone.set(n.zone as string, (byZone.get(n.zone as string) ?? 0) + 1);
      if (byZone.size >= 2) {
        const q = quorum(cpCount);
        const concentrated = [...byZone.entries()].find(([, count]) => count >= q);
        if (concentrated) {
          const [zone, count] = concentrated;
          findings.push({
            ...cp,
            type: "controlPlaneQuorumInOneFailureDomain",
            severity: "warning",
            rationale: `Zone "${zone}" holds ${count} of ${cpCount} control-plane nodes — a full quorum. If that zone goes down the survivors can't form a majority, so the cluster only tolerates losing the smaller zone, not this one.`,
            fix: "Spread control-plane nodes so no single failure domain holds a quorum (e.g. an odd split across 3 zones).",
          });
        }
      }
    }
  }

  // Control-plane nodes also running general workloads, but only when there are
  // dedicated workers to move that load to (on an all-in-one cluster there is
  // nowhere else to schedule, so it isn't a finding).
  if (hasDedicatedWorkers) {
    for (const n of controlPlane.filter((n) => n.schedulable)) {
      findings.push({
        kind: "Node",
        name: n.name,
        namespace: "",
        type: "controlPlaneSchedulable",
        severity: "info",
        rationale:
          "This control-plane node also schedules general workloads, so a noisy pod can starve etcd or the API server of CPU/memory and destabilize the control plane.",
        fix: "Taint control-plane nodes NoSchedule so workloads run on the worker nodes.",
      });
    }
  }

  return appendComponentFindings(findings, input);
}

/** Append the CoreDNS/ingress component findings. Split out so the single-node
 *  early return still reports on the critical singletons. */
function appendComponentFindings(findings: HaFinding[], input: HaAuditInput): HaFinding[] {
  for (const c of input.components) {
    const base = { kind: "Deployment", name: c.name, namespace: c.namespace } as const;
    if (c.role === "dns") {
      if (c.replicas <= 1) {
        findings.push({
          ...base,
          type: "dnsSinglePoint",
          severity: "critical",
          rationale:
            "Cluster DNS (CoreDNS) runs a single replica, so losing its node breaks name resolution cluster-wide and most apps start failing even though their own pods are still running.",
          fix: "Scale CoreDNS to at least 2 replicas and spread them across nodes.",
        });
      } else {
        if (!c.spread) {
          findings.push({
            ...base,
            type: "dnsNotSpread",
            severity: "warning",
            rationale:
              "CoreDNS runs multiple replicas but nothing forces them apart, so the scheduler can place them all on one node — losing it takes cluster DNS down.",
            fix: "Add topologySpreadConstraints (or pod anti-affinity) across kubernetes.io/hostname to CoreDNS.",
          });
        }
        if (!c.hasPdb) {
          findings.push({
            ...base,
            type: "dnsNoPodDisruptionBudget",
            severity: "info",
            rationale:
              "CoreDNS has no PodDisruptionBudget, so a node drain or rolling upgrade can evict every DNS replica at once.",
            fix: "Create a PodDisruptionBudget for CoreDNS (e.g. minAvailable: 1).",
          });
        }
      }
    } else if (c.replicas <= 1) {
      findings.push({
        ...base,
        type: "ingressSinglePoint",
        severity: "warning",
        rationale:
          "The ingress controller runs a single replica, so losing its node drops all external traffic into the cluster even when the backend pods are healthy.",
        fix: "Scale the ingress controller to at least 2 replicas and spread them across nodes.",
      });
    } else if (!c.spread) {
      findings.push({
        ...base,
        type: "ingressNotSpread",
        severity: "info",
        rationale:
          "The ingress controller runs multiple replicas but nothing forces them apart, so they can co-locate on one node and a single node failure drops external traffic.",
        fix: "Add topologySpreadConstraints (or pod anti-affinity) across kubernetes.io/hostname to the ingress controller.",
      });
    }
  }
  return findings;
}
