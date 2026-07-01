/**
 * Pure relationship resolver. Operates on RAW k8s objects from the store
 * (resources[kind][nsName]) — the full JSON, which is richer than the panels'
 * narrow TS types — so it reads nested fields defensively with `any`.
 */
export type RelatedStatus = "ok" | "warn" | "missing";

export interface RelatedRef {
  kind: string; // store kind (plural), e.g. "pods", "services", "configmaps"
  name: string;
  namespace?: string;
  key: string; // store key: `${namespace}/${name}` (bare name if cluster-scoped)
  uid?: string;
  status: RelatedStatus;
  node?: string; // pods only: the node the pod is scheduled on (spec.nodeName)
}
export interface RelatedGroup { kind: string; label: string; icon: string; items: RelatedRef[]; }

type Obj = Record<string, any>;
type Slice = Record<string, any>;
type Store = Record<string, Slice>;

const GROUP_META: Record<string, { label: string; icon: string }> = {
  pods: { label: "Pods", icon: "box" },
  services: { label: "Services", icon: "share-2" },
  configmaps: { label: "ConfigMaps", icon: "file-text" },
  secrets: { label: "Secrets", icon: "key-round" },
  persistentvolumeclaims: { label: "PVCs", icon: "database" },
  deployments: { label: "Deployment", icon: "layers" },
  statefulsets: { label: "StatefulSet", icon: "layers" },
  daemonsets: { label: "DaemonSet", icon: "layers" },
  jobs: { label: "Jobs", icon: "layers" },
  ingresses: { label: "Ingresses", icon: "route" },
  nodes: { label: "Node", icon: "server" },
};

export function selectorMatches(
  selector: Record<string, string> | undefined,
  labels: Record<string, string> | undefined,
): boolean {
  const sel = selector ?? {};
  const keys = Object.keys(sel);
  if (keys.length === 0) return false;
  const l = labels ?? {};
  return keys.every((k) => l[k] === sel[k]);
}

export function podRefs(podSpec: Obj | undefined): { configmaps: string[]; secrets: string[]; pvcs: string[] } {
  const cms = new Set<string>(), secs = new Set<string>(), pvcs = new Set<string>();
  const containers = [...(podSpec?.containers ?? []), ...(podSpec?.initContainers ?? [])];
  for (const c of containers) {
    for (const ef of c?.envFrom ?? []) {
      if (ef?.configMapRef?.name) cms.add(ef.configMapRef.name);
      if (ef?.secretRef?.name) secs.add(ef.secretRef.name);
    }
    for (const e of c?.env ?? []) {
      const vf = e?.valueFrom;
      if (vf?.configMapKeyRef?.name) cms.add(vf.configMapKeyRef.name);
      if (vf?.secretKeyRef?.name) secs.add(vf.secretKeyRef.name);
    }
  }
  for (const v of podSpec?.volumes ?? []) {
    if (v?.configMap?.name) cms.add(v.configMap.name);
    if (v?.secret?.secretName) secs.add(v.secret.secretName);
    if (v?.persistentVolumeClaim?.claimName) pvcs.add(v.persistentVolumeClaim.claimName);
    for (const s of v?.projected?.sources ?? []) {
      if (s?.configMap?.name) cms.add(s.configMap.name);
      if (s?.secret?.name) secs.add(s.secret.name);
    }
  }
  for (const ips of podSpec?.imagePullSecrets ?? []) if (ips?.name) secs.add(ips.name);
  return { configmaps: [...cms], secrets: [...secs], pvcs: [...pvcs] };
}

const WORKLOAD_KINDS = ["deployments", "statefulsets", "daemonsets"];

