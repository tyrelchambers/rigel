import { kubectl, type RunResult } from "@rigel/k8s/src/run";
import { cleanExportedManifest } from "@rigel/k8s/src/manifestClean";
import { failoverClosure, type ClosureMember } from "@rigel/k8s/src/failover/closure";
import { auditPortability } from "@rigel/k8s/src/failover/portabilityAudit";
import { planData } from "@rigel/k8s/src/failover/dataPlans";
import { copyDataPlans, rewriteCnpgClusterForDump } from "@rigel/k8s/src/failover/dumpRestore";
import { edgeChangeFor, type EdgeChange } from "@rigel/k8s/src/failover/edgeChange";
import {
  applyEndpointRewrites,
  planEndpointRewrites,
  type EndpointRewrite,
} from "@rigel/k8s/src/failover/endpointRewrites";
import { localWritesAfterFailover, scaleDownOnReturn } from "@rigel/k8s/src/failover/splitBrain";
import { parseFailoverState, serializeFailoverState } from "@rigel/k8s/src/failover/state";
import { serializeFailoverDestination } from "@rigel/k8s/src/failover/destination";
import type {
  DataCopyResult,
  DataPlan,
  FailoverReporter,
  FailoverSelection,
  FailoverState,
  FailoverWorkload,
  PortabilityFinding,
  TargetProfile,
} from "@rigel/k8s/src/failover/types";
import type { ClusterObject } from "@rigel/k8s/src/workloadClosure";
import { routingFor } from "@rigel/k8s/src/workloadClosure";
import { FAILOVER_CONFIG_KEY, FAILOVER_STATE_KEY } from "@rigel/k8s/src/userConfig";
import { applyManifest } from "./install";
import { readUserConfig, writeUserConfig } from "./clusterConfigStore";
import { readFailoverDestination } from "./failoverConfig";
import { failoverOpsFor, type FailoverProviderOps } from "./failoverProviders";

type GetJson = (context: string | null, args: string[]) => Promise<unknown>;

/**
 * A read that fails is not an empty cluster. Swallowing it planned a closure of
 * nothing, with no blockers, and left Run enabled: the run would then provision
 * a cluster and apply an empty bundle to it.
 */
const defaultGetJson: GetJson = async (context, args) => {
  const res = await kubectl(context, args);
  if (res.code !== 0) {
    const what = args.slice(0, 2).join(" ");
    throw new Error(res.stderr.trim() || `kubectl ${what} failed`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`kubectl ${args.slice(0, 2).join(" ")} returned output that is not JSON`);
  }
};

function items(raw: unknown): ClusterObject[] {
  if (!raw || typeof raw !== "object") return [];
  const o = raw as { items?: ClusterObject[]; kind?: string; metadata?: ClusterObject["metadata"] };
  if (Array.isArray(o.items)) return o.items;
  if (o.kind && o.metadata) return [o as ClusterObject];
  return [];
}

const KIND_ALIAS: Record<string, string> = {
  deployments: "Deployment",
  statefulsets: "StatefulSet",
  services: "Service",
  ingresses: "Ingress",
  pdb: "PodDisruptionBudget",
  hpa: "HorizontalPodAutoscaler",
  pvc: "PersistentVolumeClaim",
  secrets: "Secret",
  configmaps: "ConfigMap",
  rolebindings: "RoleBinding",
  clusterrolebindings: "ClusterRoleBinding",
};

function kindOf(o: ClusterObject, fallback: string): ClusterObject {
  return { ...o, kind: o.kind ?? KIND_ALIAS[fallback] ?? fallback };
}

async function listKind(get: GetJson, context: string | null, kind: string, ns?: string): Promise<ClusterObject[]> {
  const args = ns && ns !== "*"
    ? ["get", kind, "-n", ns, "-o", "json"]
    : ["get", kind, "-A", "-o", "json"];
  return items(await get(context, args)).map((o) => kindOf(o, kind));
}

