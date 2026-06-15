import { test, expect } from "bun:test";
import { buildKubectlArgs } from "./run";

test("prepends --context when provided", () => {
  expect(buildKubectlArgs("kind-test", ["get", "pods", "-n", "default"]))
    .toEqual(["--context", "kind-test", "get", "pods", "-n", "default"]);
});

test("omits --context when null", () => {
  expect(buildKubectlArgs(null, ["get", "pods"])).toEqual(["get", "pods"]);
});

test("inserts --context AFTER a plugin name (cnpg) — kubectl rejects it before", () => {
  expect(buildKubectlArgs("kind-test", ["cnpg", "backup", "pg", "-n", "db"]))
    .toEqual(["cnpg", "--context", "kind-test", "backup", "pg", "-n", "db"]);
});

test("plugin context insertion is a no-op when context is null", () => {
  expect(buildKubectlArgs(null, ["cnpg", "version"])).toEqual(["cnpg", "version"]);
});

test("inserts --context AFTER the cert-manager plugin name", () => {
  expect(buildKubectlArgs("kind-test", ["cert-manager", "renew", "app-tls", "-n", "default"]))
    .toEqual(["cert-manager", "--context", "kind-test", "renew", "app-tls", "-n", "default"]);
});
