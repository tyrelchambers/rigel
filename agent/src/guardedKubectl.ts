#!/usr/bin/env node
// Portable "guarded kubectl/helm" shim for the agent's non-Claude provider
// bridges. Claude enforces read-only with --allowedTools; the other CLIs have no
// such hook, so we enforce the SAME policy by placing wrapper scripts named
// `kubectl`/`helm` FIRST on the provider subprocess's PATH (see provisionGuardBin).
// Every kubectl/helm the model — or any child like `sh -c …` — execs resolves to
// this shim, which classifies via commandPolicy.classifyCommand: reads run against
// the real binary, cluster MUTATIONS are denied. Ported from apps/server.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyCommand, type CommandVerdict } from "./commandPolicy.js";

/** Pure decision core: reconstruct `[logicalName, ...userArgs]` and defer to policy. */
export function guardVerdict(logicalName: string, userArgs: string[]): CommandVerdict {
  return classifyCommand([logicalName, ...userArgs].join(" "));
}

/**
 * Shim entry. argv layout = `[logicalName, realBinaryPath, ...userArgs]`.
 * Allowed reads exec the real binary (stdio inherited, exit code forwarded);
 * denied mutations write the reason to stderr and exit 1 WITHOUT running anything.
 */
export function runGuard(argv: string[]): Promise<number> {
  const [logicalName, realBinaryPath, ...userArgs] = argv;
  if (!logicalName || !realBinaryPath) {
    process.stderr.write("guarded-kubectl: usage: <logicalName> <realBinaryPath> [args…]\n");
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

/**
 * The command that runs the guard entry. Dev/test default: run this .ts via Node +
 * tsx, resolved next to this module. In the built image, RIGEL_AGENT_GUARD_CMD can
 * override to run the compiled `.js` directly (e.g. `node /app/dist/guardedKubectl.js`).
 */
function guardRunnerCommand(): string {
  const entry = fileURLToPath(new URL("./guardedKubectl.ts", import.meta.url));
  return process.env.RIGEL_AGENT_GUARD_CMD || `node --import tsx '${entry}'`;
}

/** Resolve the real absolute path of a binary on the CURRENT PATH (no shim yet). */
async function whichBinary(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", `command -v ${name}`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}

/** One wrapper script: exec the guard entry with (logicalName, realBinaryPath, "$@"). */
export function wrapperScript(runner: string, logicalName: string, realBinaryPath: string): string {
  return `#!/bin/sh
# Auto-generated guarded shim for \`${logicalName}\` — routes through the agent's
# command policy (agent/src/guardedKubectl.ts). Reads run; cluster mutations denied.
exec ${runner} '${logicalName}' '${realBinaryPath}' "$@"
`;
}

/**
 * Materialize the guarded shim dir. Writes executable `kubectl` (and `helm` if
 * installed) wrappers into a fresh OS-temp dir. The provider bridges prepend the
 * returned dir to their subprocess PATH. Throws if kubectl can't be found.
 */
export async function provisionGuardBin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rigel-agent-guard-"));
  const runner = guardRunnerCommand();

  const kubectlReal = await whichBinary("kubectl");
  if (!kubectlReal) {
    throw new Error("guarded-kubectl: `kubectl` was not found on PATH — cannot provision the guarded shim.");
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
  const p = join(dir, logicalName);
  await writeFile(p, wrapperScript(runner, logicalName, realBinaryPath));
  await chmod(p, 0o755);
}

/**
 * True when `entryPath` (process.argv[1]) is THIS shim run directly, e.g.
 * `node dist/guardedKubectl.js …`. Matches the invoked FILENAME, which survives
 * esbuild bundling — unlike a `fileURLToPath(import.meta.url) === process.argv[1]`
 * check, which is WRONG here: the provider bridges import `provisionGuardBin`, so
 * esbuild inlines this module into dist/index.js (and dist/fixRunner.js) and
 * rewrites import.meta.url to the host bundle's path, making that check TRUE on
 * agent startup — the shim then runs with no args and crashes the container.
 */
export function isShimEntry(entryPath: string | undefined): boolean {
  return !!entryPath && /(?:^|[\\/])guardedKubectl\.(?:js|ts)$/.test(entryPath);
}

// Run as the shim only when THIS file is the process entry (bundling-safe).
if (isShimEntry(process.argv[1])) {
  runGuard(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`guarded-kubectl: ${err?.message ?? err}\n`);
      process.exit(1);
    },
  );
}