export function relatedKindsFor(sourceKind: string): string[] {
  switch (sourceKind) {
    case "deployment":
    case "statefulset":
    case "daemonset":
      return ["pods", "services", "configmaps", "secrets", "persistentvolumeclaims"];
    case "pod":
      return [...WORKLOAD_KINDS, "services", "configmaps", "secrets", "persistentvolumeclaims", "nodes"];
    case "ingress":
      return ["services", "pods", "secrets"];
    case "service":
      return ["pods", "ingresses"];
    case "job":
      return ["pods", "configmaps", "secrets", "persistentvolumeclaims"];
    case "cronjob":
      return ["jobs"];
    default:
      return [];
  }
}

function ns(o: Obj): string { return o?.metadata?.namespace ?? "default"; }
function values(slice: Slice | undefined): Obj[] { return slice ? Object.values(slice) : []; }
function sameNs(o: Obj, n: string): boolean { return (o?.metadata?.namespace ?? "default") === n; }

function ownedByUid(child: Obj, uid: string | undefined): boolean {
  if (!uid) return false;
  return (child?.metadata?.ownerReferences ?? []).some((r: Obj) => r?.uid === uid);
}

function podStatus(pod: Obj): RelatedStatus {
  const phase = pod?.status?.phase;
  const cs: any[] = pod?.status?.containerStatuses ?? [];
  const ready = cs.length > 0 && cs.every((c) => c?.ready);
  return phase === "Running" && ready ? "ok" : "warn";
}

function refFromObj(kind: string, o: Obj, status: RelatedStatus = "ok"): RelatedRef {
  const n = o?.metadata?.namespace;
  const name = o?.metadata?.name;
  return { kind, name, namespace: n, key: n ? `${n}/${name}` : name, uid: o?.metadata?.uid, status };
}
function missingRef(kind: string, name: string, namespace: string): RelatedRef {
  return { kind, name, namespace, key: `${namespace}/${name}`, status: "missing" };
}

// Resolve referenced names against a slice, flagging missing ones (only once the
// slice has loaded — an absent slice yields ok refs so we don't false-flag).
function refsByName(kind: string, names: string[], namespace: string, slice: Slice | undefined): RelatedRef[] {
  return names.map((name) => {
    const obj = slice?.[`${namespace}/${name}`];
    if (obj) return refFromObj(kind, obj);
    if (slice) return missingRef(kind, name, namespace);
    return { kind, name, namespace, key: `${namespace}/${name}`, status: "ok" as RelatedStatus };
  });
}

function group(kind: string, items: RelatedRef[]): RelatedGroup | null {
  if (items.length === 0) return null;
  const meta = GROUP_META[kind] ?? { label: kind, icon: "box" };
  return { kind, label: meta.label, icon: meta.icon, items };
}

function podsForSelector(selector: Obj | undefined, namespace: string, store: Store): RelatedRef[] {
  return values(store.pods)
    .filter((p) => sameNs(p, namespace) && selectorMatches(selector, p?.metadata?.labels))
    .map((p) => ({ ...refFromObj("pods", p, podStatus(p)), node: p?.spec?.nodeName }));
}

