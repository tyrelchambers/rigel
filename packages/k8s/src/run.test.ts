import { mkdtemp } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// runProcess env override

test("runProcess inherits process.env when no opts given", async () => {
  process.env.RIGEL_RUN_TEST = "inherited";
  const r = await runProcess(process.execPath, ["-e", "process.stdout.write(process.env.RIGEL_RUN_TEST ?? '')"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("inherited");
  delete process.env.RIGEL_RUN_TEST;
});

test("runProcess uses a provided env", async () => {
  const r = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write(process.env.RIGEL_RUN_TEST ?? 'MISSING')"],
    { env: { ...process.env, RIGEL_RUN_TEST: "provided" } },
  );
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("provided");
});

test("runProcess stdoutFile writes bytes and leaves result.stdout empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rigel-run-"));
  const out = join(dir, "out.bin");
  const r = await runProcess(process.execPath, ["-e", "process.stdout.write(Buffer.from([0,255,10]))"], {
    stdoutFile: out,
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(readFileSync(out)).toEqual(Buffer.from([0, 255, 10]));
});

test("runProcess stdinFile feeds the child without collecting those bytes as the command string", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rigel-run-"));
  const inp = join(dir, "in.bin");
  writeFileSync(inp, Buffer.from([1, 2, 3, 4]));
  const r = await runProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { stdinFile: inp });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("\u0001\u0002\u0003\u0004");
});