export interface FailoverPlanView {
  members: ClosureMember[];
  findings: PortabilityFinding[];
  plans: DataPlan[];
  blockers: PortabilityFinding[];
  outbound: ClosureMember[];
  workloadsToScale: FailoverWorkload[];
  endpointRewrites: EndpointRewrite[];
}

function namespacesOf(selection: FailoverSelection): string[] {
  if (selection.kind === "namespace") return [selection.namespace];
  if (selection.kind === "app") return [selection.namespace];
  return [...new Set(selection.items.map((i) => i.namespace))];
}

export async function planFailover(
  context: string | null,
  selection: FailoverSelection,
  acceptedRewrites: Array<{ rule: string; to: unknown }> = [],
  nodeCount = 1,
  get: GetJson = defaultGetJson,
): Promise<FailoverPlanView> {
  const namespaces = namespacesOf(selection);
  const workloads: ClusterObject[] = [];
  const services: ClusterObject[] = [];
  const ingresses: ClusterObject[] = [];
  const configured: ClusterObject[] = [];
  for (const ns of namespaces) {
    workloads.push(
      ...(await listKind(get, context, "deployments", ns)),
      ...(await listKind(get, context, "statefulsets", ns)),
    );
    services.push(...(await listKind(get, context, "services", ns)));
    ingresses.push(...(await listKind(get, context, "ingresses", ns)));
    configured.push(
      ...(await listKind(get, context, "secrets", ns)),
      ...(await listKind(get, context, "configmaps", ns)),
    );
  }
  if (selection.kind === "workloads") {
    const wanted = new Set(selection.items.map((i) => `${i.kind}/${i.namespace}/${i.name}`));
    workloads.splice(
      0,
      workloads.length,
      ...workloads.filter((w) => wanted.has(`${w.kind}/${w.metadata?.namespace}/${w.metadata?.name}`)),
    );
  }
  if (selection.kind === "app") {
    workloads.splice(
      0,
      workloads.length,
      ...workloads.filter((w) => w.metadata?.name === selection.name),
    );
  }

  const extra = {
    certificates: await listKind(get, context, "certificates.cert-manager.io", "*"),
    middlewares: await listKind(get, context, "middlewares.traefik.io", "*"),
    rolebindings: await listKind(get, context, "rolebindings", "*"),
    clusterrolebindings: await listKind(get, context, "clusterrolebindings", "*"),
    pdbs: await listKind(get, context, "pdb", "*"),
    hpas: await listKind(get, context, "hpa", "*"),
  };
  const members = failoverClosure(workloads, services, ingresses, extra);
  const objects: ClusterObject[] = [...workloads, ...services, ...ingresses];
  const findings = auditPortability(objects, failoverOpsFor("digitalocean").profile(nodeCount));
  const clusters = await listKind(get, context, "clusters.postgresql.cnpg.io", "*");
  const objectStores = await listKind(get, context, "objectstores.barmancloud.cnpg.io", "*");
  const pvcs = await listKind(get, context, "pvc", "*");
  const data = planData({ closure: members, clusters, objectStores, pvcs, acceptedRewrites });
  for (const p of data.plans) {
    if (p.subject.kind !== "Cluster") continue;
    if (members.some((m) => m.kind === "Cluster" && m.namespace === p.subject.namespace && m.name === p.subject.name)) {
      continue;
    }
    members.push({ kind: "Cluster", namespace: p.subject.namespace, name: p.subject.name });
  }
  const inClosure = (o: ClusterObject) =>
    members.some(
      (m) => m.kind === o.kind && m.name === o.metadata?.name && m.namespace === o.metadata?.namespace,
    );
  const endpoints = planEndpointRewrites({
    objects: configured.filter(inClosure),
    services,
    plans: data.plans,
  });
  const routed = workloads.flatMap((w) => {
    const r = routingFor(w, services, ingresses);
    return r.ingresses.length > 0 ? [{ namespace: w.metadata?.namespace ?? "", name: w.metadata?.name ?? "" }] : [];
  });
  const outbound = scaleDownOnReturn(members, routed);
  const workloadsToScale: FailoverWorkload[] = workloads
    .filter((w) => w.kind === "Deployment" || w.kind === "StatefulSet")
    .map((w) => ({
      kind: w.kind ?? "Deployment",
      namespace: w.metadata?.namespace ?? "",
      name: w.metadata?.name ?? "",
      replicas: typeof specReplicas(w) === "number" ? specReplicas(w)! : 1,
    }));
  const blockers = [
    ...findings.filter((f) => f.severity === "blocker"),
    ...findings.filter((f) => f.severity === "rewrite" && !acceptedRewrites.some((a) => a.rule === f.rule)),
    ...data.blockers,
    ...endpoints.blockers,
  ];
  return {
    members,
    findings,
    plans: data.plans,
    blockers,
    outbound,
    workloadsToScale,
    endpointRewrites: endpoints.rewrites,
  };
}

