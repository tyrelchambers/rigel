import {
  backendServices,
  podLabelsOf,
  referencedResources,
  routingFor,
  selectorMatches,
  type ClusterObject,
} from "../workloadClosure";

export interface ClosureMember {
  kind: string;
  namespace: string;
  name: string;
}

export interface FailoverCollections {
  certificates?: ClusterObject[];
  middlewares?: ClusterObject[];
  serviceaccounts?: ClusterObject[];
  roles?: ClusterObject[];
  rolebindings?: ClusterObject[];
  clusterroles?: ClusterObject[];
  clusterrolebindings?: ClusterObject[];
  pdbs?: ClusterObject[];
  hpas?: ClusterObject[];
  services?: ClusterObject[];
}

const SVC_HOST = /(?:^|[^A-Za-z0-9-])([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.svc\.cluster\.local\b/g;
const TRAEFIK_MW = "traefik.ingress.kubernetes.io/router.middlewares";
const HELM_MANAGED = "app.kubernetes.io/managed-by";
const HELM_INSTANCE = "app.kubernetes.io/instance";

function nsOf(o: ClusterObject, fallback = ""): string {
  return o.metadata?.namespace ?? fallback;
}

function nameOf(o: ClusterObject): string {
  return o.metadata?.name ?? "";
}

function member(kind: string, namespace: string, name: string): ClosureMember {
  return { kind, namespace, name };
}

function keyOf(m: ClosureMember): string {
  return `${m.kind}/${m.namespace}/${m.name}`;
}

export function ingressTlsSecrets(ingress: ClusterObject): string[] {
  const tls = (ingress.spec as { tls?: Array<{ secretName?: string }> } | undefined)?.tls ?? [];
  return tls.map((t) => t.secretName).filter((n): n is string => typeof n === "string" && n.length > 0);
}

export function middlewareAnnotationValues(ingress: ClusterObject): string[] {
  const ann = (ingress.metadata as { annotations?: Record<string, string> } | undefined)?.annotations;
  const raw = ann?.[TRAEFIK_MW];
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Traefik CRD refs look like `{namespace}-{name}@kubernetescrd`. Match against
 *  live Middleware objects rather than guessing where the dash splits. */
export function middlewaresForIngress(
  ingress: ClusterObject,
  middlewares: ClusterObject[],
): ClusterObject[] {
  const refs = new Set(
    middlewareAnnotationValues(ingress).map((v) => v.replace(/@kubernetescrd$/, "")),
  );
  if (refs.size === 0) return [];
  return middlewares.filter((mw) => refs.has(`${nsOf(mw)}-${nameOf(mw)}`));
}

export function crossNamespaceServiceRefs(workload: ClusterObject): Array<{ namespace: string; name: string }> {
  const spec = workload.spec as { template?: { spec?: Record<string, unknown> } } | undefined;
  const pod = (spec?.template?.spec ?? {}) as {
    containers?: Array<{ env?: Array<{ name?: string; value?: string }> }>;
    initContainers?: Array<{ env?: Array<{ name?: string; value?: string }> }>;
  };
  const found: Array<{ namespace: string; name: string }> = [];
  const seen = new Set<string>();
  const home = nsOf(workload);
  for (const container of [...(pod.containers ?? []), ...(pod.initContainers ?? [])]) {
    for (const variable of container.env ?? []) {
      const value = variable.value;
      if (typeof value !== "string") continue;
      SVC_HOST.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SVC_HOST.exec(value))) {
        const name = m[1]!;
        const namespace = m[2]!;
        if (namespace === home) continue;
        const k = `${namespace}/${name}`;
        if (seen.has(k)) continue;
        seen.add(k);
        found.push({ namespace, name });
      }
    }
  }
  return found;
}

export function helmReleaseOf(workload: ClusterObject): { name: string; namespace: string } | undefined {
  const labels = (workload.metadata as { labels?: Record<string, string> } | undefined)?.labels;
  if (labels?.[HELM_MANAGED] !== "Helm") return undefined;
  const name = labels[HELM_INSTANCE];
  if (!name) return undefined;
  return { name, namespace: nsOf(workload) };
}

function subjectMatchesSa(
  subjects: Array<{ kind?: string; name?: string; namespace?: string }> | undefined,
  sa: { name: string; namespace: string },
): boolean {
  return (subjects ?? []).some(
    (s) => s.kind === "ServiceAccount" && s.name === sa.name && (s.namespace ?? sa.namespace) === sa.namespace,
  );
}

export function rbacForServiceAccount(
  sa: { name: string; namespace: string },
  extra: FailoverCollections,
): ClosureMember[] {
  const out: ClosureMember[] = [member("ServiceAccount", sa.namespace, sa.name)];
  for (const rb of extra.rolebindings ?? []) {
    const subjects = (rb as { subjects?: Array<{ kind?: string; name?: string; namespace?: string }> }).subjects;
    if (!subjectMatchesSa(subjects, sa)) continue;
    out.push(member("RoleBinding", nsOf(rb, sa.namespace), nameOf(rb)));
    const ref = (rb as { roleRef?: { kind?: string; name?: string } }).roleRef;
    if (ref?.kind === "Role" && ref.name) out.push(member("Role", nsOf(rb, sa.namespace), ref.name));
    if (ref?.kind === "ClusterRole" && ref.name) out.push(member("ClusterRole", "", ref.name));
  }
  for (const crb of extra.clusterrolebindings ?? []) {
    const subjects = (crb as { subjects?: Array<{ kind?: string; name?: string; namespace?: string }> }).subjects;
    if (!subjectMatchesSa(subjects, sa)) continue;
    out.push(member("ClusterRoleBinding", "", nameOf(crb)));
    const ref = (crb as { roleRef?: { kind?: string; name?: string } }).roleRef;
    if (ref?.kind === "ClusterRole" && ref.name) out.push(member("ClusterRole", "", ref.name));
  }
  return out;
}

function selectorOf(o: ClusterObject): Record<string, string> | undefined {
  const sel = (o.spec as { selector?: { matchLabels?: Record<string, string> } | Record<string, string> } | undefined)
    ?.selector;
  if (!sel) return undefined;
  const matchLabels = (sel as { matchLabels?: Record<string, string> }).matchLabels;
  if (matchLabels && typeof matchLabels === "object") return matchLabels;
  return sel as Record<string, string>;
}

/** Workloads plus every restore-breaking dependency the runbook found. */
export function failoverClosure(
  workloads: ClusterObject[],
  services: ClusterObject[],
  ingresses: ClusterObject[],
  extra: FailoverCollections = {},
): ClosureMember[] {
  const out: ClosureMember[] = [];
  const seen = new Set<string>();
  const add = (m: ClosureMember) => {
    if (!m.name) return;
    const k = keyOf(m);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(m);
  };

  for (const workload of workloads) {
    const namespace = nsOf(workload, "default");
    add(member(workload.kind ?? "Deployment", namespace, nameOf(workload)));
    for (const ref of referencedResources(workload)) {
      const kind =
        ref.kind === "configmap"
          ? "ConfigMap"
          : ref.kind === "secret"
            ? "Secret"
            : ref.kind === "persistentvolumeclaim"
              ? "PersistentVolumeClaim"
              : ref.kind;
      add(member(kind, namespace, ref.name));
    }
    const saName = (
      workload.spec as { template?: { spec?: { serviceAccountName?: string } } } | undefined
    )?.template?.spec?.serviceAccountName;
    if (saName && saName !== "default") {
      for (const m of rbacForServiceAccount({ name: saName, namespace }, extra)) add(m);
    }

    const routing = routingFor(workload, services, ingresses);
    for (const name of routing.services) add(member("Service", namespace, name));
    for (const name of routing.ingresses) {
      add(member("Ingress", namespace, name));
      const ing = ingresses.find((i) => nameOf(i) === name && nsOf(i, namespace) === namespace);
      if (!ing) continue;
      for (const secret of ingressTlsSecrets(ing)) {
        add(member("Secret", namespace, secret));
        for (const cert of extra.certificates ?? []) {
          const secretName = (cert.spec as { secretName?: string } | undefined)?.secretName;
          if (secretName === secret) add(member("Certificate", nsOf(cert, namespace), nameOf(cert)));
        }
      }
      for (const mw of middlewaresForIngress(ing, extra.middlewares ?? [])) {
        add(member("Middleware", nsOf(mw), nameOf(mw)));
      }
    }

    const labels = podLabelsOf(workload);
    for (const pdb of extra.pdbs ?? []) {
      const sel = selectorOf(pdb);
      if (sel && selectorMatches(sel, labels)) add(member("PodDisruptionBudget", nsOf(pdb, namespace), nameOf(pdb)));
    }
    for (const hpa of extra.hpas ?? []) {
      const target = (hpa.spec as { scaleTargetRef?: { kind?: string; name?: string } } | undefined)?.scaleTargetRef;
      const hpaSel = selectorOf(hpa);
      const matchesTarget =
        target?.name === nameOf(workload) &&
        (!target.kind || target.kind === (workload.kind ?? "Deployment"));
      const matchesSelector = hpaSel ? selectorMatches(hpaSel, labels) : false;
      if (matchesTarget || matchesSelector) {
        add(member("HorizontalPodAutoscaler", nsOf(hpa, namespace), nameOf(hpa)));
      }
    }

    for (const svc of crossNamespaceServiceRefs(workload)) {
      add(member("Service", svc.namespace, svc.name));
    }

    const helm = helmReleaseOf(workload);
    if (helm) add(member("HelmRelease", helm.namespace, helm.name));
  }

  return out;
}
