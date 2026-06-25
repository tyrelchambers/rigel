import { spawn, type ChildProcess } from "node:child_process";

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

/** Collect a child's stdout/stderr to completion. Resolves (never rejects) —
 *  spawn errors (e.g. ENOENT) come back as { code: -1, stderr: <message> }. */
function collectProcess(proc: ChildProcess): Promise<RunResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout!.on("data", (d: Buffer) => out.push(d));
    proc.stderr!.on("data", (d: Buffer) => err.push(d));
    const text = (b: Buffer[]) => Buffer.concat(b).toString("utf8");
    proc.on("error", (e) => resolve({ code: -1, stdout: text(out), stderr: text(err) || e.message }));
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout: text(out), stderr: text(err) }));
  });
}

/**
 * Run a binary to completion via node:child_process spawn (argv array — no shell).
 * `opts.env` overrides the child's environment (e.g. to set KUBECONFIG); when
 * omitted the child inherits the parent process env.
 */
export function runProcess(
  bin: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return collectProcess(spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: opts?.env }));
}

/**
 * Run a binary to completion, piping `input` to its stdin.
 * Use for commands like `kubectl apply -f -` that read from stdin.
 */
export function runProcessWithStdin(bin: string, args: string[], input: string): Promise<RunResult> {
  const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin!.on("error", () => {}); // absorb EPIPE if the child exits before draining stdin
  proc.stdin!.write(input);
  proc.stdin!.end();
  return collectProcess(proc);
}

export const kubectl = (context: string | null, args: string[]) =>
  runProcess("kubectl", buildKubectlArgs(context, args));