function specReplicas(w: ClusterObject): number | undefined {
  const n = (w.spec as { replicas?: number } | undefined)?.replicas;
  return typeof n === "number" && n >= 0 ? n : undefined;
}

const APPLY_ORDER = [
  "Namespace",
  "Secret",
  "ConfigMap",
  "ServiceAccount",
  "Role",
  "RoleBinding",
  "ClusterRole",
  "ClusterRoleBinding",
  "Certificate",
  "Middleware",
  "PersistentVolumeClaim",
  "Cluster",
  "Deployment",
  "StatefulSet",
  "Service",
  "Ingress",
];

function orderIndex(kind: string): number {
  const i = APPLY_ORDER.indexOf(kind);
  return i === -1 ? APPLY_ORDER.length : i;
}

export interface FailoverRunResult {
  context: string;
  lbAddress: string;
  edgeChange: EdgeChange;
  batchId?: string;
  members: ClosureMember[];
  data: DataCopyResult;
}

async function exportYaml(
  context: string | null,
  m: ClosureMember,
  plans: DataPlan[],
  storageClass: string,
  endpointRewrites: EndpointRewrite[] = [],
): Promise<string | null> {
  if (m.kind === "HelmRelease") return null;
  const kind = m.kind === "Cluster" ? "clusters.postgresql.cnpg.io" : m.kind;
  const args = m.namespace
    ? ["get", kind, m.name, "-n", m.namespace, "-o", "yaml"]
    : ["get", kind, m.name, "-o", "yaml"];
  const res = await kubectl(context, args);
  if (res.code !== 0 || !res.stdout.trim()) return null;
  let yaml = cleanExportedManifest(res.stdout);
  const plan = plans.find(
    (p) => p.subject.kind === "Cluster" && p.subject.name === m.name && p.subject.namespace === m.namespace,
  );
  if (m.kind === "Cluster" && plan?.kind === "pgDump") {
    yaml = rewriteCnpgClusterForDump(yaml, storageClass);
  }
  return applyEndpointRewrites(yaml, endpointRewrites);
}

