import { describe, it, expect } from "vitest";
import { LOG_KINDS, buildSidebarItems } from "./logTargets";

const resources = {
  deployments: {
    "default/web": {
      metadata: { name: "web", namespace: "default" },
      spec: { selector: { matchLabels: { app: "web" } } },
      status: { readyReplicas: 1, replicas: 2 },
    },
  },
  daemonsets: {
    "kube-system/fluentd": {
      metadata: { name: "fluentd", namespace: "kube-system" },
      spec: { selector: { matchLabels: { app: "fluentd" } } },
      status: { numberReady: 3, desiredNumberScheduled: 3 },
    },
  },
  pods: {
    "default/web-abc": {
      metadata: { name: "web-abc", namespace: "default" },
      status: { phase: "Running" },
    },
    "default/web-def": {
      metadata: { name: "web-def", namespace: "default" },
      status: { phase: "CrashLoopBackOff" },
    },
  },
};

describe("LOG_KINDS", () => {
  it("lists the four kinds, deployments first", () => {
    expect(LOG_KINDS.map((k) => k.kind)).toEqual(["deployments", "statefulsets", "daemonsets", "pods"]);
  });
});

describe("buildSidebarItems", () => {
  it("deployment → label selector + ready/total + unhealthy when not all ready", () => {
    const [it0] = buildSidebarItems(Object.values(resources.deployments), "deployments", "");
    expect(it0).toMatchObject({
      key: "default/web", name: "web", namespace: "default",
      statusText: "1/2", unhealthy: true, healthState: "degraded", selector: "app=web", pod: null,
    });
  });
  it("daemonset → numberReady/desired", () => {
    const [it0] = buildSidebarItems(Object.values(resources.daemonsets), "daemonsets", "");
    expect(it0).toMatchObject({ statusText: "3/3", unhealthy: false, healthState: "running", selector: "app=fluentd", pod: null });
  });
  it("workload with zero replicas → stopped", () => {
    const scaled = [{ metadata: { name: "idle", namespace: "default" }, status: { readyReplicas: 0, replicas: 0 } }];
    expect(buildSidebarItems(scaled, "deployments", "")[0]).toMatchObject({ statusText: "0/0", healthState: "stopped" });
  });
  it("pod → phase as status, pod set, no selector; unhealthy when not Running", () => {
    const items = buildSidebarItems(Object.values(resources.pods), "pods", "");
    expect(items.map((i) => i.name)).toEqual(["web-abc", "web-def"]);
    expect(items[0]).toMatchObject({ statusText: "Running", unhealthy: false, healthState: "running", pod: "web-abc", selector: null });
    expect(items[1]).toMatchObject({ statusText: "CrashLoopBackOff", unhealthy: true, healthState: "degraded", pod: "web-def" });
  });
  it("search matches by name (case-insensitive)", () => {
    expect(buildSidebarItems(Object.values(resources.pods), "pods", "ABC").map((i) => i.name)).toEqual(["web-abc"]);
    expect(buildSidebarItems(Object.values(resources.pods), "pods", "zzz").length).toBe(0);
  });
  it("search matches by namespace", () => {
    // fluentd lives in kube-system → searching the namespace finds it.
    expect(buildSidebarItems(Object.values(resources.daemonsets), "daemonsets", "kube-system").map((i) => i.name)).toEqual(["fluentd"]);
  });
  it("empty kind → []", () => {
    expect(buildSidebarItems([], "statefulsets", "")).toEqual([]);
  });
});
