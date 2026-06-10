import { describe, it, expect } from "vitest";
import { isPurgeableNamespace, groupDeploymentsByNamespace } from "./pickerLogic";
import type { Deployment } from "@/panels/deployments/types";

const dep = (name: string, namespace: string): Deployment => ({
  metadata: { name, namespace },
});

describe("isPurgeableNamespace", () => {
  it("rejects protected namespaces (exact + prefix)", () => {
    expect(isPurgeableNamespace("kube-system")).toBe(false);
    expect(isPurgeableNamespace("cert-manager")).toBe(false);
    expect(isPurgeableNamespace("cnpg-system")).toBe(false);
    expect(isPurgeableNamespace("cattle-fleet")).toBe(false);
    expect(isPurgeableNamespace("calico-system")).toBe(false);
  });

  it("allows ordinary namespaces", () => {
    expect(isPurgeableNamespace("default")).toBe(true);
    expect(isPurgeableNamespace("apps")).toBe(true);
  });
});

describe("groupDeploymentsByNamespace", () => {
  const deps = [
    dep("memos", "default"),
    dep("paperless", "default"),
    dep("grafana", "monitoring"),
  ];

  it("groups by namespace, sorted, no search", () => {
    const groups = groupDeploymentsByNamespace(deps, "");
    expect(groups.map((g) => g.namespace)).toEqual(["default", "monitoring"]);
    expect(groups[0].deployments).toEqual(["memos", "paperless"]);
  });

  it("filters by case-insensitive name substring", () => {
    const groups = groupDeploymentsByNamespace(deps, "MEM");
    const withDeps = groups.filter((g) => g.deployments.length > 0);
    expect(withDeps).toHaveLength(1);
    expect(withDeps[0].deployments).toEqual(["memos"]);
  });

  it("filters by namespace substring", () => {
    const groups = groupDeploymentsByNamespace(deps, "monitor");
    const withDeps = groups.filter((g) => g.deployments.length > 0);
    expect(withDeps).toHaveLength(1);
    expect(withDeps[0].namespace).toBe("monitoring");
  });
});
