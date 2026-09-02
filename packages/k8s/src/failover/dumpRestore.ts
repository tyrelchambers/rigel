import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { cleanExportedManifest } from "../manifestClean";
import { kubectl as defaultKubectl, type RunProcessOpts, type RunResult } from "../run";
import type { ClusterObject } from "../workloadClosure";
import type { DataCopyResult, DataCopyStep, DataPlan } from "./types";

export type KubectlFn = (
  context: string | null,
  args: string[],
  opts?: RunProcessOpts,
) => Promise<RunResult>;

const LIST_DATABASES = [
  "SELECT datname FROM pg_database",
  "WHERE datistemplate = false AND datallowconn AND datname <> 'postgres'",
  "ORDER BY datname",
].join(" ");

const CNPG_CLUSTER = "clusters.postgresql.cnpg.io";
const PG_CONTAINER = "postgres";
const HELPER_IMAGE = "busybox:1.37.0";

export function rewriteCnpgClusterForDump(yaml: string, storageClass: string): string {
  const doc = parseDocument(yaml);
  if (doc.errors.length > 0) {
    throw new Error(`cannot rewrite Cluster YAML: ${doc.errors[0]?.message ?? "parse error"}`);
  }
  doc.setIn(["spec", "instances"], 1);
  doc.deleteIn(["spec", "plugins"]);
  doc.deleteIn(["spec", "backup"]);
  doc.deleteIn(["spec", "volumeSnapshot"]);
  doc.deleteIn(["spec", "externalClusters"]);
  doc.setIn(["spec", "storage", "storageClass"], storageClass);
  const bootstrap = doc.getIn(["spec", "bootstrap"]);
  if (bootstrap && typeof bootstrap === "object" && "items" in bootstrap) {
    doc.deleteIn(["spec", "bootstrap", "recovery"]);
  }
  return String(doc);
}

export async function copyDataPlans(opts: {
  fromContext: string | null;
  toContext: string | null;
  plans: DataPlan[];
  storageClass?: string;
  waitTimeout?: string;
  kubectl?: KubectlFn;
  tmpDir?: string;
}): Promise<DataCopyResult> {
  const kubectl = opts.kubectl ?? defaultKubectl;
  const waitTimeout = opts.waitTimeout ?? "600s";
  const storageClass = opts.storageClass ?? "do-block-storage";
  const dir = opts.tmpDir ?? (await mkdtemp(join(tmpdir(), "rigel-failover-")));
  const steps: DataCopyStep[] = [];

  for (const plan of opts.plans) {
    if (plan.kind === "startEmpty") {
      steps.push({
        kind: plan.kind,
        subject: plan.subject,
        action: "skipped",
        artifacts: [],
        warning: plan.warning ?? "Cache will start empty.",
      });
      continue;
    }
    if (plan.kind === "cnpgBarman") {
      steps.push({
        kind: plan.kind,
        subject: plan.subject,
        action: "skipped",
        artifacts: [],
        warning: plan.warning ?? "ObjectStore is off-site; CNPG recovers without a dump.",
      });
      continue;
    }
    if (plan.kind === "pgDump") {
      steps.push(
        await copyPg(kubectl, opts.fromContext, opts.toContext, plan, dir, waitTimeout, storageClass),
      );
      continue;
    }
    if (plan.kind === "pvcTar") {
      steps.push(await copyPvc(kubectl, opts.fromContext, opts.toContext, plan, dir, waitTimeout));
    }
  }

  return { steps };
}

function fail(res: RunResult, what: string): never {
  throw new Error(res.stderr.trim() || res.stdout.trim() || what);
}

