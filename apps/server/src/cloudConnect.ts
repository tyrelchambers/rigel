import { runProcess, type RunResult } from "@rigel/k8s/src/run";
import { backupKubeconfig } from "./kubeconfigBackup";
import {
  descriptorFor, detectAuthExpiry, type CloudCluster, type CheckResult,
} from "@rigel/cloud-connect/src/index";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

export type Run = (bin: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<RunResult>;
type BackupFn = (kubeconfigPath: string) => Promise<string | null>;

/** Is the provider CLI installed (+ any extra binaries) and is the user logged in? */
export async function cloudCheck(provider: string, run: Run = runProcess): Promise<CheckResult> {
  const d = descriptorFor(provider);
  if (!d) return { cliInstalled: false, extraBinariesInstalled: false, authenticated: false };
  const cliInstalled = (await run(d.binary, d.versionArgs)).code === 0;
  let extraBinariesInstalled = true;
  for (const b of d.extraBinaries) {
    if ((await run(b, ["--version"])).code !== 0) extraBinariesInstalled = false;
  }
  let authenticated = false;
  let account: string | null | undefined;
  if (cliInstalled) {
    const a = await run(d.binary, d.authCheckArgs);
    if (a.code === 0) {
      if (d.parseAccount) {
        try { account = d.parseAccount(a.stdout); } catch { account = null; }
        authenticated = !!account;
      } else {
        authenticated = true;
      }
    }
  }
  return { cliInstalled, extraBinariesInstalled, authenticated, ...(account ? { account } : {}) };
}

export interface ListResult {
  clusters?: CloudCluster[];
  error?: string;
  stderr?: string;
}

/** List the user's clusters for `provider` via its CLI. */
export async function cloudListClusters(
  provider: string,
  params: Record<string, string>,
  run: Run = runProcess,
): Promise<ListResult> {
  const d = descriptorFor(provider);
  if (!d) return { error: "unknown provider" };
  const res = await run(d.binary, d.listClustersArgs(params));
  if (res.code !== 0) return { error: "failed to list clusters", stderr: res.stderr };
  try {
    const clusters = d.parseClusterList(res.stdout).map((c) =>
      c.region || !params.region ? c : { ...c, region: params.region });
    return { clusters };
  } catch {
    return { error: "could not parse cluster list", stderr: res.stdout };
  }
}

export interface ParamOptions {
  options: string[];
  default?: string;
}

/** Fetch the dropdown options + pre-selected default for a provider's required param. */
export async function cloudParamOptions(provider: string, key: string, run: Run = runProcess): Promise<ParamOptions> {
  const d = descriptorFor(provider);
  const spec = d?.requiredParams.find((p) => p.key === key);
  if (!d || !spec) return { options: [] };
  let options: string[] = spec.staticOptions ?? [];
  if (spec.optionsArgs) {
    const res = await run(d.binary, spec.optionsArgs);
    if (res.code === 0) {
      options = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
  }
  let def: string | undefined;
  if (spec.defaultArgs) {
    const r = await run(d.binary, spec.defaultArgs);
    if (r.code === 0) {
      const v = r.stdout.trim();
      if (v && v !== "(unset)") def = v;
    }
  }
  return { options, ...(def ? { default: def } : {}) };
}

export interface ConnectDeps {
  kubeconfigPath: string;
  run?: Run;
  backup?: BackupFn;
}
export interface ConnectResult {
  context?: string;
  backupPath?: string | null;
  error?: string;
  stderr?: string;
}

/** Run the provider's connect command, writing the context into the server's KUBECONFIG. */
export async function cloudConnect(
  provider: string,
  cluster: CloudCluster,
  params: Record<string, string>,
  deps: ConnectDeps,
): Promise<ConnectResult> {
  const d = descriptorFor(provider);
  if (!d) return { error: "unknown provider" };
  const run = deps.run ?? runProcess;
  const backup = deps.backup ?? ((p) => backupKubeconfig(p));
  const env = { ...process.env, KUBECONFIG: deps.kubeconfigPath };
  const backupPath = await backup(deps.kubeconfigPath);
  const res = await run(d.binary, d.connectArgs(cluster, params), { env });
  if (res.code !== 0) return { error: "connect failed", stderr: res.stderr, backupPath };
  const cur = await run("kubectl", ["config", "current-context"], { env });
  return { context: cur.code === 0 ? cur.stdout.trim() : undefined, backupPath };
}

export interface HealthResult {
  ok: boolean;
  authExpired: boolean;
  stderr?: string;
}

/** Probe a connected context; flag re-login when the failure matches the provider's patterns. */
export async function cloudHealth(provider: string, context: string, run: Run = runProcess): Promise<HealthResult> {
  const res = await run("kubectl", ["--context", context, "get", "--raw=/version"]);
  if (res.code === 0) return { ok: true, authExpired: false };
  return { ok: false, authExpired: detectAuthExpiry(provider, res.stderr), stderr: res.stderr };
}

export interface ImportDeps {
  kubeconfigPath: string;
  run?: Run;
  write?: (p: string, data: string) => Promise<void>;
  rm?: (p: string) => Promise<void>;
  backup?: BackupFn;
  tmpPath?: string;
}
export interface ImportResult {
  ok: boolean;
  backupPath?: string | null;
  added?: string[];
  error?: string;
}

/** Merge a pasted kubeconfig into the server's config (existing entries win). */
export async function importKubeconfig(kubeconfig: string, deps: ImportDeps): Promise<ImportResult> {
  const run = deps.run ?? runProcess;
  const write = deps.write ?? ((p, data) => writeFile(p, data, "utf8"));
  const rm = deps.rm ?? ((p) => unlink(p).catch(() => {}));
  const backup = deps.backup ?? ((p) => backupKubeconfig(p));
  const tmp = deps.tmpPath ?? join(tmpdir(), `rigel-import-${Date.now()}.yaml`);
  try {
    await write(tmp, kubeconfig);
    const incoming = await run("kubectl", ["config", "view", "-o", "json"], {
      env: { ...process.env, KUBECONFIG: tmp },
    });
    if (incoming.code !== 0) return { ok: false, error: incoming.stderr || "invalid kubeconfig" };
    let added: string[];
    try {
      added = ((JSON.parse(incoming.stdout).contexts ?? []) as { name: string }[]).map((c) => c.name);
    } catch {
      return { ok: false, error: "invalid kubeconfig" };
    }
    const merged = await run("kubectl", ["config", "view", "--flatten", "-o", "yaml"], {
      env: { ...process.env, KUBECONFIG: `${deps.kubeconfigPath}${delimiter}${tmp}` },
    });
    if (merged.code !== 0) return { ok: false, error: merged.stderr || "merge failed" };
    try {
      const backupPath = await backup(deps.kubeconfigPath);
      await write(deps.kubeconfigPath, merged.stdout);
      return { ok: true, backupPath, added };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "write failed" };
    }
  } finally {
    await rm(tmp);
  }
}
