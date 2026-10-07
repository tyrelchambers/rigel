import { test, expect, describe } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { guardExecArgs, guardVerdict, runGuard, provisionGuardBin, wrapperScript } from "./guardedKubectl";

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
    expect(guardVerdict("kubectl", ["get", "pods"]).decision).toBe("allow");
    expect(guardVerdict("kubectl", ["rollout", "status", "deploy/x"]).decision).toBe("allow");
  });

  test("cluster mutations are denied with the action-block hint", () => {
    const v = guardVerdict("kubectl", ["delete", "pod", "x"]);
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/action block/i);
  });

  test("helm mutations are denied", () => {
    expect(guardVerdict("helm", ["install", "affine", "./chart"]).decision).toBe("deny");
  });

  test("a mutation pinned to another context is still denied (generic action-block hint, no cross-context special-casing)", () => {
    // Cross-context denial is out of scope for the shim: a mutation is denied either
    // way, so the reason is the generic action-block steering hint, NOT a
    // cross-context-specific message.
    const v = guardVerdict("kubectl", ["--context", "other-cluster", "delete", "pod", "x"]);
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/action block|approve/i);
  });
});

describe("guardVerdict ssh", () => {
  test("allows a read on an enabled host", () => {
    expect(guardVerdict("ssh", ["web-1", "uptime"], ["web-1"]).decision).toBe("allow");
  });

  test("classifies exact argv, so a quoted redirect stays remote", () => {
    expect(guardVerdict("ssh", ["web-1", "cat x > /etc/y"], ["web-1"]).decision).toBe("deny");
  });

  test("denies a host that is not enabled", () => {
    expect(guardVerdict("ssh", ["web-1", "uptime"], []).decision).toBe("deny");
  });

  test.each(["scp", "sftp", "rsync", "sshfs", "sshpass", "autossh", "mosh"])("always denies %s", (name) => {
    expect(guardVerdict(name, ["web-1:/x", "."], ["web-1"]).decision).toBe("deny");
  });

  test("leaves kubectl behaviour unchanged", () => {
    expect(guardVerdict("kubectl", ["get", "pods"]).decision).toBe("allow");
  });
});

describe("guardExecArgs", () => {
  test("forces batch mode and no tty for ssh", () => {
    expect(guardExecArgs("ssh", ["web-1", "uptime"])).toEqual(["-T", "-o", "BatchMode=yes", "web-1", "uptime"]);
  });

  test("passes kubectl args through", () => {
    expect(guardExecArgs("kubectl", ["get", "pods"])).toEqual(["get", "pods"]);
  });
});

