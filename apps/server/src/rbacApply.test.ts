import { describe, test, expect, vi } from "vitest";
import { applyPolicy, clusterRoleOnly } from "./rbacApply";
import { DEFAULT_POLICY, setCapability } from "@rigel/k8s";

test("clusterRoleOnly extracts just the ClusterRole document", () => {
  const doc = clusterRoleOnly(DEFAULT_POLICY);
  expect(doc).toMatch(/kind: ClusterRole/);
  expect(doc).not.toMatch(/kind: ServiceAccount/);
  expect(doc).not.toMatch(/kind: ClusterRoleBinding/);
});

test("applyPolicy applies the ClusterRole to each target context", async () => {
  const apply = vi.fn(async () => ({ code: 0, stdout: "configured", stderr: "" }));
  const res = await applyPolicy({ policy: setCapability(DEFAULT_POLICY, "drain", true), contexts: ["ctx-a", "ctx-b"] }, { apply });
  expect(apply).toHaveBeenCalledTimes(2);
  expect(apply.mock.calls[0][0]).toBe("ctx-a");
  expect(apply.mock.calls[0][1]).toMatch(/pods\/eviction/);
  expect(res.applied).toEqual(["ctx-a", "ctx-b"]);
});
