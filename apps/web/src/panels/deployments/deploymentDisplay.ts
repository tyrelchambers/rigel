import type { Deployment, ContainerSummary } from "./types";
import type { Pod } from "../pods/types";
import type { ActionBlock } from "@/lib/api";

/**
 * Compact relative age of an ISO timestamp ("5s" / "3m" / "2h" / "1d"), or
 * "—" when missing. Mirrors the Swift `relativeAge` helper. Pass `now` for
 * determinism in tests.
 */
export function relativeAge(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const dt = (now - then) / 1000; // seconds
  if (dt < 0) return "0s";
  if (dt < 60) return `${Math.floor(dt)}s`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h`;
  return `${Math.floor(dt / 86400)}d`;
}

/** Desired replica count: `spec.replicas ?? 1`. */
export function desiredReplicas(d: Deployment): number {
  return d.spec?.replicas ?? 1;
}

/** Total replicas currently created: `status.replicas ?? spec.replicas ?? 0`. */
export function totalReplicas(d: Deployment): number {
  return d.status?.replicas ?? d.spec?.replicas ?? 0;
}

/** "{readyReplicas}/{total}" — total = status.replicas ?? spec.replicas ?? 0. */
export function readyText(d: Deployment): string {
  return `${d.status?.readyReplicas ?? 0}/${totalReplicas(d)}`;
}

/** True when readyReplicas equals the total (health for the Ready badge). */
export function isReady(d: Deployment): boolean {
  const total = totalReplicas(d);
  return total > 0 && (d.status?.readyReplicas ?? 0) === total;
}

/** Ready badge color class: green when fully ready, red otherwise. */
export function readyColorClass(d: Deployment): string {
  return isReady(d)
    ? "bg-green-500/15 text-green-600 dark:text-green-400"
    : "bg-red-500/15 text-red-600 dark:text-red-400";
}

/** Error reasons that mark a pod (and thus its owning deployment) as failing. */
const ERROR_WAITING_REASONS = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "CreateContainerConfigError",
  "CreateContainerError",
  "InvalidImageName",
  "RunContainerError",
]);

/** True when a pod has an error reason (CrashLoop, ImagePull, Failed, …). */
export function podHasError(pod: Pod): boolean {
  if (pod.status?.phase === "Failed") return true;
  const statuses = pod.status?.containerStatuses ?? [];
  for (const c of statuses) {
    const waitingReason = c.state?.waiting?.reason;
    if (waitingReason && ERROR_WAITING_REASONS.has(waitingReason)) return true;
    const term = c.state?.terminated;
    if (term && (term.exitCode ?? 0) !== 0 && term.reason !== "Completed") return true;
  }
  return false;
}

/**
 * Child pods of a deployment: pods in the same namespace whose labels are a
 * superset of `spec.selector.matchLabels`. Empty selector matches nothing.
 */
export function childPods(d: Deployment, pods: Pod[]): Pod[] {
  const ns = d.metadata.namespace ?? "default";
  const selector = d.spec?.selector?.matchLabels ?? {};
  const keys = Object.keys(selector);
  if (keys.length === 0) return [];
  return pods.filter((p) => {
    if ((p.metadata.namespace ?? "default") !== ns) return false;
    const labels = p.metadata.labels ?? {};
    return keys.every((k) => labels[k] === selector[k]);
  });
}

/** True when any child pod has an error reason. */
export function hasErrorPods(d: Deployment, pods: Pod[]): boolean {
  return childPods(d, pods).some(podHasError);
}

/**
 * Actively rolling out: desired > 0, no error pods, and updated/ready does
 * not yet match desired.
 */
export function isRedeploying(d: Deployment, pods: Pod[] = []): boolean {
  const desired = desiredReplicas(d);
  if (desired <= 0) return false;
  if (hasErrorPods(d, pods)) return false;
  const updated = d.status?.updatedReplicas ?? 0;
  const ready = d.status?.readyReplicas ?? 0;
  return updated !== desired || ready !== desired;
}

/**
 * Class name for the Name field color:
 * - red   → any child pod has an error reason
 * - amber → desired == 0 (scaled to zero)
 * - green → actively redeploying (no errors)
 * - default foreground otherwise
 */
export function statusColor(d: Deployment, pods: Pod[]): string {
  if (hasErrorPods(d, pods)) return "text-red-600 dark:text-red-400";
  if (desiredReplicas(d) === 0) return "text-yellow-600 dark:text-yellow-400";
  if (isRedeploying(d, pods)) return "text-green-600 dark:text-green-400";
  return "text-foreground";
}

/** Rollout progress fraction (0…1): updatedReplicas / desired. */
export function rolloutProgress(d: Deployment): number {
  const desired = desiredReplicas(d);
  if (desired <= 0) return 0;
  const updated = d.status?.updatedReplicas ?? 0;
  const frac = updated / desired;
  if (frac < 0) return 0;
  if (frac > 1) return 1;
  return frac;
}

/** First-container image repo (path without tag/digest). "—" when absent. */
export function imageRepo(image: string | undefined): string {
  if (!image) return "—";
  // Strip digest first (@sha256:…), then a trailing :tag. A ":" only counts as
  // a tag separator when it is in the last path segment (after the final "/").
  const atIndex = image.indexOf("@");
  let repo = atIndex >= 0 ? image.slice(0, atIndex) : image;
  const lastSlash = repo.lastIndexOf("/");
  const lastColon = repo.lastIndexOf(":");
  if (lastColon > lastSlash) repo = repo.slice(0, lastColon);
  return repo;
}

/** First-container image of a deployment, or undefined. */
export function firstImage(d: Deployment): string | undefined {
  return d.spec?.template?.spec?.containers?.[0]?.image;
}

/**
 * Tag/digest pill text:
 * - `repo@sha256:abc123…` → "@abc123" (short digest, 7 chars)
 * - `repo:v1.2.3`         → "v1.2.3"
 * - `repo` (untagged)     → "latest"
 */
export function imageTag(image: string | undefined): string {
  if (!image) return "latest";
  const atIndex = image.indexOf("@");
  if (atIndex >= 0) {
    const digest = image.slice(atIndex + 1); // e.g. "sha256:abcdef0123…"
    const colon = digest.indexOf(":");
    const hex = colon >= 0 ? digest.slice(colon + 1) : digest;
    return `@${hex.slice(0, 7)}`;
  }
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  if (lastColon > lastSlash) return image.slice(lastColon + 1);
  return "latest";
}

/** Per-container summaries for the expanded SPEC block. */
export function containerSummaries(d: Deployment): ContainerSummary[] {
  const containers = d.spec?.template?.spec?.containers ?? [];
  return containers.map((c) => ({
    name: c.name,
    image: c.image ?? "—",
    ports: (c.ports ?? []).map((p) => p.containerPort),
    cpuReq: c.resources?.requests?.cpu,
    cpuLim: c.resources?.limits?.cpu,
    memReq: c.resources?.requests?.memory,
    memLim: c.resources?.limits?.memory,
  }));
}

/** "RollingUpdate · maxSurge 25% · maxUnavailable 25%" (or just the type). */
export function strategyDescription(d: Deployment): string {
  const strat = d.spec?.strategy;
  const type = strat?.type ?? "RollingUpdate";
  const parts = [type];
  const ru = strat?.rollingUpdate;
  if (type === "RollingUpdate" && ru) {
    if (ru.maxSurge !== undefined) parts.push(`maxSurge ${ru.maxSurge}`);
    if (ru.maxUnavailable !== undefined) parts.push(`maxUnavailable ${ru.maxUnavailable}`);
  }
  return parts.join(" · ");
}

/** "app=web,tier=frontend" — matchLabels sorted by key. "—" when empty. */
export function selectorString(d: Deployment): string {
  const labels = d.spec?.selector?.matchLabels ?? {};
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "—";
  return keys.map((k) => `${k}=${labels[k]}`).join(",");
}

/**
 * Case-insensitive substring match against deployment name, namespace, and
 * first-container image repo. Empty/blank query matches everything.
 */
export function matchesSearch(d: Deployment, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (d.metadata.name.toLowerCase().includes(q)) return true;
  if ((d.metadata.namespace ?? "default").toLowerCase().includes(q)) return true;
  const repo = imageRepo(firstImage(d));
  if (repo !== "—" && repo.toLowerCase().includes(q)) return true;
  return false;
}

/** Stable display sort: namespace, then name. */
export function sortDeployments(deployments: Deployment[]): Deployment[] {
  return [...deployments].sort((a, b) => {
    const ns = (a.metadata.namespace ?? "default").localeCompare(b.metadata.namespace ?? "default");
    if (ns !== 0) return ns;
    return a.metadata.name.localeCompare(b.metadata.name);
  });
}

// ---------------------------------------------------------------------------
// Edit model + diff
// ---------------------------------------------------------------------------

/** One editable env row (plain string value only). */
export interface EnvEdit { id: string; key: string; value: string }

/** One editable env-from-resource row (Secret/ConfigMap key reference). */
export interface EnvRefEdit {
  id: string;
  name: string;
  source: "secret" | "configMap";
  resourceName: string;
  key: string;
}

/** Editable view of a single container. */
export interface ContainerEdit {
  name: string;
  image: string;
  cpuReq: string;
  cpuLim: string;
  memReq: string;
  memLim: string;
  /** Editable plain-value env vars. */
  env: EnvEdit[];
  /** Editable env vars sourced from a Secret/ConfigMap key. */
  envRefs: EnvRefEdit[];
  /** Names of non-secret/non-configmap valueFrom env vars (fieldRef/resourceFieldRef): read-only, removable. */
  otherRefKeys: string[];
}

/** Editable view of a whole deployment. */
export interface DeploymentEdit {
  replicas: number;
  /** Pod-level imagePullSecret names (private registry auth, e.g. GHCR). */
  imagePullSecrets: string[];
  containers: ContainerEdit[];
}

/** Build the mutable edit model from a deployment's live spec. */
export function editModelFor(d: Deployment): DeploymentEdit {
  const containers = d.spec?.template?.spec?.containers ?? [];
  return {
    replicas: desiredReplicas(d),
    imagePullSecrets: (d.spec?.template?.spec?.imagePullSecrets ?? []).map((s) => s.name),
    containers: containers.map((c) => {
      const env = c.env ?? [];
      const envRefs: EnvRefEdit[] = [];
      const otherRefKeys: string[] = [];
      for (const e of env) {
        const vf = e.valueFrom;
        if (vf?.secretKeyRef) {
          envRefs.push({ id: e.name, name: e.name, source: "secret", resourceName: vf.secretKeyRef.name, key: vf.secretKeyRef.key });
        } else if (vf?.configMapKeyRef) {
          envRefs.push({ id: e.name, name: e.name, source: "configMap", resourceName: vf.configMapKeyRef.name, key: vf.configMapKeyRef.key });
        } else if (vf != null) {
          otherRefKeys.push(e.name);
        }
      }
      return {
        name: c.name,
        image: c.image ?? "",
        cpuReq: c.resources?.requests?.cpu ?? "",
        cpuLim: c.resources?.limits?.cpu ?? "",
        memReq: c.resources?.requests?.memory ?? "",
        memLim: c.resources?.limits?.memory ?? "",
        env: env.filter((e) => e.valueFrom == null).map((e) => ({ id: e.name, key: e.name, value: e.value ?? "" })),
        envRefs,
        otherRefKeys,
      };
    }),
  };
}

/** Join cpu/memory request or limit parts into a kubectl quantity string. */
function quantityString(cpu: string, mem: string): string {
  const parts: string[] = [];
  if (cpu) parts.push(`cpu=${cpu}`);
  if (mem) parts.push(`memory=${mem}`);
  return parts.join(",");
}

/**
 * Compute the discrete ActionBlocks needed to turn `original` into `edit`.
 * Only changed dimensions produce actions; order is replicas → per-container
 * (image → resources → env). Reuses the server's tested set-verb action kinds.
 */
export function diffDeployment(original: Deployment, edit: DeploymentEdit): ActionBlock[] {
  const name = original.metadata.name;
  const namespace = original.metadata.namespace ?? "default";
  const actions: ActionBlock[] = [];

  if (edit.replicas !== desiredReplicas(original)) {
    actions.push({ kind: "scale", name, namespace, replicas: edit.replicas, label: `Scale ${name} to ${edit.replicas} replicas` });
  }

  const originalContainers = original.spec?.template?.spec?.containers ?? [];
  for (const c of edit.containers) {
    const orig = originalContainers.find((o) => o.name === c.name);
    if (!orig) continue;

    if (c.image !== (orig.image ?? "")) {
      actions.push({ kind: "setImage", name, namespace, container: c.name, image: c.image, label: `Set ${c.name} image to ${c.image}` });
    }

    const reqNow = quantityString(c.cpuReq, c.memReq);
    const limNow = quantityString(c.cpuLim, c.memLim);
    const reqOrig = quantityString(orig.resources?.requests?.cpu ?? "", orig.resources?.requests?.memory ?? "");
    const limOrig = quantityString(orig.resources?.limits?.cpu ?? "", orig.resources?.limits?.memory ?? "");
    // kubectl set resources cannot cleanly REMOVE a request/limit, so a cleared
    // field (→ "") is treated as "no change". Only non-empty, changed flags emit.
    const reqChanged = reqNow !== "" && reqNow !== reqOrig;
    const limChanged = limNow !== "" && limNow !== limOrig;
    if (reqChanged || limChanged) {
      const a: ActionBlock = { kind: "setResources", name, namespace, container: c.name, label: `Update ${c.name} resources` };
      if (reqChanged) a.requests = reqNow;
      if (limChanged) a.limits = limNow;
      actions.push(a);
    }

    // env diff — plain value adds/edits + removals, then secret/configMap refs.
    const origPlain = new Map((orig.env ?? []).filter((e) => e.valueFrom == null).map((e) => [e.name, e.value ?? ""] as const));
    const origRefKeys = (orig.env ?? []).filter((e) => e.valueFrom != null).map((e) => e.name);
    const setEnv: Record<string, string> = {};
    for (const row of c.env) {
      if (!row.key) continue;
      if (origPlain.get(row.key) !== row.value) setEnv[row.key] = row.value;
    }
    const keptPlain = new Set(c.env.map((r) => r.key));
    const keptRefNames = new Set<string>([...c.envRefs.map((r) => r.name), ...c.otherRefKeys]);
    const removed: string[] = [];
    for (const k of origPlain.keys()) if (!keptPlain.has(k)) removed.push(k);
    for (const k of origRefKeys) if (!keptRefNames.has(k)) removed.push(k);

    // setEnv (plain adds/edits + removals) is pushed BEFORE setEnvRef so a
    // plain→ref conversion unsets the plain entry first (avoids value+valueFrom).
    if (Object.keys(setEnv).length > 0 || removed.length > 0) {
      const a: ActionBlock = { kind: "setEnv", name, namespace, container: c.name, label: `Update ${c.name} environment` };
      if (Object.keys(setEnv).length > 0) a.env = setEnv;
      if (removed.length > 0) a.unsetEnv = removed.sort();
      actions.push(a);
    }

    // secret/configMap key refs — emit added/changed ones as one strategic patch.
    const origRefs = new Map<string, { source: "secret" | "configMap"; resourceName: string; key: string }>();
    for (const e of orig.env ?? []) {
      const vf = e.valueFrom;
      if (vf?.secretKeyRef) origRefs.set(e.name, { source: "secret", resourceName: vf.secretKeyRef.name, key: vf.secretKeyRef.key });
      else if (vf?.configMapKeyRef) origRefs.set(e.name, { source: "configMap", resourceName: vf.configMapKeyRef.name, key: vf.configMapKeyRef.key });
    }
    const envRefsOut: Array<{ name: string; source: "secret" | "configMap"; resourceName: string; key: string }> = [];
    for (const r of c.envRefs) {
      if (!r.name || !r.resourceName || !r.key) continue; // skip incomplete rows
      const o = origRefs.get(r.name);
      if (!o || o.source !== r.source || o.resourceName !== r.resourceName || o.key !== r.key) {
        envRefsOut.push({ name: r.name, source: r.source, resourceName: r.resourceName, key: r.key });
      }
    }
    if (envRefsOut.length > 0) {
      actions.push({ kind: "setEnvRef", name, namespace, container: c.name, envRefs: envRefsOut, label: `Reference secrets/config in ${c.name} environment` });
    }
  }

  // imagePullSecrets — order-insensitive set comparison; emit the full desired list.
  const origIPS = (original.spec?.template?.spec?.imagePullSecrets ?? []).map((s) => s.name);
  const editIPS = edit.imagePullSecrets;
  const ipsChanged =
    origIPS.length !== editIPS.length ||
    [...origIPS].sort().join(" ") !== [...editIPS].sort().join(" ");
  if (ipsChanged) {
    actions.push({
      kind: "setImagePullSecrets",
      name,
      namespace,
      imagePullSecrets: editIPS,
      label: editIPS.length ? `Set image pull secrets: ${editIPS.join(", ")}` : "Clear image pull secrets",
    });
  }

  return actions;
}

/**
 * Distinct namespaces for the move-to-namespace picker: every loaded
 * deployment's namespace (defaulting to "default") plus any namespaces present
 * in the store, deduped and sorted.
 */
export function namespaceOptions(
  deployments: Deployment[],
  namespacesByName: Record<string, unknown>,
): string[] {
  const set = new Set<string>();
  for (const d of deployments) set.add(d.metadata.namespace ?? "default");
  for (const name of Object.keys(namespacesByName ?? {})) set.add(name);
  return [...set].sort();
}
