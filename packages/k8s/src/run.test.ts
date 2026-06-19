import { test, expect } from "vitest";
import { buildKubectlArgs, runProcess, runProcessWithStdin } from "./run";

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

// runProcess — Node child_process implementation

test("runProcess runs a command and returns stdout and exit code 0", async () => {
  const result = await runProcess("printf", ["hello"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("hello");
});

test("runProcess resolves with code -1 and non-empty stderr for a non-existent binary", async () => {
  const result = await runProcess("definitely-not-a-real-binary-xyz", []);
  expect(result.code).toBe(-1);
  expect(result.stderr.length).toBeGreaterThan(0);
});

// runProcessWithStdin — stdin-piped variant

test("runProcessWithStdin pipes input to the process and returns stdout", async () => {
  const result = await runProcessWithStdin("cat", [], "piped-input");
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("piped-input");
});

// EPIPE guard: a child that exits immediately without reading stdin must not
// crash the process — runProcessWithStdin must resolve with a numeric code.
test("runProcessWithStdin resolves (EPIPE guard) when child exits before draining a large stdin", async () => {
  const result = await runProcessWithStdin("sh", ["-c", "exit 0"], "x".repeat(1024 * 1024));
  expect(typeof result.code).toBe("number");
});
