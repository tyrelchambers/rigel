import { test, expect } from "bun:test";
import { resolveKubeconfigPath } from "./kubeconfig";

test("prefers KUBECONFIG env over default", () => {
  expect(resolveKubeconfigPath({ KUBECONFIG: "/mnt/kc" }, "/home/u")).toBe("/mnt/kc");
});

test("falls back to ~/.kube/config", () => {
  expect(resolveKubeconfigPath({}, "/home/u")).toBe("/home/u/.kube/config");
});
