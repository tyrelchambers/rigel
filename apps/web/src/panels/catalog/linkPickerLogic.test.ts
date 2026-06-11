import { describe, expect, test } from "vitest";
import type {
  DeploymentLike,
  StatefulSetLike,
  DaemonSetLike,
} from "@helmsman/catalog";
import { pickableWorkloads, groupWorkloadsByNamespace } from "./linkPickerLogic";

function dep(
  name: string,
  ns: string,
  containers: Array<{ name: string; image?: string }>,
  annotations?: Record<string, string>,
): DeploymentLike {
  return {
    metadata: { name, namespace: ns, annotations },
    spec: { template: { spec: { containers } } },
  } as DeploymentLike;
}

describe("pickableWorkloads", () => {
  test("flattens deployments, statefulsets, daemonsets with kind + containers", () => {
    const deployments = [dep("web", "default", [{ name: "web", image: "nginx:1" }])];
    const statefulSets: StatefulSetLike[] = [
      { metadata: { name: "db", namespace: "data" }, spec: { template: { spec: { containers: [{ name: "pg", image: "postgres:16" }] } } } } as StatefulSetLike,
    ];
    const daemonSets: DaemonSetLike[] = [
      { metadata: { name: "node-exp", namespace: "mon" }, spec: { template: { spec: { containers: [{ name: "exporter", image: "node-exporter:1" }] } } } } as DaemonSetLike,
    ];
    const out = pickableWorkloads(deployments, statefulSets, daemonSets);
    expect(out.map((w) => `${w.kind}/${w.name}`)).toEqual([
      "deployment/web",
      "statefulset/db",
      "daemonset/node-exp",
    ]);
    expect(out[2]?.containers).toEqual([{ name: "exporter", image: "node-exporter:1" }]);
  });

  test("reads existing binding annotation as boundTo / boundContainer", () => {
    const deployments = [
      dep("mirror", "apps", [{ name: "c", image: "x:1" }], {
        "helmsman.dev/catalog-app": "foo",
        "helmsman.dev/catalog-container": "c",
      }),
    ];
    const out = pickableWorkloads(deployments, [], []);
    expect(out[0]?.boundTo).toBe("foo");
    expect(out[0]?.boundContainer).toBe("c");
  });
});

describe("groupWorkloadsByNamespace", () => {
  const all = pickableWorkloads(
    [
      dep("alpha", "ns-a", [{ name: "c" }]),
      dep("beta", "ns-b", [{ name: "c" }]),
      dep("gamma", "ns-a", [{ name: "c" }]),
    ],
    [],
    [],
  );

  test("groups by namespace, names sorted, namespaces sorted", () => {
    const groups = groupWorkloadsByNamespace(all, "");
    expect(groups.map((g) => g.namespace)).toEqual(["ns-a", "ns-b"]);
    expect(groups[0]?.workloads.map((w) => w.name)).toEqual(["alpha", "gamma"]);
  });

  test("filters by workload name substring (case-insensitive)", () => {
    const groups = groupWorkloadsByNamespace(all, "BET");
    expect(groups.flatMap((g) => g.workloads.map((w) => w.name))).toEqual(["beta"]);
  });

  test("filters by namespace substring", () => {
    const groups = groupWorkloadsByNamespace(all, "ns-b");
    expect(groups.map((g) => g.namespace)).toEqual(["ns-b"]);
  });

  test("no matches → empty array", () => {
    expect(groupWorkloadsByNamespace(all, "zzz")).toEqual([]);
  });
});
