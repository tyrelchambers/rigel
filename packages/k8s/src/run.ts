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

/** Run a binary to completion via Bun.spawn (argv array — no shell). */
export async function runProcess(bin: string, args: string[]): Promise<RunResult> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

export const kubectl = (context: string | null, args: string[]) =>
  runProcess("kubectl", buildKubectlArgs(context, args));
