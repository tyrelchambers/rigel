import { describe, it, expect } from "vitest";
import {
  analyzeHa,
  quorum,
  toleratedFailures,
  type HaNode,
  type HaComponent,
  type HaAuditInput,
  type HaFindingType,
} from "./haAudit";

function node(overrides: Partial<HaNode> = {}): HaNode {
  return { name: "n", ready: true, isControlPlane: false, schedulable: true, ...overrides };
}

function comp(overrides: Partial<HaComponent> = {}): HaComponent {
  return {
    role: "dns",
    name: "coredns",
    namespace: "kube-system",
    replicas: 2,
    spread: true,
    hasPdb: true,
    ...overrides,
  };
}

function run(input: Partial<HaAuditInput>): HaFindingType[] {
  return analyzeHa({ nodes: [], components: [], ...input }).map((f) => f.type);
}

describe("quorum math", () => {
  it("needs a majority", () => {
    expect([1, 2, 3, 4, 5].map(quorum)).toEqual([1, 2, 2, 3, 3]);
  });
  it("only odd growth buys failure tolerance", () => {
    expect([1, 2, 3, 4, 5].map(toleratedFailures)).toEqual([0, 0, 1, 1, 2]);
  });
});

describe("analyzeHa — cluster / control-plane", () => {
  it("flags a single-node cluster and skips the quorum checks", () => {
    const types = run({ nodes: [node({ isControlPlane: true })] });
    expect(types).toEqual(["singleNodeCluster"]);
  });

  it("treats a cluster with only one Ready node as single-node", () => {
    const types = run({
      nodes: [node({ isControlPlane: true }), node({ ready: false }), node({ ready: false })],
    });
    expect(types).toContain("singleNodeCluster");
    expect(types).not.toContain("controlPlaneSinglePoint");
  });

  it("flags a single control-plane node as a critical SPOF", () => {
    const types = run({
      nodes: [node({ isControlPlane: true, schedulable: false }), node({ name: "w1" }), node({ name: "w2" })],
    });
    expect(types).toEqual(["controlPlaneSinglePoint"]);
  });

  it("flags two control-plane nodes as tolerating zero failures", () => {
    const types = run({
      nodes: [
        node({ name: "c1", isControlPlane: true, schedulable: false }),
        node({ name: "c2", isControlPlane: true, schedulable: false }),
        node({ name: "w1" }),
      ],
    });
    expect(types).toEqual(["controlPlaneNoFailureTolerance"]);
  });

  it("passes a clean 3-node control plane with no dedicated workers", () => {
    const cp = (name: string) => node({ name, isControlPlane: true });
    expect(run({ nodes: [cp("c1"), cp("c2"), cp("c3")] })).toEqual([]);
  });

  it("warns on an even control-plane count", () => {
    const cp = (name: string) => node({ name, isControlPlane: true });
    expect(run({ nodes: [cp("c1"), cp("c2"), cp("c3"), cp("c4")] })).toEqual(["controlPlaneEvenCount"]);
  });

  it("flags a quorum concentrated in one failure domain (the 2:1 trap)", () => {
    const cp = (name: string, zone: string) => node({ name, isControlPlane: true, zone });
    const types = run({ nodes: [cp("c1", "onprem"), cp("c2", "onprem"), cp("c3", "offprem")] });
    expect(types).toContain("controlPlaneQuorumInOneFailureDomain");
  });

  it("does not flag a control plane spread across three failure domains", () => {
    const cp = (name: string, zone: string) => node({ name, isControlPlane: true, zone });
    const types = run({ nodes: [cp("c1", "a"), cp("c2", "b"), cp("c3", "c")] });
    expect(types).not.toContain("controlPlaneQuorumInOneFailureDomain");
  });

  it("reports control-plane nodes that also run workloads, only when workers exist", () => {
    const withWorker = run({
      nodes: [
        node({ name: "c1", isControlPlane: true, schedulable: true }),
        node({ name: "c2", isControlPlane: true, schedulable: true }),
        node({ name: "c3", isControlPlane: true, schedulable: true }),
        node({ name: "w1" }),
      ],
    });
    expect(withWorker.filter((t) => t === "controlPlaneSchedulable")).toHaveLength(3);

    const allInOne = run({
      nodes: [
        node({ name: "c1", isControlPlane: true, schedulable: true }),
        node({ name: "c2", isControlPlane: true, schedulable: true }),
        node({ name: "c3", isControlPlane: true, schedulable: true }),
      ],
    });
    expect(allInOne).not.toContain("controlPlaneSchedulable");
  });
});

describe("analyzeHa — critical singletons", () => {
  const healthyCluster = [node({ name: "c1", isControlPlane: true }), node({ name: "c2", isControlPlane: true }), node({ name: "c3", isControlPlane: true })];

  it("flags single-replica CoreDNS as critical", () => {
    const findings = analyzeHa({ nodes: healthyCluster, components: [comp({ replicas: 1 })] });
    const dns = findings.find((f) => f.type === "dnsSinglePoint");
    expect(dns?.severity).toBe("critical");
    expect(dns?.kind).toBe("Deployment");
  });

  it("flags multi-replica CoreDNS with no spread and no PDB", () => {
    const types = run({
      nodes: healthyCluster,
      components: [comp({ replicas: 2, spread: false, hasPdb: false })],
    });
    expect(types).toEqual(expect.arrayContaining(["dnsNotSpread", "dnsNoPodDisruptionBudget"]));
  });

  it("passes well-spread CoreDNS with a PDB", () => {
    expect(run({ nodes: healthyCluster, components: [comp({ replicas: 2, spread: true, hasPdb: true })] })).toEqual([]);
  });

  it("flags single-replica ingress as a warning and unspread ingress as info", () => {
    const single = analyzeHa({
      nodes: healthyCluster,
      components: [comp({ role: "ingress", name: "ingress-nginx-controller", namespace: "ingress-nginx", replicas: 1 })],
    });
    expect(single.find((f) => f.type === "ingressSinglePoint")?.severity).toBe("warning");

    const unspread = run({
      nodes: healthyCluster,
      components: [comp({ role: "ingress", name: "ingress-nginx-controller", namespace: "ingress-nginx", replicas: 3, spread: false })],
    });
    expect(unspread).toEqual(["ingressNotSpread"]);
  });

  it("still audits the singletons on a single-node cluster", () => {
    const types = run({ nodes: [node()], components: [comp({ replicas: 1 })] });
    expect(types).toEqual(expect.arrayContaining(["singleNodeCluster", "dnsSinglePoint"]));
  });
});
