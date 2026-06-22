import { test, expect, describe } from "vitest";
import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { guardVerdict, runGuard, provisionGuardBin } from "./guardedKubectl";

// Absolute path to the guard entry, resolved next to this test so the real
// subprocess tests work in dev (tsx) regardless of cwd. Nothing here EVER touches
// a real cluster: dispatch tests use /bin/echo as the "real" binary.
const GUARD_ENTRY = fileURLToPath(new URL("./guardedKubectl.ts", import.meta.url));

/** Run `node --import tsx guardedKubectl.ts <argv…>` and capture stdout/stderr/code. */
function runEntry(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", GUARD_ENTRY, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("guardVerdict — pure policy decisions (reuses classifyCommand)", () => {
  test("plain reads are allowed", () => {
    expect(guardVerdict("kubectl", ["get", "pods"], null).decision).toBe("allow");
    expect(guardVerdict("kubectl", ["rollout", "status", "deploy/x"], null).decision).toBe("allow");
  });

  test("cluster mutations are denied with the action-block hint", () => {
    const v = guardVerdict("kubectl", ["delete", "pod", "x"], null);
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/action block/i);
  });

  test("helm mutations are denied", () => {
    expect(guardVerdict("helm", ["install", "affine", "./chart"], null).decision).toBe("deny");
  });

  test("a mutation pinned to a DIFFERENT context is denied with a cross-context reason", () => {
    const v = guardVerdict("kubectl", ["--context", "other-cluster", "delete", "pod", "x"], "myctx");
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/different context/i);
  });
});

describe("runGuard — dispatch (fake real binary = /bin/echo, never a cluster)", () => {
  test("allowed read execs the real binary and forwards exit 0", async () => {
    // Drive the shim entry as a real subprocess: kubectl → /bin/echo get pods.
    const r = await runEntry(["kubectl", "/bin/echo", "get", "pods"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("get pods");
  });

  test("denied mutation does NOT exec the real binary; stderr carries the steering hint", async () => {
    const r = await runEntry(["kubectl", "/bin/echo", "delete", "pod", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/action block/i);
    expect(r.stdout).not.toContain("delete"); // echo never ran
  });

  test("cross-context env steers the deny reason", async () => {
    const r = await runEntry(
      ["kubectl", "/bin/echo", "--context", "other", "delete", "pod", "x"],
      { KUBECONFIG_CONTEXT: "myctx" },
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/different context/i);
    expect(r.stdout).not.toContain("delete");
  });

  test("runGuard rejects malformed argv (no real binary)", async () => {
    expect(await runGuard(["kubectl"])).toBe(2);
  });
});

describe("provisionGuardBin — materializes executable wrappers", () => {
  test("writes an executable kubectl wrapper referencing the real binary + guard entry", async () => {
    const dir = await provisionGuardBin();
    const entries = await readdir(dir);
    expect(entries).toContain("kubectl");

    const kubectlPath = join(dir, "kubectl");
    const info = await stat(kubectlPath);
    // executable bit set (0o111 mask)
    expect(info.mode & 0o111).not.toBe(0);

    const text = await readFile(kubectlPath, "utf8");
    expect(text).toContain("kubectl"); // logical name
    expect(text).toContain("guardedKubectl"); // guard entry referenced via the runner
    expect(text).toMatch(/exec .*kubectl .*\/.*kubectl/); // runner + logical + real abs path
  });

  test("wraps helm too when helm is installed (skipped otherwise)", async () => {
    const dir = await provisionGuardBin();
    const entries = await readdir(dir);
    const helmInstalled = await new Promise<boolean>((resolve) => {
      const c = spawn("/bin/sh", ["-c", "command -v helm"], { stdio: "ignore" });
      c.on("error", () => resolve(false));
      c.on("exit", (code) => resolve(code === 0));
    });
    if (helmInstalled) {
      expect(entries).toContain("helm");
      const text = await readFile(join(dir, "helm"), "utf8");
      expect(text).toContain("guardedKubectl");
    } else {
      expect(entries).not.toContain("helm");
    }
  });
});
