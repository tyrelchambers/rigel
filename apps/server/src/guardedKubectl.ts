#!/usr/bin/env node
// Portable "guarded kubectl/helm" shim for non-Claude agent runners (Codex, etc.).
//
// The Claude runner enforces the read-only / approve-mutations policy with a
// PreToolUse hook (permissionHook.ts). Other CLIs (Codex) have no such hook, so we
// enforce the SAME policy by placing wrapper scripts named `kubectl`/`helm` FIRST
// on the agent subprocess's PATH (see provisionGuardBin). Every kubectl/helm the
// agent — or any child like `sh -c …`, `xargs kubectl …` — execs resolves to this
// shim, which classifies the invocation via commandPolicy.classifyCommand: reads
// run against the real binary, cluster MUTATIONS are denied (with the steering hint
// that tells the model to raise an action block). This module is reused by every
// future non-Claude runner — it adds NO policy of its own.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyCommand, type CommandVerdict } from "./commandPolicy";

/**
 * Pure decision core. Reconstructs the command the agent asked to run as
 * `[logicalName, ...userArgs].join(" ")` and defers to the shared policy. The
 * reconstruction is safe here because the shim only ever receives ONE already-split
 * invocation (no pipes/chains across argv), and the policy biases to deny on any
 * kubectl/helm mutation token regardless of exact spacing.
 *
 * Note: per-cluster (cross-context) denial is intentionally OUT OF SCOPE here. A
 * cluster mutation is denied either way, so cross-context awareness would only change
 * the human-readable reason. Once the multi-cluster cross-context policy lands on
 * master's classifyCommand, this becomes a one-line change (thread the active context
 * through to classifyCommand).
 */
export function guardVerdict(logicalName: string, userArgs: string[]): CommandVerdict {
  const cmd = [logicalName, ...userArgs].join(" ");
  return classifyCommand(cmd);
}

/**
 * Shim entry. argv layout = `[logicalName, realBinaryPath, ...userArgs]`:
 *   - logicalName: "kubectl" | "helm" (what the agent typed),
 *   - realBinaryPath: absolute path to the genuine binary (resolved at provision time).
 * Allowed reads exec the real binary (stdio inherited, exit code forwarded); denied
 * mutations write the steering reason to stderr and exit 1 WITHOUT running anything.
 */
export function runGuard(argv: string[]): Promise<number> {
  const [logicalName, realBinaryPath, ...userArgs] = argv;
  if (!logicalName || !realBinaryPath) {
    process.stderr.write(
      "guarded-kubectl: usage: <logicalName> <realBinaryPath> [args…]\n",
    );
    return Promise.resolve(2);
  }

  const verdict = guardVerdict(logicalName, userArgs);
  if (verdict.decision === "deny") {
    process.stderr.write(verdict.reason + "\n");
    return Promise.resolve(1);
  }

  return new Promise<number>((resolve) => {
    const child = spawn(realBinaryPath, userArgs, { stdio: "inherit" });
    child.on("error", (err) => {
      process.stderr.write(`guarded-kubectl: failed to exec ${realBinaryPath}: ${err.message}\n`);
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      // Forward the child's exit code; map a fatal signal to the conventional 128+n.
      if (signal) resolve(128 + (osSignalNumber(signal) ?? 0));
      else resolve(code ?? 0);
    });
  });
}

/** POSIX signal name → number for the 128+n exit convention (best-effort). */
function osSignalNumber(signal: NodeJS.Signals): number | undefined {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15,
  };
  return table[signal];
}

// ── Provisioning ───────────────────────────────────────────────────────────

/**
 * The command that runs the guard entry, mirroring permissionHookSettings() in
 * claudeBridge.ts. Dev/Docker default: run THIS .ts via Node + tsx, resolved next
 * to this bundle. The packaged desktop app has no node/tsx on PATH, so it must set
 * RIGEL_GUARD_CMD to run a prebuilt .mjs guard via Electron-as-node — exactly like
 * HELMSMAN_HOOK_CMD does for the hook. (Desktop packaging is NOT done here.)
 */
function guardRunnerCommand(): string {
  const entry = fileURLToPath(new URL("./guardedKubectl.ts", import.meta.url));
  return process.env.RIGEL_GUARD_CMD || `node --import tsx ${entry}`;
}

/** Resolve the real absolute path of a binary on the CURRENT PATH (no shim yet). */
async function whichBinary(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    // `command -v` is the portable resolver; the shim dir isn't on PATH yet here.
    const child = spawn("/bin/sh", ["-c", `command -v ${name}`], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}

/** One wrapper script: exec the guard entry with (logicalName, realBinaryPath, "$@"). */
function wrapperScript(runner: string, logicalName: string, realBinaryPath: string): string {
  return `#!/bin/sh
# Auto-generated guarded shim for \`${logicalName}\` — routes through Rigel's command
# policy (apps/server/src/guardedKubectl.ts). Reads run; cluster mutations are denied.
exec ${runner} ${logicalName} ${realBinaryPath} "$@"
`;
}

/**
 * Materialize the guarded shim dir. Writes executable `kubectl` (and `helm` if it's
 * installed) wrappers into a fresh OS-temp dir (NOT inside any workspace). The Codex
 * runner prepends the returned dir to its subprocess PATH so every kubectl/helm the
 * agent execs resolves to a wrapper. Throws if kubectl can't be found — without it
 * there's nothing to guard. helm is optional and only wrapped when present.
 */
export async function provisionGuardBin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rigel-guard-"));
  const runner = guardRunnerCommand();

  const kubectlReal = await whichBinary("kubectl");
  if (!kubectlReal) {
    throw new Error(
      "guarded-kubectl: `kubectl` was not found on PATH — cannot provision the guarded shim.",
    );
  }
  await writeWrapper(dir, runner, "kubectl", kubectlReal);

  const helmReal = await whichBinary("helm");
  if (helmReal) await writeWrapper(dir, runner, "helm", helmReal);

  return dir;
}

async function writeWrapper(
  dir: string,
  runner: string,
  logicalName: string,
  realBinaryPath: string,
): Promise<void> {
  const path = join(dir, logicalName);
  await writeFile(path, wrapperScript(runner, logicalName, realBinaryPath));
  await chmod(path, 0o755);
}

// Run as the shim only when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runGuard(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`guarded-kubectl: ${err?.message ?? err}\n`);
      process.exit(1);
    },
  );
}
