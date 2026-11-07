import { beforeEach, describe, expect, test, vi } from "vitest";

const kubectlMock = vi.hoisted(() => vi.fn());
vi.mock("./kubectl.js", () => ({
  kubectl: (...args: unknown[]) => kubectlMock(...args),
  getManifestYaml: vi.fn(async () => "kind: Pod"),
}));

import { executeAction } from "./executor.js";

const podJson = (apiVersion: string, kind: string) =>
  JSON.stringify({ metadata: { name: "postgres-25", ownerReferences: [{ apiVersion, kind, name: "postgres" }] } });

describe("executeAction pod-deletion guard", () => {
  beforeEach(() => kubectlMock.mockReset());

  test("refuses to delete a database pod owned by an operator", async () => {
    kubectlMock.mockResolvedValueOnce({ code: 0, stdout: podJson("postgresql.cnpg.io/v1", "Cluster"), stderr: "" });
    const r = await executeAction({ kind: "deletePod", pod: "postgres-25", namespace: "default", label: "Delete postgres-25" });
    expect(r.success).toBe(false);
    expect(r.blocked).toContain("Cluster postgres");
    expect(r.commands).toEqual([]);
    expect(kubectlMock).toHaveBeenCalledTimes(1);
  });

  test("covers raw delete commands too", async () => {
    kubectlMock.mockResolvedValueOnce({ code: 0, stdout: podJson("postgresql.cnpg.io/v1", "Cluster"), stderr: "" });
    const r = await executeAction({ kind: "command", args: ["delete", "pod", "postgres-25", "-n", "default"], label: "x" });
    expect(r.blocked).toBeTruthy();
  });

  test("fails closed when the pod can't be read", async () => {
    kubectlMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "forbidden" });
    const r = await executeAction({ kind: "deletePod", pod: "x", namespace: "default", label: "x" });
    expect(r.blocked).toContain("forbidden");
  });

  test("deletes a pod owned by a ReplicaSet", async () => {
    kubectlMock
      .mockResolvedValueOnce({ code: 0, stdout: podJson("apps/v1", "ReplicaSet"), stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "pod deleted", stderr: "" });
    const r = await executeAction({ kind: "deletePod", pod: "api-abc", namespace: "default", label: "x" });
    expect(r.success).toBe(true);
    expect(r.blocked).toBeUndefined();
    expect(kubectlMock).toHaveBeenLastCalledWith(["delete", "pod", "api-abc", "-n", "default"]);
  });
});
