import { spawn, type ChildProcess } from "node:child_process";
import { spawnEnv } from "./toolPath.js";

/**
 * kubectl plugins (invoked as `kubectl <plugin> …`, e.g. the cnpg plugin)
 * REJECT global flags placed before the plugin name — `kubectl --context X cnpg
 * backup` fails with "flags cannot be placed before plugin name". For those the
 * flag must come AFTER the plugin name: `kubectl cnpg --context X backup`.
 */
const KUBECTL_PLUGINS = new Set(["cnpg", "cert-manager"]);

/**
 * Build the kubectl argv with `--context <ctx>` when a context is set. For
 * plugin invocations the context is inserted after the plugin name (see above);
 * for everything else it is prepended as usual.
 */
export function buildKubectlArgs(context: string | null, args: string[]): string[] {
  if (!context) return args;
  if (args.length > 0 && KUBECTL_PLUGINS.has(args[0]!)) {
    return [args[0]!, "--context", context, ...args.slice(1)];
  }
  return ["--context", context, ...args];
}

export interface RunResult { code: number; stdout: string; stderr: string }

/**
 * Notified whenever a spawn fails outright (code -1), so one listener can tell
 * whether a binary is missing from PATH instead of every call site reporting it
 * for itself. Exit codes are not spawn failures and never reach this.
 */
type SpawnFailureListener = (bin: string, stderr: string) => void;
const spawnFailureListeners = new Set<SpawnFailureListener>();

export function onSpawnFailure(listener: SpawnFailureListener): () => void {
  spawnFailureListeners.add(listener);
  return () => spawnFailureListeners.delete(listener);
}

export function reportSpawnFailure(bin: string, result: RunResult): RunResult {
  if (result.code === -1) for (const l of spawnFailureListeners) l(bin, result.stderr);
  return result;
}

/** Collect a child's stdout/stderr to completion. Resolves (never rejects) —
 *  spawn errors (e.g. ENOENT) come back as { code: -1, stderr: <message> }. */
function collectProcess(proc: ChildProcess, maxOutput = Infinity): Promise<RunResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const collect = (into: Buffer[]) => {
      let size = 0;
      return (d: Buffer) => {
        if (size >= maxOutput) return;
        into.push(d.subarray(0, maxOutput - size));
        size += d.length;
      };
    };
    proc.stdout!.on("data", collect(out));
    proc.stderr!.on("data", collect(err));
    const text = (b: Buffer[]) => Buffer.concat(b).toString("utf8");
    proc.on("error", (e) => resolve({ code: -1, stdout: text(out), stderr: text(err) || e.message }));
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout: text(out), stderr: text(err) }));
  });
}

/**
 * Run a binary to completion via node:child_process spawn (argv array — no shell).
 * `opts.env` overrides the child's environment (e.g. to set KUBECONFIG); when
 * omitted the child inherits the parent process env. `opts.timeout` kills the
 * child after that many ms and reports exit 124; `opts.maxOutput` caps the bytes
 * kept from each of stdout and stderr.
 */
export function runProcess(
  bin: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; timeout?: number; maxOutput?: number },
): Promise<RunResult> {
  // Base spawnEnv on the caller-provided env (so explicit vars like KUBECONFIG
  // are preserved) or on process.env when none is given. This prepends the
  // gcloud SDK bin to PATH so component-installed tools (gke-gcloud-auth-plugin)
  // are visible to kubectl and cloud-connect checks even with a Homebrew gcloud.
  const env = spawnEnv(opts?.env ?? process.env);
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env, timeout: opts?.timeout });
  return collectProcess(proc, opts?.maxOutput).then((r) =>
    opts?.timeout && proc.killed && r.code === -1
      ? { ...r, code: 124, stderr: `${r.stderr}${r.stderr ? "\n" : ""}timed out after ${opts.timeout}ms` }
      : reportSpawnFailure(bin, r),
  );
}

/**
 * Run a binary to completion, piping `input` to its stdin.
 * Use for commands like `kubectl apply -f -` that read from stdin.
 */
export function runProcessWithStdin(bin: string, args: string[], input: string): Promise<RunResult> {
  // Same gcloud SDK bin PATH fix as runProcess — this is the path used by
  // `kubectl apply -f -` / `kubectl delete -f -` (catalog installs, assistant agent).
  const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: spawnEnv() });
  proc.stdin!.on("error", () => {}); // absorb EPIPE if the child exits before draining stdin
  proc.stdin!.write(input);
  proc.stdin!.end();
  return collectProcess(proc).then((r) => reportSpawnFailure(bin, r));
}

export const kubectl = (context: string | null, args: string[]) =>
  runProcess("kubectl", buildKubectlArgs(context, args));