export async function runFailover(
  sourceContext: string | null,
  selection: FailoverSelection,
  acceptedRewrites: Array<{ rule: string; to: unknown }> = [],
  deps: {
    get?: GetJson;
    apply?: typeof applyManifest;
    provision?: FailoverProviderOps["provision"];
    stack?: FailoverProviderOps["installStack"];
    copyData?: typeof copyDataPlans;
    report?: FailoverReporter;
  } = {},
): Promise<FailoverRunResult> {
  const report: FailoverReporter = deps.report ?? (() => {});
  const step = (id: string, label: string, status: Parameters<FailoverReporter>[0]["status"], detail?: string) =>
    report({ id, label, status, detail });
  const dest = await readFailoverDestination(sourceContext);
  if (!dest) throw new Error("No failover destination is configured");
  const plan = await planFailover(sourceContext, selection, acceptedRewrites, dest.nodeCount, deps.get);
  if (plan.blockers.length > 0) {
    const err = new Error("Failover is blocked until findings are accepted") as Error & { blockers: PortabilityFinding[] };
    err.blockers = plan.blockers;
    throw err;
  }

  const get = deps.get ?? defaultGetJson;
  const apply = deps.apply ?? applyManifest;
  const ops = failoverOpsFor(dest.provider);
  const provision = deps.provision ?? ops.provision;
  const stack = deps.stack ?? ops.installStack;
  const copyData = deps.copyData ?? copyDataPlans;
  const storageClass = failoverOpsFor(dest.provider).profile(dest.nodeCount).defaultStorageClass ?? "do-block-storage";

  const existing = parseFailoverState((await readUserConfig(sourceContext)).data[FAILOVER_STATE_KEY] ?? "");
  let remoteContext = existing.failedOverTo?.context;
  let clusterId = existing.failedOverTo?.clusterId;
  if (remoteContext) {
    step("provision", "Provision DOKS", "skipped", `reusing ${remoteContext}`);
    step("stack", "Install stack", "skipped", "already installed");
  } else {
    step("provision", "Provision DOKS", "running", `${dest.region} · ${dest.nodeCount} × ${dest.nodeSize}`);
    const created = await provision(dest);
    remoteContext = created.context;
    clusterId = created.id;
    step("provision", "Provision DOKS", "done", created.context);
    step("stack", "Install stack", "running", "cert-manager, cloudnative-pg, traefik");
    await stack(remoteContext);
    step("stack", "Install stack", "done", "cert-manager, cloudnative-pg, traefik");
  }

  const rewriteCount = plan.endpointRewrites.length;
  step(
    "rewrite",
    "Rewrite endpoints",
    rewriteCount === 0 ? "skipped" : "running",
    rewriteCount === 0 ? "every address already resolves on the target" : `${rewriteCount} values repointed · home untouched`,
  );
  const sorted = [...plan.members].sort((a, b) => orderIndex(a.kind) - orderIndex(b.kind));
  const yamls: string[] = [];
  for (const m of sorted) {
    const yaml = await exportYaml(sourceContext, m, plan.plans, storageClass, plan.endpointRewrites);
    if (yaml) yamls.push(yaml);
  }
  if (rewriteCount > 0) {
    step("rewrite", "Rewrite endpoints", "done", `${rewriteCount} values repointed · home untouched`);
  }

  step("apply", "Apply closure", "running", `${plan.members.length} objects`);
  const bundle = yamls.join("\n---\n");
  const applied = await apply(remoteContext, bundle, false, "failover");
  step("apply", "Apply closure", "done", `${plan.members.length} objects`);

  step("loadBalancer", "Read load balancer", "running");
  let lbAddress = "";
  const svc = items(await get(remoteContext, ["get", "svc", "-n", "traefik", "-o", "json"]));
  for (const s of svc) {
    const ing = (s as { status?: { loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> } } })
      .status?.loadBalancer?.ingress?.[0];
    lbAddress = ing?.ip ?? ing?.hostname ?? lbAddress;
  }
  step("loadBalancer", "Read load balancer", lbAddress ? "done" : "failed", lbAddress || "no address yet");

  const at = new Date().toISOString();
  const state: FailoverState = {
    failedOverTo: {
      context: remoteContext,
      clusterId,
      at,
      batchId: applied.batchId ?? "",
      lbAddress,
      scaledToZero: plan.workloadsToScale,
      edgeConfirmed: false,
      dataPlans: plan.plans,
    },
  };
  dest.lastSelection = selection;
  await writeUserConfig(sourceContext, () => ({
    [FAILOVER_CONFIG_KEY]: serializeFailoverDestination(dest),
    [FAILOVER_STATE_KEY]: serializeFailoverState(state),
  }));
  await writeUserConfig(remoteContext, () => ({
    [FAILOVER_STATE_KEY]: serializeFailoverState({
      failoverCopyOf: { context: sourceContext ?? "", batchId: applied.batchId ?? "" },
    }),
  }));

  const data = await copyData({
    fromContext: sourceContext,
    toContext: remoteContext,
    plans: plan.plans,
    storageClass,
    onStep: report,
  });

  return {
    context: remoteContext,
    lbAddress,
    edgeChange: edgeChangeFor(lbAddress || "REPLACE_ME", dest.edge),
    batchId: applied.batchId,
    members: plan.members,
    data,
  };
}

