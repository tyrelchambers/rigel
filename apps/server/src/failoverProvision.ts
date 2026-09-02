import { runProcess, type RunResult } from "@rigel/k8s/src/run";
import { installHelm } from "./install";
import type { FailoverDestination } from "@rigel/k8s/src/failover/destination";

export type Run = (bin: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<RunResult>;

const defaultRun: Run = (bin, args, opts) => runProcess(bin, args, opts);

function tokenEnv(token: string): NodeJS.ProcessEnv {
  return { ...process.env, DIGITALOCEAN_ACCESS_TOKEN: token };
}

export function failoverClusterName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `rigel-failover-${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`;
}

export function createClusterArgs(dest: FailoverDestination, name: string): string[] {
  return [
    "kubernetes",
    "cluster",
    "create",
    name,
    "--region",
    dest.region,
    "--size",
    dest.nodeSize,
    "--count",
    String(dest.nodeCount),
    "--wait",
    "-o",
    "json",
  ];
}

export interface ProvisionedCluster {
  id: string;
  name: string;
  context: string;
}

function parseCreated(stdout: string, name: string): { id: string; name: string } {
  const parsed = JSON.parse(stdout) as { id?: string; name?: string } | Array<{ id?: string; name?: string }>;
  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  const id = obj?.id;
  if (!id) throw new Error("doctl did not return a cluster id");
  return { id, name: obj?.name ?? name };
}

export async function provisionDoks(
  dest: FailoverDestination,
  opts: { run?: Run; clock?: () => Date } = {},
): Promise<ProvisionedCluster> {
  const run = opts.run ?? defaultRun;
  const name = failoverClusterName(opts.clock?.() ?? new Date());
  const env = tokenEnv(dest.token);
  const created = await run("doctl", createClusterArgs(dest, name), { env });
  if (created.code !== 0) {
    throw new Error(created.stderr.trim() || "doctl kubernetes cluster create failed");
  }
  const { id } = parseCreated(created.stdout, name);
  const saved = await run("doctl", ["kubernetes", "cluster", "kubeconfig", "save", id], { env });
  if (saved.code !== 0) {
    throw new Error(saved.stderr.trim() || "doctl kubeconfig save failed");
  }
  const context = `do-${dest.region}-${name}`;
  return { id, name, context };
}

export async function installFailoverStack(context: string): Promise<void> {
  const cert = await installHelm(context, {
    source: { kind: "repo", repoName: "jetstack", repoURL: "https://charts.jetstack.io", chart: "cert-manager" },
    releaseName: "cert-manager",
    namespace: "cert-manager",
    values: "crds:\n  enabled: true\n",
  });
  if (cert.code !== 0) throw new Error(cert.stderr.trim() || "cert-manager install failed");

  const cnpg = await installHelm(context, {
    source: {
      kind: "repo",
      repoName: "cnpg",
      repoURL: "https://cloudnative-pg.github.io/charts",
      chart: "cloudnative-pg",
    },
    releaseName: "cnpg",
    namespace: "cnpg-system",
    values: "",
  });
  if (cnpg.code !== 0) throw new Error(cnpg.stderr.trim() || "cloudnative-pg install failed");

  const traefik = await installHelm(context, {
    source: { kind: "repo", repoName: "traefik", repoURL: "https://traefik.github.io/charts", chart: "traefik" },
    releaseName: "traefik",
    namespace: "traefik",
    values: "ingressClass:\n  enabled: true\n  name: traefik\n",
  });
  if (traefik.code !== 0) throw new Error(traefik.stderr.trim() || "traefik install failed");
}

export async function destroyDoks(
  dest: FailoverDestination,
  clusterId: string,
  opts: { run?: Run } = {},
): Promise<void> {
  const run = opts.run ?? defaultRun;
  const res = await run("doctl", ["kubernetes", "cluster", "delete", clusterId, "--force", "--dangerous"], {
    env: tokenEnv(dest.token),
  });
  if (res.code !== 0) throw new Error(res.stderr.trim() || "doctl kubernetes cluster delete failed");
}
