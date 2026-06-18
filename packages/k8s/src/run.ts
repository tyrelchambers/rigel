import { spawn } from "node:child_process";

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

/** Run a binary to completion via node:child_process spawn (argv array — no shell). */
export function runProcess(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk: Buffer) => outChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    proc.on("error", (err: Error) => {
      resolve({ code: -1, stdout: "", stderr: err.message });
    });

    proc.on("close", (code: number | null) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      });
    });
  });
}

/**
 * Run a binary to completion, piping `input` to its stdin.
 * Use for commands like `kubectl apply -f -` that read from stdin.
 */
export function runProcessWithStdin(bin: string, args: string[], input: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk: Buffer) => outChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    proc.on("error", (err: Error) => {
      resolve({ code: -1, stdout: "", stderr: err.message });
    });

    proc.on("close", (code: number | null) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      });
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

export const kubectl = (context: string | null, args: string[]) =>
  runProcess("kubectl", buildKubectlArgs(context, args));
