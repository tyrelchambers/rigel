/** Prepend `--context <ctx>` to kubectl args when a context is set. */
export function buildKubectlArgs(context: string | null, args: string[]): string[] {
  return context ? ["--context", context, ...args] : args;
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
