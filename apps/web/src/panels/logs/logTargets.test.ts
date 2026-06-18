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
    const [it0] = buildSidebarItems(resources, "deployments", "");
    expect(it0).toMatchObject({
      key: "default/web", name: "web", namespace: "default",
      statusText: "1/2", unhealthy: true, selector: "app=web", pod: null,
    });
  });
  it("daemonset → numberReady/desired", () => {
    const [it0] = buildSidebarItems(resources, "daemonsets", "");
    expect(it0).toMatchObject({ statusText: "3/3", unhealthy: false, selector: "app=fluentd", pod: null });
  });
  it("pod → phase as status, pod set, no selector; unhealthy when not Running", () => {
    const items = buildSidebarItems(resources, "pods", "");
    expect(items.map((i) => i.name)).toEqual(["web-abc", "web-def"]);
    expect(items[0]).toMatchObject({ statusText: "Running", unhealthy: false, pod: "web-abc", selector: null });
    expect(items[1]).toMatchObject({ statusText: "CrashLoopBackOff", unhealthy: true, pod: "web-def" });
  });
  it("search filters by name/namespace (case-insensitive)", () => {
    expect(buildSidebarItems(resources, "pods", "DEF").map((i) => i.name)).toEqual(["web-def"]);
    expect(buildSidebarItems(resources, "pods", "kube").length).toBe(0);
  });
  it("empty kind → []", () => {
    expect(buildSidebarItems(resources, "statefulsets", "")).toEqual([]);
  });
});
