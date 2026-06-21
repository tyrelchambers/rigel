import { test, expect } from "vitest";
import {
  validateClusterName, buildKindCreateArgs, buildK3dCreateArgs,
  buildKindDeleteArgs, buildK3dDeleteArgs, toolForContext, K8S_VERSIONS,
} from "./clusterCreate";

test("validateClusterName accepts dns-ish names, rejects bad ones", () => {
  expect(validateClusterName("dev")).toBeNull();
  expect(validateClusterName("my-cluster-1")).toBeNull();
  expect(validateClusterName("")).toMatch(/name/i);
  expect(validateClusterName("Dev")).toMatch(/lower/i);
  expect(validateClusterName("-bad")).toBeTruthy();
  expect(validateClusterName("a".repeat(60))).toMatch(/long/i);
});

test("K8S_VERSIONS has a default (no image) entry plus pinned versions per tool", () => {
  const def = K8S_VERSIONS.find((v) => v.id === "default");
  expect(def).toBeTruthy();
  expect(def!.kindImage).toBeNull();
  expect(def!.k3dImage).toBeNull();
  const pinned = K8S_VERSIONS.filter((v) => v.id !== "default");
  expect(pinned.length).toBeGreaterThanOrEqual(3);
  for (const v of pinned) {
    expect(v.kindImage).toMatch(/^kindest\/node:/);
    expect(v.k3dImage).toMatch(/^rancher\/k3s:/);
  }
});

test("buildKindCreateArgs adds --name and the node image for a pinned version", () => {
  expect(buildKindCreateArgs("dev", "default")).toEqual(["create", "cluster", "--name", "dev"]);
  const v = K8S_VERSIONS.find((x) => x.id !== "default")!;
  expect(buildKindCreateArgs("dev", v.id)).toEqual(["create", "cluster", "--name", "dev", "--image", v.kindImage]);
});

test("buildK3dCreateArgs uses the k3s image for a pinned version", () => {
  expect(buildK3dCreateArgs("dev", "default")).toEqual(["cluster", "create", "dev"]);
  const v = K8S_VERSIONS.find((x) => x.id !== "default")!;
  expect(buildK3dCreateArgs("dev", v.id)).toEqual(["cluster", "create", "dev", "--image", v.k3dImage]);
});

test("delete arg builders", () => {
  expect(buildKindDeleteArgs("dev")).toEqual(["delete", "cluster", "--name", "dev"]);
  expect(buildK3dDeleteArgs("dev")).toEqual(["cluster", "delete", "dev"]);
});

test("toolForContext maps kind-/k3d- context names back to the tool + cluster name", () => {
  expect(toolForContext("kind-dev")).toEqual({ tool: "kind", name: "dev" });
  expect(toolForContext("k3d-test")).toEqual({ tool: "k3d", name: "test" });
  expect(toolForContext("default")).toBeNull();
  expect(toolForContext("gke_p_z_c")).toBeNull();
});
