// packages/audit-cli/src/gather.ts
// Pure(ish) functions that fetch raw kubectl JSON via an injected KubectlRunner
// and shape it into the inputs the pure audit engines (@rigel/k8s) consume.
// No engine logic lives here — this is purely the live-cluster -> engine-input
// adapter, mirroring what the web Zustand store already hands to
// extractAuditInputs.
import {
  extractAuditInputs,
  extractHaAuditInputs,
  type ReliabilityAuditInput,
  type HaAuditInput,
} from "@rigel/k8s";
import {
  detectAllBackendsFromServices,
  pickBackend,
  type PromBackend,
  type ServiceJson,
} from "@rigel/k8s/src/prometheus";
import { fetchUsage, windowStatsFromUsage } from "@rigel/k8s/src/usage";
import type { PerfUsageProvider } from "@rigel/k8s";
import type { KubectlRunner } from "./kubectl";

/** The five kinds the reliability/security/performance audits need, fetched in
 *  one `kubectl get` call (kubectl returns one List with all objects mixed
 *  together in `items`, each still tagged with its own singular `kind`). */
const WORKLOAD_KINDS =
  "deployments,statefulsets,daemonsets,poddisruptionbudgets,horizontalpodautoscalers";

/** Maps a raw object's `.kind` (as kubectl reports it, singular/PascalCase) to
 *  the watch-kind key `extractAuditInputs` slices resources by. */
const KIND_TO_WATCH_KEY: Record<string, string> = {
  Node: "nodes",
  Deployment: "deployments",
  StatefulSet: "statefulsets",
  DaemonSet: "daemonsets",
  PodDisruptionBudget: "poddisruptionbudgets",
  HorizontalPodAutoscaler: "horizontalpodautoscalers",
};

/** The HA audit is cluster-scoped: node topology plus the two critical singletons
 *  (CoreDNS, ingress) and their PodDisruptionBudgets, fetched in one call. */
const HA_KINDS = "nodes,deployments,poddisruptionbudgets";

interface ListItem {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  [key: string]: unknown;
}

/**
 * Group a flat kubectl `List.items` array into the
 * `{ <watchKind>: { "<namespace>/<name>": obj } }` map `extractAuditInputs`
 * expects (mirrors how the web Zustand store keys resources by kind then name).
 */
export function groupByKind(items: ListItem[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const item of items) {
    const key = item.kind ? KIND_TO_WATCH_KEY[item.kind] : undefined;
    if (!key) continue;
    const ns = item.metadata?.namespace ?? "default";
    const name = item.metadata?.name ?? "";
    (out[key] ??= {})[`${ns}/${name}`] = item;
  }
  return out;
}

function nsArgs(namespace?: string): string[] {
  return namespace ? ["-n", namespace] : ["-A"];
}

/** Fetch workloads + PDBs + HPAs (scoped to `namespace`, or all namespaces when
 *  omitted) and adapt them into a ReliabilityAuditInput (the shared shape all
 *  three engines build their own input from). */
export async function gatherWorkloadResources(
  runner: KubectlRunner,
  namespace?: string,
): Promise<ReliabilityAuditInput> {
  const stdout = await runner(["get", WORKLOAD_KINDS, ...nsArgs(namespace), "-o", "json"]);
  const parsed = JSON.parse(stdout) as { items?: ListItem[] };
  const grouped = groupByKind(Array.isArray(parsed.items) ? parsed.items : []);
  return extractAuditInputs(grouped);
}

/** Fetch nodes + CoreDNS/ingress deployments + PDBs (always cluster-wide — HA is
 *  a whole-cluster property) and adapt them into an HaAuditInput. */
export async function gatherHaResources(runner: KubectlRunner): Promise<HaAuditInput> {
  const stdout = await runner(["get", HA_KINDS, "-A", "-o", "json"]);
  const parsed = JSON.parse(stdout) as { items?: ListItem[] };
  const grouped = groupByKind(Array.isArray(parsed.items) ? parsed.items : []);
  return extractHaAuditInputs(grouped);
}

/** Detect the best available Prometheus/VictoriaMetrics backend in the
 *  cluster, or null when none is installed. */
export async function detectBackend(runner: KubectlRunner): Promise<PromBackend | null> {
  const stdout = await runner(["get", "services", "-A", "-o", "json"]);
  const parsed = JSON.parse(stdout) as { items?: ServiceJson[] };
  return pickBackend(detectAllBackendsFromServices(Array.isArray(parsed.items) ? parsed.items : []));
}

/** Build a PerfUsageProvider backed by real 30-day usage history from
 *  `backend`, scoped to `namespace` (all namespaces when omitted). Returns
 *  `undefined` for a (namespace, workload, container) with no matching pods —
 *  the performance engine then skips its metrics-based checks for it. */
export async function gatherUsageProvider(
  runner: KubectlRunner,
  backend: PromBackend,
  namespace?: string,
): Promise<PerfUsageProvider> {
  const rows = await fetchUsage(runner, backend, namespace ?? "*");
  return (ns, workload, container) => {
    const stats = windowStatsFromUsage(rows, ns, workload, container);
    if (stats.hoursCovered === 0) return undefined;
    return { cpuPeak: stats.cpuPeak, memPeak: stats.memPeak, hoursCovered: stats.hoursCovered };
  };
}
