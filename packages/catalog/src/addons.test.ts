import { describe, it, expect } from "vitest";
import { CLUSTER_ADDONS, detectInstalled, buildHelmValues, extraManifestYaml, extraManifestEnabled, type ClusterAddon } from "./addons";

const byId = (id: string): ClusterAddon => {
  const a = CLUSTER_ADDONS.find((x) => x.id === id);
  if (!a) throw new Error(`no add-on ${id}`);
  return a;
};

describe("CLUSTER_ADDONS", () => {
  it("has the seed four with unique ids", () => {
    expect(CLUSTER_ADDONS.map((a) => a.id).sort()).toEqual(
      ["cert-manager", "descheduler", "ingress-nginx", "metrics-server"],
    );
  });
  it("every add-on declares detect + install; helm add-ons carry chart coordinates", () => {
    for (const a of CLUSTER_ADDONS) {
      expect(a.detect.namespace).toBeTruthy();
      expect(a.detect.name).toBeTruthy();
      if (a.install.mode === "helm") {
        expect(a.install.repoURL).toMatch(/^https?:\/\//);
        expect(a.install.chart).toBeTruthy();
        expect(a.install.releaseName).toBeTruthy();
        expect(a.install.namespace).toBeTruthy();
      }
    }
  });
});

describe("detectInstalled", () => {
  const workloads = [
    { kind: "deployments", namespace: "kube-system", name: "metrics-server" },
    { kind: "cronjobs", namespace: "kube-system", name: "descheduler" },
  ] as const;
  it("true when the add-on's workload is present", () => {
    expect(detectInstalled(byId("metrics-server"), [...workloads])).toBe(true);
    expect(detectInstalled(byId("descheduler"), [...workloads])).toBe(true);
  });
  it("false when absent", () => {
    expect(detectInstalled(byId("cert-manager"), [...workloads])).toBe(false);
    expect(detectInstalled(byId("ingress-nginx"), [])).toBe(false);
  });
  it("kind must match (a same-named Deployment is not the descheduler CronJob)", () => {
    expect(detectInstalled(byId("descheduler"), [
      { kind: "deployments", namespace: "kube-system", name: "descheduler" },
    ])).toBe(false);
  });
});

describe("buildHelmValues", () => {
  it("ingress-nginx maps the service type", () => {
    expect(buildHelmValues(byId("ingress-nginx"), { serviceType: "NodePort" })).toContain("type: NodePort");
  });
  it("descheduler runs as a CronJob with the schedule and only the enabled strategies", () => {
    const v = buildHelmValues(byId("descheduler"), {
      schedule: "0 * * * *", lowNodeUtilization: true, removeDuplicates: true, topologySpread: false,
    });
    const parsed = JSON.parse(v);
    expect(parsed.kind).toBe("CronJob");
    expect(parsed.schedule).toBe("0 * * * *");
    const balance = parsed.deschedulerPolicy.profiles[0].plugins.balance.enabled as string[];
    expect(balance).toContain("LowNodeUtilization");
    expect(balance).toContain("RemoveDuplicates");
    expect(balance).not.toContain("RemovePodsViolatingTopologySpreadConstraint");
    const lnu = (parsed.deschedulerPolicy.profiles[0].pluginConfig as { name: string; args?: { targetThresholds?: unknown } }[])
      .find((p) => p.name === "LowNodeUtilization");
    expect(lnu?.args?.targetThresholds).toBeTruthy();
  });
  it("cert-manager CRDs follow the installCRDs toggle", () => {
    expect(buildHelmValues(byId("cert-manager"), { installCRDs: true })).toContain("enabled: true");
    expect(buildHelmValues(byId("cert-manager"), { installCRDs: false })).toContain("enabled: false");
  });
});

describe("extra manifest (descheduler node-watcher)", () => {
  it("descheduler carries a node-watcher manifest gated by nodeWatcher; other add-ons have none", () => {
    const yaml = extraManifestYaml(byId("descheduler"));
    expect(yaml).toBeTruthy();
    // substituted with the install namespace + CronJob name, and the watch trigger
    expect(yaml).toContain("namespace: kube-system");
    expect(yaml).toContain("cronjob/descheduler");
    expect(yaml).toContain("kubectl get nodes --watch-only");
    expect(yaml).toContain("kind: ClusterRole");
    expect(yaml).not.toContain("{{");
    expect(extraManifestYaml(byId("metrics-server"))).toBeNull();
    expect(extraManifestYaml(byId("cert-manager"))).toBeNull();
  });
  it("is enabled only when the gate field is on", () => {
    expect(extraManifestEnabled(byId("descheduler"), { nodeWatcher: true })).toBe(true);
    expect(extraManifestEnabled(byId("descheduler"), { nodeWatcher: false })).toBe(false);
    expect(extraManifestEnabled(byId("descheduler"), {})).toBe(false);
    expect(extraManifestEnabled(byId("cert-manager"), { nodeWatcher: true })).toBe(false);
  });
});
