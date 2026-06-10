// Catalog install executors — the server-side of the catalog wizard's Apply
// step (docs/parity/catalog.md §"Execution").
//
//   manifest mode → `kubectl apply -f -` with YAML piped via STDIN (never
//                    interpolated into a shell).
//   helm mode     → `helm repo add` → `helm repo update` → `helm upgrade
//                    --install` in sequence, values written to a temp file.
//
// Commands are built from typed argv arrays — no shell, no free-form strings —
// mirroring the Swift WorkloadCommander / HelmCommander invocations.

import { buildKubectlArgs, type RunResult } from "@helmsman/k8s/src/run";

/** Build the kubectl argv (verb onward) for a stdin apply. Exported for tests. */
export function buildApplyArgs(context: string | null): string[] {
  return buildKubectlArgs(context, ["apply", "-f", "-"]);
}

/**
 * Run `kubectl [--context ctx] apply -f -`, feeding `yaml` on STDIN. The YAML is
 * NEVER interpolated into a shell — it is written to the process's stdin pipe.
 * Returns { code, stdout, stderr }; code -1 when the kubectl binary is missing.
 */
export async function applyManifest(
  context: string | null,
  yaml: string,
): Promise<RunResult> {
  const args = buildApplyArgs(context);
  try {
    const proc = Bun.spawn(["kubectl", ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(yaml);
    await proc.stdin.end();
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: -1, stdout: "", stderr: `kubectl not found: ${message}` };
  }
}

export interface HelmInstallRequest {
  repoName: string;
  repoURL: string;
  chart: string;
  version?: string | null;
  releaseName: string;
  namespace: string;
  values: string;
}

/** Build the three ordered helm argv arrays for an install. Exported for tests. */
export function buildHelmArgs(
  req: HelmInstallRequest,
  context: string | null,
  valuesFile: string,
): { repoAdd: string[]; repoUpdate: string[]; upgrade: string[] } {
  const ctx = context ? ["--kube-context", context] : [];
  const version = req.version ? ["--version", req.version] : [];
  return {
    repoAdd: ["repo", "add", req.repoName, req.repoURL],
    repoUpdate: ["repo", "update", req.repoName],
    upgrade: [
      "upgrade",
      "--install",
      req.releaseName,
      `${req.repoName}/${req.chart}`,
      ...version,
      "-n",
      req.namespace,
      "--create-namespace",
      "-f",
      valuesFile,
      ...ctx,
    ],
  };
}

async function runHelm(args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(["helm", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/** True when a `helm repo add` failure is the benign "already exists" case. */
function isAlreadyExists(result: RunResult): boolean {
  return /already exists/i.test(result.stderr) || /already exists/i.test(result.stdout);
}

/**
 * Run the ordered helm install: repo add (idempotent) → repo update → upgrade
 * --install. Values are written to a temp file passed with `-f`. Returns the
 * combined result; a non-zero exit on update/upgrade aborts with that result.
 * code -1 when the helm binary is missing.
 */
export async function installHelm(
  context: string | null,
  req: HelmInstallRequest,
): Promise<RunResult> {
  let valuesFile: string | null = null;
  try {
    valuesFile = `${process.env.TMPDIR ?? "/tmp"}/helmsman-values-${req.releaseName}-${Date.now()}.yaml`;
    await Bun.write(valuesFile, req.values);

    const args = buildHelmArgs(req, context, valuesFile);

    let combinedOut = "";
    let combinedErr = "";

    const add = await runHelm(args.repoAdd);
    combinedOut += add.stdout;
    combinedErr += add.stderr;
    // "already exists" is OK; any other non-zero aborts.
    if (add.code !== 0 && !isAlreadyExists(add)) {
      return { code: add.code, stdout: combinedOut, stderr: combinedErr };
    }

    const update = await runHelm(args.repoUpdate);
    combinedOut += update.stdout;
    combinedErr += update.stderr;
    if (update.code !== 0) {
      return { code: update.code, stdout: combinedOut, stderr: combinedErr };
    }

    const upgrade = await runHelm(args.upgrade);
    combinedOut += upgrade.stdout;
    combinedErr += upgrade.stderr;
    return { code: upgrade.code, stdout: combinedOut, stderr: combinedErr };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: -1, stdout: "", stderr: `helm not found: ${message}` };
  } finally {
    if (valuesFile) {
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(valuesFile);
      } catch {
        // best-effort cleanup
      }
    }
  }
}
