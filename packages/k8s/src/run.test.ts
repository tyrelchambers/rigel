import { test, expect } from "bun:test";
import { buildKubectlArgs } from "./run";

test("prepends --context when provided", () => {
  expect(buildKubectlArgs("kind-test", ["get", "pods", "-n", "default"]))
    .toEqual(["--context", "kind-test", "get", "pods", "-n", "default"]);
});

test("omits --context when null", () => {
  expect(buildKubectlArgs(null, ["get", "pods"])).toEqual(["get", "pods"]);
});