async function copyPg(
  kubectl: KubectlFn,
  from: string | null,
  to: string | null,
  plan: DataPlan,
  dir: string,
  waitTimeout: string,
  storageClass: string,
): Promise<DataCopyStep> {
  const { namespace, name } = plan.subject;
  const srcPrimary = await currentPrimary(kubectl, from, namespace, name);
  const pgDir = join(dir, "pg", namespace, name);
  await mkdir(pgDir, { recursive: true });

  const globals = join(pgDir, "globals.sql");
  const dumpedGlobals = await kubectl(
    from,
    execArgs(namespace, srcPrimary, PG_CONTAINER, ["pg_dumpall", "--globals-only"]),
    { stdoutFile: globals },
  );
  if (dumpedGlobals.code !== 0) fail(dumpedGlobals, `pg_dumpall --globals-only failed on ${namespace}/${name}`);
  await assertNonEmpty(globals, `globals dump for ${namespace}/${name} was empty`);

  const dbs = await listDatabases(kubectl, from, namespace, srcPrimary);
  const artifacts = ["globals.sql"];
  for (const db of dbs) {
    const dump = join(pgDir, `${db}.dump`);
    const res = await kubectl(
      from,
      execArgs(namespace, srcPrimary, PG_CONTAINER, ["pg_dump", "-Fc", "-d", db]),
      { stdoutFile: dump },
    );
    if (res.code !== 0) fail(res, `pg_dump -Fc -d ${db} failed on ${namespace}/${name}`);
    await assertNonEmpty(dump, `pg_dump of ${db} was empty`);
    artifacts.push(`${db}.dump`);
  }

  await ensureDestCluster(kubectl, from, to, plan, dir, storageClass);
  const waited = await kubectl(to, [
    "wait",
    `${CNPG_CLUSTER}/${name}`,
    "-n",
    namespace,
    "--for=condition=Ready",
    `--timeout=${waitTimeout}`,
  ]);
  if (waited.code !== 0) fail(waited, `CNPG cluster ${namespace}/${name} did not become Ready on the destination`);
  const destPrimary = await currentPrimary(kubectl, to, namespace, name);

  const restoredGlobals = await kubectl(
    to,
    execArgs(namespace, destPrimary, PG_CONTAINER, ["psql", "-U", "postgres"], true),
    { stdinFile: globals },
  );
  if (restoredGlobals.code !== 0) fail(restoredGlobals, `restoring globals onto ${namespace}/${name} failed`);

  for (const db of dbs) {
    const created = await kubectl(to, execArgs(namespace, destPrimary, PG_CONTAINER, ["createdb", "-U", "postgres", db]));
    if (created.code !== 0 && !/already exists/i.test(created.stderr)) {
      fail(created, `createdb ${db} failed on ${namespace}/${name}`);
    }
    const dump = join(pgDir, `${db}.dump`);
    const restored = await kubectl(
      to,
      execArgs(namespace, destPrimary, PG_CONTAINER, ["pg_restore", "-U", "postgres", "-d", db, "--no-owner", "--no-acl"], true),
      { stdinFile: dump },
    );
    if (restored.code > 1) fail(restored, `pg_restore of ${db} failed on ${namespace}/${name}`);
  }

  return { kind: "pgDump", subject: plan.subject, action: "copied", artifacts, warning: plan.warning };
}

async function ensureDestCluster(
  kubectl: KubectlFn,
  from: string | null,
  to: string | null,
  plan: DataPlan,
  dir: string,
  storageClass: string,
): Promise<void> {
  const { namespace, name } = plan.subject;
  const existing = await kubectl(to, ["get", CNPG_CLUSTER, name, "-n", namespace, "-o", "json"]);
  if (existing.code === 0) return;
  const src = await kubectl(from, ["get", CNPG_CLUSTER, name, "-n", namespace, "-o", "yaml"]);
  if (src.code !== 0) fail(src, `cannot read source Cluster ${namespace}/${name}`);
  const yaml = rewriteCnpgClusterForDump(cleanExportedManifest(src.stdout), storageClass);
  const path = join(dir, `cluster-${namespace}-${name}.yaml`);
  await writeFile(path, yaml);
  const applied = await kubectl(to, ["apply", "-f", path]);
  if (applied.code !== 0) fail(applied, `failed to apply recovery Cluster ${namespace}/${name}`);
}

async function currentPrimary(
  kubectl: KubectlFn,
  context: string | null,
  namespace: string,
  name: string,
): Promise<string> {
  const res = await kubectl(context, ["get", CNPG_CLUSTER, name, "-n", namespace, "-o", "json"]);
  if (res.code !== 0) fail(res, `cannot read CNPG cluster ${namespace}/${name}`);
  let parsed: { status?: { currentPrimary?: string } };
  try {
    parsed = JSON.parse(res.stdout) as { status?: { currentPrimary?: string } };
  } catch {
    throw new Error(`CNPG cluster ${namespace}/${name} returned non-JSON status`);
  }
  const primary = parsed.status?.currentPrimary?.trim();
  if (!primary) throw new Error(`CNPG cluster ${namespace}/${name} has no currentPrimary`);
  return primary;
}

