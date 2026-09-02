// What actually belongs to one workload, by following the cluster rather than
// by matching names.
//
// The purge engine finds an app by instance label with a name-prefix fallback,
// which is right for a removal flow where the operator reads and confirms the
// list. It is wrong for adoption: asked for reddex-deploy it also returned
// reddex-custom-website-deploy and reddex-custom-nextjs-deploy, a different app
// that merely shares a prefix, and committing those into the repo would put a
// second app's manifests under the first one's name.
//
// Kubernetes already states these relationships, so nothing here guesses: a
// Deployment names its pod labels, a Service names the labels it selects, an
// Ingress names the Service behind it, and a pod spec names every ConfigMap,
// Secret and PVC it mounts or reads.

export interface ClusterObject {
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  data?: Record<string, string>;
  stringData?: Record<string, string>;
  subjects?: Array<{ kind?: string; name?: string; namespace?: string }>;
  roleRef?: { kind?: string; name?: string };
}

export interface ClosureRef {
  kind: string;
  name: string;
}

/** Whether every label in `selector` is present and equal in `labels`. */
export function selectorMatches(selector: Record<string, string>, labels: Record<string, string>): boolean {
  const keys = Object.keys(selector);
  if (keys.length === 0) return false;
  return keys.every((k) => labels[k] === selector[k]);
}

/** The pod labels a workload gives the things it creates. */
export function podLabelsOf(workload: ClusterObject): Record<string, string> {
  const spec = workload.spec as
    | { selector?: { matchLabels?: Record<string, string> }; template?: { metadata?: { labels?: Record<string, string> } } }
    | undefined;
  return spec?.selector?.matchLabels ?? spec?.template?.metadata?.labels ?? {};
}

/** Every ConfigMap, Secret and PVC the pod template actually references. */
export function referencedResources(workload: ClusterObject): ClosureRef[] {
  const out: ClosureRef[] = [];
  const seen = new Set<string>();
  const add = (kind: string, name: unknown) => {
    if (typeof name !== "string" || !name) return;
    const key = `${kind}/${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, name });
  };

  const spec = workload.spec as { template?: { spec?: Record<string, unknown> } } | undefined;
  const pod = (spec?.template?.spec ?? {}) as {
    containers?: Array<Record<string, unknown>>;
    initContainers?: Array<Record<string, unknown>>;
    volumes?: Array<Record<string, unknown>>;
    imagePullSecrets?: Array<{ name?: string }>;
    serviceAccountName?: string;
  };

  for (const container of [...(pod.containers ?? []), ...(pod.initContainers ?? [])]) {
    for (const source of (container.envFrom as Array<Record<string, { name?: string }>>) ?? []) {
      add("configmap", source.configMapRef?.name);
      add("secret", source.secretRef?.name);
    }
    for (const variable of (container.env as Array<{ valueFrom?: Record<string, { name?: string }> }>) ?? []) {
      add("configmap", variable.valueFrom?.configMapKeyRef?.name);
      add("secret", variable.valueFrom?.secretKeyRef?.name);
    }
  }
  for (const volume of pod.volumes ?? []) {
    add("configmap", (volume.configMap as { name?: string } | undefined)?.name);
    add("secret", (volume.secret as { secretName?: string } | undefined)?.secretName);
    add(
      "persistentvolumeclaim",
      (volume.persistentVolumeClaim as { claimName?: string } | undefined)?.claimName,
    );
  }
  for (const pull of pod.imagePullSecrets ?? []) add("secret", pull.name);
  return out;
}

/**
 * The Services that actually target this workload's pods, and the Ingresses
 * that actually route to those Services. Name similarity is never consulted.
 */
export function routingFor(
  workload: ClusterObject,
  services: ClusterObject[],
  ingresses: ClusterObject[],
): { services: string[]; ingresses: string[] } {
  const labels = podLabelsOf(workload);
  const matched = services
    .filter((svc) => {
      const selector = (svc.spec as { selector?: Record<string, string> } | undefined)?.selector;
      return selector ? selectorMatches(selector, labels) : false;
    })
    .map((svc) => svc.metadata?.name ?? "")
    .filter(Boolean);

  const names = new Set(matched);
  const routed = ingresses
    .filter((ing) => backendServices(ing).some((name) => names.has(name)))
    .map((ing) => ing.metadata?.name ?? "")
    .filter(Boolean);

  return { services: matched, ingresses: routed };
}

/** Every Service an Ingress sends traffic to, across both API shapes. */
export function backendServices(ingress: ClusterObject): string[] {
  const spec = ingress.spec as
    | {
        defaultBackend?: { service?: { name?: string } };
        rules?: Array<{ http?: { paths?: Array<{ backend?: { service?: { name?: string }; serviceName?: string } }> } }>;
      }
    | undefined;
  const out: string[] = [];
  const push = (name?: string) => {
    if (name) out.push(name);
  };
  push(spec?.defaultBackend?.service?.name);
  for (const rule of spec?.rules ?? []) {
    for (const path of rule.http?.paths ?? []) {
      push(path.backend?.service?.name);
      push(path.backend?.serviceName);
    }
  }
  return out;
}
