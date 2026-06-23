import { test, expect, describe } from "vitest";
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { guardVerdict, runGuard, provisionGuardBin, wrapperScript } from "./guardedKubectl.js";

const GUARD_ENTRY = fileURLToPath(new URL("./guardedKubectl.ts", import.meta.url));

function runEntry(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", GUARD_ENTRY, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("guardVerdict — pure policy decisions", () => {
  test("plain reads are allowed", () => {
    expect(guardVerdict("kubectl", ["get", "pods"]).decision).toBe("allow");
  });
  test("cluster mutations are denied", () => {
    expect(guardVerdict("kubectl", ["delete", "pod", "x"]).decision).toBe("deny");
  });
  test("helm mutations are denied", () => {
    expect(guardVerdict("helm", ["install", "x", "./c"]).decision).toBe("deny");
  });
});

describe("runGuard — dispatch (fake real binary = /bin/echo, never a cluster)", () => {
  test("allowed read execs the real binary and forwards exit 0", async () => {
    const r = await runEntry(["kubectl", "/bin/echo", "get", "pods"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("get pods");
  });
  test("denied mutation does NOT exec the real binary; stderr carries the reason", async () => {
    const r = await runEntry(["kubectl", "/bin/echo", "delete", "pod", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/action block|cluster/i);
    expect(r.stdout).not.toContain("delete");
  });
  test("runGuard rejects malformed argv", async () => {
    expect(await runGuard(["kubectl"])).toBe(2);
  });
});

describe("provisionGuardBin — materializes executable wrappers", () => {
  test("writes an executable kubectl wrapper referencing the real binary + guard entry", async () => {
    const dir = await provisionGuardBin();
    const entries = await readdir(dir);
    expect(entries).toContain("kubectl");
    const info = await stat(join(dir, "kubectl"));
    expect(info.mode & 0o111).not.toBe(0);
    const text = await readFile(join(dir, "kubectl"), "utf8");
    expect(text).toContain("guardedKubectl");
    expect(text).toMatch(/exec .*'kubectl' '\/.*kubectl' "\$@"/);
  });
});

describe("wrapperScript", () => {
  const runner = `node --import tsx '${GUARD_ENTRY}'`;
  test("single-quotes logicalName + realBinaryPath", () => {
    const text = wrapperScript(runner, "kubectl", "/usr/local/bin/kubectl");
    expect(text).toContain(`'kubectl' '/usr/local/bin/kubectl'`);
    expect(text).toMatch(/"\$@"\s*$/m);
  });
});
