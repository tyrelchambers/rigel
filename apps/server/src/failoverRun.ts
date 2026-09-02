import { kubectl, type RunResult } from "@rigel/k8s/src/run";
import { cleanExportedManifest } from "@rigel/k8s/src/manifestClean";
import { failoverClosure, type ClosureMember } from "@rigel/k8s/src/failover/closure";
import { auditPortability } from "@rigel/k8s/src/failover/portabilityAudit";
import { planData } from "@rigel/k8s/src/failover/dataPlans";
import { edgeChangeFor, type EdgeChange } from "@rigel/k8s/src/failover/edgeChange";
import { bothSidesNonZero, localWritesAfterFailover, scaleDownOnReturn } from "@rigel/k8s/src/failover/splitBrain";
import { parseFailoverState, serializeFailoverState } from "@rigel/k8s/src/failover/state";
import { serializeFailoverDestination } from "@rigel/k8s/src/failover/destination";
import type {
  DataPlan,
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
import { destroyDoks, installFailoverStack, provisionDoks } from "./failoverProvision";

export const DOKS_PROFILE = (nodeCount: number): TargetProfile => ({
  storageClasses: ["do-block-storage"],
  defaultStorageClass: "do-block-storage",
  ingressClasses: ["traefik"],
  loadBalancerKind: "LoadBalancer",
  hasCertManager: true,
  hasCnpg: true,
  hasTraefikCrds: true,
  nodeCount,
});

type GetJson = (context: string | null, args: string[]) => Promise<unknown>;

const defaultGetJson: GetJson = async (context, args) => {
  const res = await kubectl(context, args);
  if (res.code !== 0) return { items: [] };
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { items: [] };
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
  for (const ns of namespaces) {
    workloads.push(
      ...(await listKind(get, context, "deployments", ns)),
      ...(await listKind(get, context, "statefulsets", ns)),
    );
    services.push(...(await listKind(get, context, "services", ns)));
    ingresses.push(...(await listKind(get, context, "ingresses", ns)));
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
  const findings = auditPortability(objects, DOKS_PROFILE(nodeCount));
  const clusters = await listKind(get, context, "clusters.postgresql.cnpg.io", "*");
  const objectStores = await listKind(get, context, "objectstores.barmancloud.cnpg.io", "*");
  const pvcs = await listKind(get, context, "pvc", "*");
  const data = planData({ closure: members, clusters, objectStores, pvcs, acceptedRewrites });
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
  ];
  return { members, findings, plans: data.plans, blockers, outbound, workloadsToScale };
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
}

async function exportYaml(context: string | null, m: ClosureMember): Promise<string | null> {
  if (m.kind === "HelmRelease") return null;
  const args = m.namespace
    ? ["get", m.kind, m.name, "-n", m.namespace, "-o", "yaml"]
    : ["get", m.kind, m.name, "-o", "yaml"];
  const res = await kubectl(context, args);
  if (res.code !== 0 || !res.stdout.trim()) return null;
  return cleanExportedManifest(res.stdout);
}

export async function runFailover(
  sourceContext: string | null,
  selection: FailoverSelection,
  acceptedRewrites: Array<{ rule: string; to: unknown }> = [],
  deps: { get?: GetJson; apply?: typeof applyManifest; provision?: typeof provisionDoks; stack?: typeof installFailoverStack } = {},
): Promise<FailoverRunResult> {
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
  const provision = deps.provision ?? provisionDoks;
  const stack = deps.stack ?? installFailoverStack;

  const existing = parseFailoverState((await readUserConfig(sourceContext)).data[FAILOVER_STATE_KEY] ?? "");
  let remoteContext = existing.failedOverTo?.context;
  let clusterId = existing.failedOverTo?.clusterId;
  if (!remoteContext) {
    const created = await provision(dest);
    remoteContext = created.context;
    clusterId = created.id;
    await stack(remoteContext);
  }

  const sorted = [...plan.members].sort((a, b) => orderIndex(a.kind) - orderIndex(b.kind));
  const yamls: string[] = [];
  for (const m of sorted) {
    const yaml = await exportYaml(sourceContext, m);
    if (yaml) yamls.push(yaml);
  }
  const bundle = yamls.join("\n---\n");
  const applied = await apply(remoteContext, bundle, false, "failover");

  let lbAddress = "";
  const svc = items(await get(remoteContext, ["get", "svc", "-n", "traefik", "-o", "json"]));
  for (const s of svc) {
    const ing = (s.status as { loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> } } | undefined)
      ?.loadBalancer?.ingress?.[0];
    lbAddress = ing?.ip ?? ing?.hostname ?? lbAddress;
  }

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

  return {
    context: remoteContext,
    lbAddress,
    edgeChange: edgeChangeFor(lbAddress || "REPLACE_ME"),
    batchId: applied.batchId,
    members: plan.members,
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
): Promise<{ ok: true } | { ok: false; error: string }> {
  const state = await readFailoverLiveState(context);
  if (!state.failedOverTo) return { ok: false, error: "No failover is active" };
  if (localWritesAfterFailover(opts.localWriteAt, state.failedOverTo.at)) {
    return { ok: false, error: "Local writes happened after failover; refusing a wholesale replace" };
  }
  if (
    bothSidesNonZero(
      state.failedOverTo.scaledToZero.map((s) => ({ name: s.name, replicas: 0 })),
      [{ name: "remote", replicas: 1 }],
    )
  ) {
    /* remote still up is expected until we scale it down first */
  }
  for (const w of state.failedOverTo.scaledToZero) {
    await kubectl(context, ["scale", w.kind.toLowerCase(), w.name, "-n", w.namespace, `--replicas=${w.replicas}`]);
  }
  const dest = await readFailoverDestination(context);
  const clusterId = state.failedOverTo.clusterId;
  if (dest && clusterId) {
    await destroyDoks(dest, clusterId).catch(() => undefined);
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
