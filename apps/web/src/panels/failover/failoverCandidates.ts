import type { FailoverSubject } from "@/lib/api";

/** A workload the failover could carry, as the picker shows it. */
export interface FailoverCandidate {
  kind: "Deployment" | "StatefulSet";
  namespace: string;
  name: string;
  replicas: number;
  /** Hosts an Ingress routes to this workload's Service, if any. */
  hosts: string[];
}

interface WatchedWorkload {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: {
    replicas?: number;
    selector?: { matchLabels?: Record<string, string> };
    template?: { metadata?: { labels?: Record<string, string> } };
  };
}

interface WatchedService {
  metadata?: { name?: string; namespace?: string };
  spec?: { selector?: Record<string, string> };
}

interface WatchedIngress {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    rules?: Array<{
      host?: string;
      http?: { paths?: Array<{ backend?: { service?: { name?: string } } }> };
    }>;
  };
}

/** Namespaces that are cluster plumbing rather than someone's app. */
const SYSTEM_NAMESPACES = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "cert-manager",
  "cnpg-system",
  "tailscale",
  "system-upgrade",
]);

export function isSystemNamespace(namespace: string): boolean {
  return SYSTEM_NAMESPACES.has(namespace) || namespace.startsWith("kube-");
}

function labelsMatch(selector: Record<string, string>, labels: Record<string, string>): boolean {
  const keys = Object.keys(selector);
  if (keys.length === 0) return false;
  return keys.every((k) => labels[k] === selector[k]);
}

function podLabels(w: WatchedWorkload): Record<string, string> {
  return w.spec?.template?.metadata?.labels ?? w.spec?.selector?.matchLabels ?? {};
}

/**
 * Workloads the user can pick from, newest naming first: every Deployment and
 * StatefulSet outside cluster plumbing, annotated with the hosts that reach it.
 */
export function failoverCandidates(
  workloads: WatchedWorkload[],
  services: WatchedService[],
  ingresses: WatchedIngress[],
): FailoverCandidate[] {
  const out: FailoverCandidate[] = [];
  for (const w of workloads) {
    const namespace = w.metadata?.namespace ?? "";
    const name = w.metadata?.name ?? "";
    if (!name || isSystemNamespace(namespace)) continue;
    const kind = w.kind === "StatefulSet" ? "StatefulSet" : "Deployment";

    const labels = podLabels(w);
    const serving = services
      .filter((s) => s.metadata?.namespace === namespace)
      .filter((s) => s.spec?.selector && labelsMatch(s.spec.selector, labels))
      .map((s) => s.metadata?.name);
    const hosts = new Set<string>();
    for (const ing of ingresses) {
      if (ing.metadata?.namespace !== namespace) continue;
      for (const rule of ing.spec?.rules ?? []) {
        const backs = (rule.http?.paths ?? []).some((p) => serving.includes(p.backend?.service?.name));
        if (backs && rule.host) hosts.add(rule.host);
      }
    }

    out.push({
      kind,
      namespace,
      name,
      replicas: typeof w.spec?.replicas === "number" ? w.spec.replicas : 1,
      hosts: [...hosts],
    });
  }
  return out.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

export function candidateKey(c: Pick<FailoverCandidate, "kind" | "namespace" | "name">): string {
  return `${c.kind}/${c.namespace}/${c.name}`;
}

/** What a checked row is worth saying about itself before a plan exists. */
export function candidateDetail(c: FailoverCandidate): string {
  const scale = `${c.kind.toLowerCase()} · ${c.replicas} replica${c.replicas === 1 ? "" : "s"}`;
  if (c.hosts.length > 0) return `${scale} · ${c.hosts.join(", ")}`;
  return `${scale} · no Ingress, outbound actor`;
}

export function selectionFromCandidates(picked: FailoverCandidate[]): {
  kind: "workloads";
  items: FailoverSubject[];
} {
  return {
    kind: "workloads",
    items: picked.map((c) => ({ kind: c.kind, namespace: c.namespace, name: c.name })),
  };
}