describe("runGuard — dispatch (fake real binary = /bin/echo, never a cluster)", () => {
  test("allowed read execs the real binary and forwards exit 0", async () => {
    // Drive the shim entry as a real subprocess: kubectl → /bin/echo get pods.
    const r = await runEntry(["kubectl", "/bin/echo", "", "get", "pods"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("get pods");
  });

  test("denied mutation does NOT exec the real binary; stderr carries the steering hint", async () => {
    const r = await runEntry(["kubectl", "/bin/echo", "", "delete", "pod", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/action block/i);
    expect(r.stdout).not.toContain("delete"); // echo never ran
  });

  test("an ssh read on an enabled host execs the real binary in batch mode", async () => {
    const r = await runEntry(["ssh", "/bin/echo", "web-1", "web-1", "uptime"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("-T -o BatchMode=yes web-1 uptime");
  });

  test("an ssh change is denied without exec and steers to an sshCommand action", async () => {
    const r = await runEntry(["ssh", "/bin/echo", "web-1", "web-1", "rm x"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/sshCommand/);
    expect(r.stdout).toBe("");
  });

  test("the enabled hosts come only from the baked argv slot, never the environment", async () => {
    const r = await runEntry(["ssh", "/bin/echo", "web-1", "not-enabled", "cat /etc/shadow"], {
      RIGEL_SSH_HOSTS: "not-enabled",
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("not-enabled");
  });

  test("runGuard rejects malformed argv (no real binary or no hosts slot)", async () => {
    expect(await runGuard(["kubectl"])).toBe(2);
    expect(await runGuard(["kubectl", "/bin/echo"])).toBe(2);
  });
});

describe("provisionGuardBin — materializes executable wrappers", () => {
  test("writes an executable kubectl wrapper referencing the real binary + guard entry", async () => {
    const dir = await provisionGuardBin(["web-1", "nas"]);
    const entries = await readdir(dir);
    expect(entries).toContain("kubectl");

    const kubectlPath = join(dir, "kubectl");
    const info = await stat(kubectlPath);
    // executable bit set (0o111 mask)
    expect(info.mode & 0o111).not.toBe(0);

    const text = await readFile(kubectlPath, "utf8");
    expect(text).toContain("kubectl"); // logical name
    expect(text).toContain("guardedKubectl"); // guard entry referenced via the runner
    // runner + single-quoted logical name, real abs path and enabled hosts.
    expect(text).toMatch(/exec .*'kubectl' '\/.*kubectl' 'web-1,nas' "\$@"/);
  });

  test("wraps helm too when helm is installed (skipped otherwise)", async () => {
    const dir = await provisionGuardBin([]);
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

describe("wrapperScript — spaced install paths don't word-split (packaged macOS)", () => {
  // Default runner: `node --import tsx '<entry>'` with the entry single-quoted.
  const realRunner = `node --import tsx '${GUARD_ENTRY}'`;

  test("single-quotes logicalName + realBinaryPath in the generated string", () => {
    const spaced = "/Applications/My App.app/Contents/Resources/kubectl";
    const text = wrapperScript(realRunner, "kubectl", spaced, []);
    expect(text).toContain(`'kubectl' '${spaced}' ''`);
    expect(text).toMatch(/"\$@"\s*$/m); // "$@" preserved verbatim
  });

  test("a wrapper targeting a binary under a SPACED dir actually execs it on a read", async () => {
    // Fake "real binary" in a directory whose name contains a space. It echoes its
    // argv so we can prove it ran (no real cluster, no kubectl involved).
    const base = await mkdtemp(join(tmpdir(), "rigel-guard-spaced-"));
    const spacedDir = join(base, "Application Support");
    await mkdir(spacedDir, { recursive: true });
    const fakeBin = join(spacedDir, "fake-kubectl");
    await writeFile(fakeBin, `#!/bin/sh\necho "FAKE-RAN: $*"\n`);
    await chmod(fakeBin, 0o755);

    // Generate the wrapper the SAME way the code does, then write + run it.
    const wrapperPath = join(base, "kubectl");
    await writeFile(wrapperPath, wrapperScript(realRunner, "kubectl", fakeBin, []));
    await chmod(wrapperPath, 0o755);

    const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(wrapperPath, ["get", "pods"], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });

    // No word-splitting on the spaced path: the fake binary ran with the read args.
    expect(r.stderr).not.toMatch(/No such file|not found|cannot/i);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("FAKE-RAN: get pods");
  });

  test("bakes the enabled hosts, escaping a single quote and dropping a comma alias", () => {
    const text = wrapperScript(realRunner, "ssh", "/usr/bin/ssh", ["web-1", "o'brien", "a,b"]);
    expect(text).toContain(`'ssh' '/usr/bin/ssh' 'web-1,o'\\''brien' "$@"`);
  });

  test("a built ssh wrapper ignores RIGEL_SSH_HOSTS from the agent's shell", async () => {
    const base = await mkdtemp(join(tmpdir(), "rigel-guard-hosts-"));
    const wrapperPath = join(base, "ssh");
    await writeFile(wrapperPath, wrapperScript(realRunner, "ssh", "/bin/echo", ["web-1"]));
    await chmod(wrapperPath, 0o755);
    const run = (args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(wrapperPath, args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, RIGEL_SSH_HOSTS: "not-enabled" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });

    const blocked = await run(["not-enabled", "cat /etc/shadow"]);
    expect(blocked.code).toBe(1);
    expect(blocked.stdout).toBe("");

    const allowed = await run(["web-1", "uptime"]);
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toContain("-T -o BatchMode=yes web-1 uptime");
  });
});