async function listDatabases(
  kubectl: KubectlFn,
  context: string | null,
  namespace: string,
  primary: string,
): Promise<string[]> {
  const res = await kubectl(context, execArgs(namespace, primary, PG_CONTAINER, ["psql", "-U", "postgres", "-tAc", LIST_DATABASES]));
  if (res.code !== 0) fail(res, `listing databases on ${namespace}/${primary} failed`);
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function copyPvc(
  kubectl: KubectlFn,
  from: string | null,
  to: string | null,
  plan: DataPlan,
  dir: string,
  waitTimeout: string,
): Promise<DataCopyStep> {
  const { namespace, name } = plan.subject;
  const pvcDir = join(dir, "pvc", namespace);
  await mkdir(pvcDir, { recursive: true });
  const tgz = join(pvcDir, `${name}.tgz`);

  await withClaimPod(kubectl, from, namespace, name, dir, waitTimeout, async (pod) => {
    const dumped = await kubectl(
      from,
      execArgs(namespace, pod.name, pod.container, ["tar", "czf", "-", "-C", pod.mountPath, "."]),
      { stdoutFile: tgz },
    );
    if (dumped.code !== 0) fail(dumped, `tar of PVC ${namespace}/${name} failed`);
  });
  await assertNonEmpty(tgz, `tar of PVC ${namespace}/${name} was empty`);

  await withClaimPod(kubectl, to, namespace, name, dir, waitTimeout, async (pod) => {
    const restored = await kubectl(
      to,
      execArgs(namespace, pod.name, pod.container, ["tar", "xzf", "-", "-C", pod.mountPath], true),
      { stdinFile: tgz },
    );
    if (restored.code !== 0) fail(restored, `untar onto PVC ${namespace}/${name} failed`);
  });

  return {
    kind: "pvcTar",
    subject: plan.subject,
    action: "copied",
    artifacts: [`${name}.tgz`],
    warning: plan.warning,
  };
}

interface ClaimPod {
  name: string;
  mountPath: string;
  container?: string;
}

async function withClaimPod(
  kubectl: KubectlFn,
  context: string | null,
  namespace: string,
  claim: string,
  dir: string,
  waitTimeout: string,
  fn: (pod: ClaimPod) => Promise<void>,
): Promise<void> {
  let helper: string | undefined;
  try {
    let pod = await podMountingClaim(kubectl, context, namespace, claim);
    if (!pod) {
      helper = helperName(claim);
      await applyHelper(kubectl, context, namespace, claim, helper, dir);
      const waited = await kubectl(context, [
        "wait",
        `pod/${helper}`,
        "-n",
        namespace,
        "--for=condition=Ready",
        `--timeout=${waitTimeout}`,
      ]);
      if (waited.code !== 0) fail(waited, `helper pod for PVC ${namespace}/${claim} did not become Ready`);
      pod = await podMountingClaim(kubectl, context, namespace, claim);
    }
    if (!pod) throw new Error(`no pod mounts PVC ${namespace}/${claim}`);
    await fn(pod);
  } finally {
    if (helper) {
      await kubectl(context, ["delete", "pod", helper, "-n", namespace, "--ignore-not-found=true"]);
    }
  }
}

async function podMountingClaim(
  kubectl: KubectlFn,
  context: string | null,
  namespace: string,
  claim: string,
): Promise<ClaimPod | null> {
  const res = await kubectl(context, ["get", "pods", "-n", namespace, "-o", "json"]);
  if (res.code !== 0) fail(res, `listing pods in ${namespace} failed`);
  let items: Array<ClusterObject & { status?: { phase?: string } }> = [];
  try {
    items = ((JSON.parse(res.stdout) as { items?: Array<ClusterObject & { status?: { phase?: string } }> }).items) ?? [];
  } catch {
    throw new Error(`pod list in ${namespace} returned non-JSON`);
  }
  for (const pod of items) {
    const phase = pod.status?.phase;
    if (phase && phase !== "Running") continue;
    const found = mountForClaim(pod, claim);
    if (found && pod.metadata?.name) return { name: pod.metadata.name, ...found };
  }
  return null;
}

function mountForClaim(pod: ClusterObject, claim: string): { mountPath: string; container?: string } | null {
  const spec = pod.spec as {
    volumes?: Array<{ name?: string; persistentVolumeClaim?: { claimName?: string } }>;
    containers?: Array<{ name?: string; volumeMounts?: Array<{ name?: string; mountPath?: string }> }>;
  } | undefined;
  const vol = spec?.volumes?.find((v) => v.persistentVolumeClaim?.claimName === claim);
  if (!vol?.name) return null;
  for (const container of spec?.containers ?? []) {
    const mount = container.volumeMounts?.find((m) => m.name === vol.name && m.mountPath);
    if (mount?.mountPath) return { mountPath: mount.mountPath, container: container.name };
  }
  return null;
}

function helperName(claim: string): string {
  const base = `rigel-copy-${claim}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return base.slice(0, 63).replace(/-+$/, "") || "rigel-copy";
}

async function applyHelper(
  kubectl: KubectlFn,
  context: string | null,
  namespace: string,
  claim: string,
  name: string,
  dir: string,
): Promise<void> {
  const yaml = [
    "apiVersion: v1",
    "kind: Pod",
    "metadata:",
    `  name: ${name}`,
    `  namespace: ${namespace}`,
    "spec:",
    "  restartPolicy: Never",
    "  containers:",
    "    - name: tar",
    `      image: ${HELPER_IMAGE}`,
    "      command: [\"sleep\", \"1800\"]",
    "      volumeMounts:",
    "        - name: data",
    "          mountPath: /data",
    "  volumes:",
    "    - name: data",
    "      persistentVolumeClaim:",
    `        claimName: ${claim}`,
    "",
  ].join("\n");
  const path = join(dir, `${name}.yaml`);
  await writeFile(path, yaml);
  const applied = await kubectl(context, ["apply", "-f", path]);
  if (applied.code !== 0) fail(applied, `failed to start helper pod for PVC ${namespace}/${claim}`);
}

function execArgs(namespace: string, pod: string, container: string | undefined, command: string[], stdin = false): string[] {
  const args = ["exec"];
  if (stdin) args.push("-i");
  args.push("-n", namespace, pod);
  if (container) args.push("-c", container);
  args.push("--", ...command);
  return args;
}

async function assertNonEmpty(path: string, message: string): Promise<void> {
  const info = await stat(path);
  if (info.size <= 0) throw new Error(message);
}