export function computeRelated(sourceKind: string, source: Obj, store: Store): RelatedGroup[] {
  const n = ns(source);
  const groups: (RelatedGroup | null)[] = [];

  if (["deployment", "statefulset", "daemonset"].includes(sourceKind)) {
    const tmpl = source?.spec?.template;
    const podLabels = tmpl?.metadata?.labels;
    groups.push(group("pods", podsForSelector(source?.spec?.selector?.matchLabels, n, store)));
    groups.push(group("services", values(store.services)
      .filter((s) => sameNs(s, n) && selectorMatches(s?.spec?.selector, podLabels))
      .map((s) => refFromObj("services", s))));
    const refs = podRefs(tmpl?.spec);
    groups.push(group("configmaps", refsByName("configmaps", refs.configmaps, n, store.configmaps)));
    groups.push(group("secrets", refsByName("secrets", refs.secrets, n, store.secrets)));
    groups.push(group("persistentvolumeclaims", refsByName("persistentvolumeclaims", refs.pvcs, n, store.persistentvolumeclaims)));
  } else if (sourceKind === "pod") {
    const labels = source?.metadata?.labels;
    for (const wk of WORKLOAD_KINDS) {
      groups.push(group(wk, values(store[wk])
        .filter((w) => sameNs(w, n) && selectorMatches(w?.spec?.selector?.matchLabels, labels))
        .map((w) => refFromObj(wk, w))));
    }
    groups.push(group("services", values(store.services)
      .filter((s) => sameNs(s, n) && selectorMatches(s?.spec?.selector, labels))
      .map((s) => refFromObj("services", s))));
    const refs = podRefs(source?.spec);
    groups.push(group("configmaps", refsByName("configmaps", refs.configmaps, n, store.configmaps)));
    groups.push(group("secrets", refsByName("secrets", refs.secrets, n, store.secrets)));
    groups.push(group("persistentvolumeclaims", refsByName("persistentvolumeclaims", refs.pvcs, n, store.persistentvolumeclaims)));
    const nodeName = source?.spec?.nodeName;
    if (nodeName) {
      const node = store.nodes?.[nodeName];
      groups.push(group("nodes", [node ? refFromObj("nodes", node) : { kind: "nodes", name: nodeName, key: nodeName, status: "ok" }]));
    }
  } else if (sourceKind === "ingress") {
    const svcNames = new Set<string>();
    for (const rule of source?.spec?.rules ?? [])
      for (const p of rule?.http?.paths ?? [])
        if (p?.backend?.service?.name) svcNames.add(p.backend.service.name);
    if (source?.spec?.defaultBackend?.service?.name) svcNames.add(source.spec.defaultBackend.service.name);
    const svcs = values(store.services).filter((s) => sameNs(s, n) && svcNames.has(s?.metadata?.name));
    groups.push(group("services", svcs.map((s) => refFromObj("services", s))));
    const podItems: RelatedRef[] = [];
    for (const s of svcs) podItems.push(...podsForSelector(s?.spec?.selector, n, store));
    groups.push(group("pods", dedupe(podItems)));
    const tlsNames = (source?.spec?.tls ?? []).map((t: Obj) => t?.secretName).filter(Boolean);
    groups.push(group("secrets", refsByName("secrets", tlsNames, n, store.secrets)));
  } else if (sourceKind === "service") {
    groups.push(group("pods", podsForSelector(source?.spec?.selector, n, store)));
    const name = source?.metadata?.name;
    const ings = values(store.ingresses).filter((ing) => sameNs(ing, n) && ingressReferencesService(ing, name));
    groups.push(group("ingresses", ings.map((ing) => refFromObj("ingresses", ing))));
  } else if (sourceKind === "job") {
    const uid = source?.metadata?.uid;
    groups.push(group("pods", values(store.pods)
      .filter((p) => sameNs(p, n) && ownedByUid(p, uid))
      .map((p) => ({ ...refFromObj("pods", p, podStatus(p)), node: p?.spec?.nodeName }))));
    const refs = podRefs(source?.spec?.template?.spec);
    groups.push(group("configmaps", refsByName("configmaps", refs.configmaps, n, store.configmaps)));
    groups.push(group("secrets", refsByName("secrets", refs.secrets, n, store.secrets)));
    groups.push(group("persistentvolumeclaims", refsByName("persistentvolumeclaims", refs.pvcs, n, store.persistentvolumeclaims)));
  } else if (sourceKind === "cronjob") {
    const uid = source?.metadata?.uid;
    groups.push(group("jobs", values(store.jobs)
      .filter((j) => sameNs(j, n) && ownedByUid(j, uid))
      .map((j) => refFromObj("jobs", j))));
  }

  return groups.filter((g): g is RelatedGroup => g !== null);
}

function ingressReferencesService(ing: Obj, svcName: string): boolean {
  for (const rule of ing?.spec?.rules ?? [])
    for (const p of rule?.http?.paths ?? [])
      if (p?.backend?.service?.name === svcName) return true;
  return ing?.spec?.defaultBackend?.service?.name === svcName;
}

function dedupe(refs: RelatedRef[]): RelatedRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
}
