import { kubectl } from "@rigel/k8s/src/run";
import type { RunResult } from "@rigel/k8s/src/run";

/** A selectable cluster, derived from one kubeconfig context. */
export interface ClusterContext {
  /** The kubeconfig context name (what `--context` takes). */
  name: string;
  /** The cluster ref this context points at. */
  cluster: string;
  /** The resolved API server URL ("" when unknown). */
  server: string;
  /** True for the kubeconfig's current-context. */
  active: boolean;
}

interface KubeConfigView {
  "current-context"?: string;
  contexts?: { name: string; context?: { cluster?: string } }[];
  clusters?: { name: string; cluster?: { server?: string } }[];
}

/**
 * Pure: turn a parsed `kubectl config view -o json` object into the selectable
 * context list. The active context is the view's current-context; each context's
 * server is resolved by following its cluster ref into the clusters list.
 */
export function parseContexts(view: KubeConfigView): ClusterContext[] {
  const current = view["current-context"] ?? null;
  const serverByCluster = new Map<string, string>();
  for (const c of view.clusters ?? []) serverByCluster.set(c.name, c.cluster?.server ?? "");
  return (view.contexts ?? []).map((c) => {
    const cluster = c.context?.cluster ?? "";
    return {
      name: c.name,
      cluster,
      server: serverByCluster.get(cluster) ?? "",
      active: c.name === current,
    };
  });
}

/**
 * Enumerate the kubeconfig's contexts. `run` is injectable for tests; in
 * production it runs context-less `kubectl config view -o json`. Returns [] when
 * kubectl fails or the output isn't valid JSON (the client renders an empty rail).
 */
export async function listContexts(
  run: (args: string[]) => Promise<RunResult> = (args) => kubectl(null, args),
): Promise<ClusterContext[]> {
  const res = await run(["config", "view", "-o", "json"]);
  if (res.code !== 0) return [];
  try {
    return parseContexts(JSON.parse(res.stdout) as KubeConfigView);
  } catch {
    return [];
  }
}
