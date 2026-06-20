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

import { buildKubectlArgs, runProcess, runProcessWithStdin, type RunResult } from "@rigel/k8s/src/run";
import { buildHelmInstallCommands, type HelmChartSource } from "@rigel/k8s/src/helm";
import { unlink, writeFile } from "node:fs/promises";

/**
 * Build the kubectl argv (verb onward) for a stdin apply. Exported for tests.
 * `dryRun` appends `--dry-run=server` so the apiserver validates/admits the
 * manifest without persisting it (used by the Apply YAML panel's Validate).
 */
export function buildApplyArgs(context: string | null, dryRun = false): string[] {
  return buildKubectlArgs(context, ["apply", "-f", "-", ...(dryRun ? ["--dry-run=server"] : [])]);
}

/**
 * Run `kubectl [--context ctx] apply -f - [--dry-run=server]`, feeding `yaml` on
 * STDIN. The YAML is NEVER interpolated into a shell — it is written to the
 * process's stdin pipe. With `dryRun`, the apiserver validates without applying.
 * Returns { code, stdout, stderr }; code -1 when the kubectl binary is missing.
 */
export async function applyManifest(
  context: string | null,
  yaml: string,
  dryRun = false,
): Promise<RunResult> {
  const args = buildApplyArgs(context, dryRun);
  return runProcessWithStdin("kubectl", args, yaml);
}

export interface HelmInstallRequest {
  source: HelmChartSource;
  releaseName: string;
  namespace: string;
  values: string;
}

function runHelm(args: string[]): Promise<RunResult> {
  return runProcess("helm", args);
}

function isAlreadyExists(r: RunResult): boolean {
  return /already exists/i.test(r.stderr) || /already exists/i.test(r.stdout);
}

/**
 * Run the ordered helm install/upgrade commands. Repo `add` tolerates the
 * benign "already exists"; any other non-zero aborts with that result. Values
 * are written to a temp file and removed afterwards. code -1 if helm is missing.
 */
export async function installHelm(context: string | null, req: HelmInstallRequest): Promise<RunResult> {
  let valuesFile: string | null = null;
  try {
    valuesFile = `${process.env.TMPDIR ?? "/tmp"}/rigel-values-${req.releaseName}-${process.pid}-${counter()}.yaml`;
    await writeFile(valuesFile, req.values);
    const cmds = buildHelmInstallCommands(req.source, {
      releaseName: req.releaseName,
      namespace: req.namespace,
      valuesFile,
      context,
    });
    let out = "";
    let err = "";
    for (let i = 0; i < cmds.length; i++) {
      const r = await runHelm(cmds[i]!);
      out += r.stdout;
      err += r.stderr;
      const isRepoAdd = cmds[i]![0] === "repo" && cmds[i]![1] === "add";
      if (r.code !== 0 && !(isRepoAdd && isAlreadyExists(r))) {
        return { code: r.code, stdout: out, stderr: err };
      }
    }
    return { code: 0, stdout: out, stderr: err };
  } catch (e) {
    return { code: -1, stdout: "", stderr: `helm not found: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    if (valuesFile) await unlink(valuesFile).catch(() => {});
  }
}

let _c = 0;
function counter(): number {
  return (_c = (_c + 1) % 1_000_000);
}