export async function readFailoverLiveState(context: string | null): Promise<FailoverState> {
  const read = await readUserConfig(context);
  return parseFailoverState(read.data[FAILOVER_STATE_KEY] ?? "");
}

export async function confirmEdge(context: string | null): Promise<FailoverState> {
  const state = await readFailoverLiveState(context);
  if (!state.failedOverTo) throw new Error("No failover is active");
  state.failedOverTo.edgeConfirmed = true;
  await writeUserConfig(context, () => ({ [FAILOVER_STATE_KEY]: serializeFailoverState(state) }));
  return state;
}

export async function scaleHome(
  context: string | null,
  kubectlRun: (ctx: string | null, args: string[]) => Promise<RunResult> = kubectl,
): Promise<FailoverState> {
  const state = await readFailoverLiveState(context);
  if (!state.failedOverTo) throw new Error("No failover is active");
  if (!state.failedOverTo.edgeConfirmed) {
    const err = new Error("Confirm the edge cutover before scaling home to zero") as Error & { status: number };
    err.status = 409;
    throw err;
  }
  for (const m of state.failedOverTo.scaledToZero) {
    await kubectlRun(context, ["scale", m.kind.toLowerCase(), m.name, "-n", m.namespace, "--replicas=0"]);
  }
  await writeUserConfig(context, () => ({ [FAILOVER_STATE_KEY]: serializeFailoverState(state) }));
  return state;
}

export async function restoreHome(
  context: string | null,
  opts: { localWriteAt?: string } = {},
  deps: {
    kubectl?: typeof kubectl;
    copyData?: typeof copyDataPlans;
    destroy?: FailoverProviderOps["destroy"];
    report?: FailoverReporter;
  } = {},
): Promise<
  | { ok: true; data: DataCopyResult; leftBehind?: FailoverState["leftBehind"] }
  | { ok: false; error: string }
