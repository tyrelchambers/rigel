import { describe, it, expect } from "vitest";
import { extractHaAuditInputs } from "./extractHaAuditInputs";

/** Build the `{ <watchKind>: { "<ns>/<name>": obj } }` shape the adapter reads. */
function grouped(parts: {
  nodes?: unknown[];
  deployments?: unknown[];
  poddisruptionbudgets?: unknown[];
}): Record<string, Record<string, unknown>> {
  const key = (o: any) => `${o.metadata?.namespace ?? ""}/${o.metadata?.name ?? ""}`;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, items] of Object.entries(parts)) {
    out[k] = {};
    for (const it of items ?? []) out[k][key(it)] = it;
  }
  return out;
}

function rawNode(opts: {
  name: string;
  controlPlane?: boolean;
  ready?: boolean;
  unschedulable?: boolean;
  taintCP?: boolean;
  zone?: string;
}): unknown {
  const labels: Record<string, string> = {};
  if (opts.controlPlane) labels["node-role.kubernetes.io/control-plane"] = "";
  if (opts.zone) labels["topology.kubernetes.io/zone"] = opts.zone;
  return {
    kind: "Node",
    metadata: { name: opts.name, labels },
    spec: {
      unschedulable: opts.unschedulable,
      taints: opts.taintCP
        ? [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }]
        : [],
    },
    status: { conditions: [{ type: "Ready", status: opts.ready === false ? "False" : "True" }] },
  };
}

describe("extractHaAuditInputs — nodes", () => {
  it("reads role, readiness, zone, and control-plane taint", () => {
    const { nodes } = extractHaAuditInputs(
      grouped({
        nodes: [
          rawNode({ name: "cp", controlPlane: true, taintCP: true, zone: "onprem" }),
          rawNode({ name: "w", ready: false }),
        ],
      }),
    );
    expect(nodes).toEqual([
      { name: "cp", ready: true, isControlPlane: true, schedulable: false, zone: "onprem" },
      { name: "w", ready: false, isControlPlane: false, schedulable: true, zone: undefined },
    ]);
  });

  it("treats a cordoned node as unschedulable", () => {
    const { nodes } = extractHaAuditInputs(grouped({ nodes: [rawNode({ name: "n", unschedulable: true })] }));
    expect(nodes[0].schedulable).toBe(false);
  });
});

describe("extractHaAuditInputs — components", () => {
  it("detects CoreDNS in kube-system and matches its PDB", () => {
    const { components } = extractHaAuditInputs(
      grouped({
        deployments: [
          {
            kind: "Deployment",
            metadata: { name: "coredns", namespace: "kube-system", labels: { "k8s-app": "kube-dns" } },
            spec: { replicas: 2, template: { metadata: { labels: { "k8s-app": "kube-dns" } }, spec: {} } },
          },
        ],
        poddisruptionbudgets: [
          {
            kind: "PodDisruptionBudget",
            metadata: { namespace: "kube-system" },
            spec: { selector: { matchLabels: { "k8s-app": "kube-dns" } } },
          },
        ],
      }),
    );
    expect(components).toEqual([
      { role: "dns", name: "coredns", namespace: "kube-system", replicas: 2, spread: false, hasPdb: true },
    ]);
  });

  it("detects an ingress controller by its well-known app label and reads spread", () => {
    const { components } = extractHaAuditInputs(
      grouped({
        deployments: [
          {
            kind: "Deployment",
            metadata: {
              name: "ingress-nginx-controller",
              namespace: "ingress-nginx",
              labels: { "app.kubernetes.io/name": "ingress-nginx" },
            },
            spec: {
              replicas: 3,
              template: { metadata: { labels: { app: "ingress" } }, spec: { topologySpreadConstraints: [{}] } },
            },
          },
        ],
      }),
    );
    expect(components).toEqual([
      { role: "ingress", name: "ingress-nginx-controller", namespace: "ingress-nginx", replicas: 3, spread: true, hasPdb: false },
    ]);
  });

  it("counts pod anti-affinity as spread", () => {
    const { components } = extractHaAuditInputs(
      grouped({
        deployments: [
          {
            kind: "Deployment",
            metadata: { name: "coredns", namespace: "kube-system" },
            spec: { replicas: 2, template: { spec: { affinity: { podAntiAffinity: {} } } } },
          },
        ],
      }),
    );
    expect(components[0].spread).toBe(true);
  });

  it("ignores unrelated deployments, including an app merely named *ingress*", () => {
    const { components } = extractHaAuditInputs(
      grouped({
        deployments: [
          { kind: "Deployment", metadata: { name: "my-ingress-dashboard", namespace: "default", labels: {} }, spec: {} },
          { kind: "Deployment", metadata: { name: "web", namespace: "default" }, spec: {} },
        ],
      }),
    );
    expect(components).toEqual([]);
  });
});