> {
  const kubectlRun = deps.kubectl ?? kubectl;
  const copyData = deps.copyData ?? copyDataPlans;
  const destroy = deps.destroy ?? ((d, id) => failoverOpsFor(d.provider).destroy(d, id));
  const report: FailoverReporter = deps.report ?? (() => {});
  const step = (id: string, label: string, status: Parameters<FailoverReporter>[0]["status"], detail?: string, error?: string) =>
    report({ id, label, status, detail, error });
  const state = await readFailoverLiveState(context);
  if (!state.failedOverTo) return { ok: false, error: "No failover is active" };
  if (localWritesAfterFailover(opts.localWriteAt, state.failedOverTo.at)) {
    return { ok: false, error: "Local writes happened after failover; refusing a wholesale replace" };
  }
  const remote = state.failedOverTo.context;
  const plans = state.failedOverTo.dataPlans ?? [];

  // Writers stop first. CNPG stays up so it can still be dumped.
  step("scaleRemote", "Scale remote writers to zero", "running");
  for (const w of state.failedOverTo.scaledToZero) {
    await kubectlRun(remote, ["scale", w.kind.toLowerCase(), w.name, "-n", w.namespace, "--replicas=0"]);
  }
  step("scaleRemote", "Scale remote writers to zero", "done", `${state.failedOverTo.scaledToZero.length} workloads`);

  const dest = await readFailoverDestination(context);
  const data = await copyData({
    fromContext: remote,
    toContext: context,
    plans,
    storageClass: failoverOpsFor(dest?.provider ?? "digitalocean").profile(dest?.nodeCount ?? 1).defaultStorageClass ?? "do-block-storage",
    onStep: report,
  });

  step("scaleHome", "Scale home replicas back", "running");
  for (const w of state.failedOverTo.scaledToZero) {
    await kubectlRun(context, ["scale", w.kind.toLowerCase(), w.name, "-n", w.namespace, `--replicas=${w.replicas}`]);
  }
  step("scaleHome", "Scale home replicas back", "done", `${state.failedOverTo.scaledToZero.length} workloads`);

  // The data is home either way, so a teardown that fails does not fail the
  // restore. It does get remembered: an undestroyed cluster bills by the hour.
  const clusterId = state.failedOverTo.clusterId;
  let leftBehind: FailoverState["leftBehind"];
  if (dest && clusterId) {
    step("destroy", "Destroy the DOKS cluster", "running", clusterId);
    try {
      await destroy(dest, clusterId);
      step("destroy", "Destroy the DOKS cluster", "done", clusterId);
    } catch (err) {
      const error = (err as Error).message;
      leftBehind = { clusterId, context: remote, at: new Date().toISOString(), error };
      step("destroy", "Destroy the DOKS cluster", "failed", clusterId, error);
    }
  } else {
    step("destroy", "Destroy the DOKS cluster", "skipped", "no cluster id on record");
  }

  await writeUserConfig(context, () => ({
    [FAILOVER_STATE_KEY]: serializeFailoverState(leftBehind ? { leftBehind } : {}),
  }));
  return leftBehind ? { ok: true, data, leftBehind } : { ok: true, data };
}

/** Retries a teardown that failed during a restore, so the bill actually stops. */
export async function teardownLeftBehind(
  context: string | null,
  deps: { destroy?: FailoverProviderOps["destroy"] } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const destroy = deps.destroy ?? ((d, id) => failoverOpsFor(d.provider).destroy(d, id));
  const state = await readFailoverLiveState(context);
  if (!state.leftBehind) return { ok: false, error: "No cluster is recorded as left behind" };
  const dest = await readFailoverDestination(context);
  if (!dest) return { ok: false, error: "No failover destination is configured" };
  try {
    await destroy(dest, state.leftBehind.clusterId);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  await writeUserConfig(context, () => ({ [FAILOVER_STATE_KEY]: "{}" }));
  return { ok: true };
}

export function selectionFromBody(body: unknown): FailoverSelection | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const sel = (o.selection ?? o) as Record<string, unknown>;
  if (sel.kind === "namespace" && typeof sel.namespace === "string") {
    return { kind: "namespace", namespace: sel.namespace };
  }
  if (sel.kind === "app" && typeof sel.name === "string" && typeof sel.namespace === "string") {
    return { kind: "app", name: sel.name, namespace: sel.namespace };
  }
  if (sel.kind === "workloads" && Array.isArray(sel.items)) {
    const items = sel.items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const r = item as Record<string, unknown>;
      if (typeof r.kind === "string" && typeof r.namespace === "string" && typeof r.name === "string") {
        return [{ kind: r.kind, namespace: r.namespace, name: r.name }];
      }
      return [];
    });
    return items.length ? { kind: "workloads", items } : null;
  }
  return null;
}

export function rewritesFromBody(body: unknown): Array<{ rule: string; to: unknown }> {
  if (!body || typeof body !== "object") return [];
  const o = body as Record<string, unknown>;
  return Array.isArray(o.acceptedRewrites) ? (o.acceptedRewrites as Array<{ rule: string; to: unknown }>) : [];
}
