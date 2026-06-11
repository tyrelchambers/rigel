// Display helpers for the Databases panel: detection, normalization, health,
// age, search, sort, pod matching, and connection-string construction.
// Mirrors the Swift `Sources/Helmsman/Panels/Databases/` helpers.
// See docs/parity/databases.md for the normative spec.

import type {
  BackupInfo,
  CNPGBackup,
  CNPGCluster,
  CNPGScheduledBackup,
  ConnectionInfo,
  DatabaseAction,
  DatabaseActionItem,
  DatabaseCapabilities,
  DatabaseInstance,
  DatabaseKind,
  DatabasePod,
  DatabasePodRaw,
  DatabaseSecret,
  DatabaseSource,
  WalArchivingStatus,
  WorkloadDB,
} from "./types";
import type { ActionBlock } from "@/lib/api";

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

/**
 * Compact relative age of an ISO timestamp ("5s" / "3m" / "2h" / "1d"), or
 * "—" when missing. Pass `now` for determinism in tests.
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

// ---------------------------------------------------------------------------
// Image detection
// ---------------------------------------------------------------------------

/** Images that must NOT be treated as a database even if the name matches. */
const EXCLUDED_IMAGE_TOKENS = ["-operator", "-exporter", "pgbouncer", "pgpool", "tailscale"];

/**
 * Ordered detection table. Order matters where one token is a substring of
 * another conceptually (e.g. "postgresql" before "postgres" is fine since both
 * map to the same kind; clickhouse-server before clickhouse). Each entry is
 * checked as a case-insensitive substring of the image *name* (repo + tag,
 * after stripping the registry host is not required — substring is enough).
 */
const IMAGE_PATTERNS: Array<{ tokens: string[]; kind: DatabaseKind }> = [
  { tokens: ["postgresql", "postgres"], kind: "postgres" },
  { tokens: ["mariadb"], kind: "mariadb" },
  { tokens: ["mysql"], kind: "mysql" },
  { tokens: ["mongodb", "mongo"], kind: "mongo" },
  { tokens: ["valkey"], kind: "valkey" },
  { tokens: ["keydb"], kind: "keydb" },
  { tokens: ["redis"], kind: "redis" },
  { tokens: ["clickhouse-server", "clickhouse"], kind: "clickhouse" },
  { tokens: ["opensearch"], kind: "opensearch" },
  { tokens: ["elasticsearch"], kind: "elasticsearch" },
  { tokens: ["cassandra"], kind: "cassandra" },
  { tokens: ["scylladb", "scylla"], kind: "scylla" },
  { tokens: ["dragonflydb", "dragonfly"], kind: "dragonfly" },
];

/**
 * Detect the database kind from a container image reference, or null if it is
 * not a recognized database (or is an excluded sidecar/operator/exporter).
 * Matching is case-insensitive against the image-name portion (the path after
 * the last "/", before the tag/digest).
 */
export function detectKindFromImage(image: string | undefined): DatabaseKind | null {
  if (!image) return null;
  const lower = image.toLowerCase();
  // Excluded sidecars/operators take precedence over any match.
  if (EXCLUDED_IMAGE_TOKENS.some((t) => lower.includes(t))) return null;
  // Use the image-name portion (last path segment, minus tag/digest) so a
  // registry host like "redis.example.com/app" can't false-match.
  const nameOnly = imageNameOnly(lower);
  for (const { tokens, kind } of IMAGE_PATTERNS) {
    if (tokens.some((t) => nameOnly.includes(t))) return kind;
  }
  return null;
}

/** Extract the bare image name (last path segment without tag or digest). */
function imageNameOnly(image: string): string {
  // Strip digest, then tag, then take the last path segment.
  const noDigest = image.split("@")[0];
  const lastSlash = noDigest.lastIndexOf("/");
  const afterHost = lastSlash >= 0 ? noDigest.slice(lastSlash + 1) : noDigest;
  return afterHost.split(":")[0];
}

// ---------------------------------------------------------------------------
// Normalization: CNPG cluster -> DatabaseInstance
// ---------------------------------------------------------------------------

/** WAL archiving status from CNPG conditions[type=="ContinuousArchiving"]. */
export function walArchivingStatus(cluster: CNPGCluster): WalArchivingStatus {
  const cond = (cluster.status?.conditions ?? []).find(
    (c) => c.type === "ContinuousArchiving",
  );
  if (!cond) return "unknown";
  if (cond.status === "True") return "healthy";
  if (cond.status === "False") return "failing";
  return "unknown";
}

/**
 * Most recent successful backup timestamp for a cluster, taken from the newest
 * completed `Backup` object (by `status.stoppedAt`). Returns undefined when the
 * cluster has no completed Backup objects.
 *
 * This is the authoritative source: CNPG does NOT update
 * `cluster.status.lastSuccessfulBackup` for plugin-method (barman-cloud)
 * backups, so that field can be stale by weeks while backups run fine.
 */
export function latestCompletedBackup(
  backups: CNPGBackup[],
  clusterName: string,
  namespace: string,
): string | undefined {
  let latest: string | undefined;
  for (const b of backups) {
    if (b.spec?.cluster?.name !== clusterName) continue;
    if ((b.metadata.namespace ?? "default") !== namespace) continue;
    if (b.status?.phase !== "completed") continue;
    const at = b.status?.stoppedAt;
    if (at && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

/**
 * Build a normalized instance from a CNPG cluster. ScheduledBackups are matched
 * by `spec.cluster.name` against the cluster name + namespace. `lastBackup` is
 * the newest completed Backup object, falling back to the cluster's
 * `status.lastSuccessfulBackup` only when no Backup objects exist.
 */
export function instanceFromCNPG(
  cluster: CNPGCluster,
  scheduledBackups: CNPGScheduledBackup[],
  backups: CNPGBackup[] = [],
): DatabaseInstance {
  const name = cluster.metadata.name;
  const namespace = cluster.metadata.namespace ?? "default";
  const desiredReplicas = cluster.spec?.instances ?? cluster.status?.instances ?? 0;
  const readyReplicas = cluster.status?.readyInstances ?? 0;
  const isHealthy = readyReplicas === desiredReplicas && desiredReplicas > 0;
  const schedule = scheduledBackups.find(
    (sb) =>
      sb.spec?.cluster?.name === name &&
      (sb.metadata.namespace ?? "default") === namespace,
  )?.spec?.schedule;

  return {
    id: cluster.metadata.uid ?? `${namespace}/${name}`,
    name,
    namespace,
    kind: "postgres",
    source: "cnpg",
    creationTimestamp: cluster.metadata.creationTimestamp,
    image: cluster.spec?.imageName,
    desiredReplicas,
    readyReplicas,
    phaseText: cluster.status?.phase ?? "Unknown",
    isHealthy,
    labelSelector: { "cnpg.io/cluster": name },
    cnpgPrimary: cluster.status?.currentPrimary,
    lastBackup:
      latestCompletedBackup(backups, name, namespace) ??
      cluster.status?.lastSuccessfulBackup,
    scheduledBackup: schedule,
    walArchiving: walArchivingStatus(cluster),
  };
}

// ---------------------------------------------------------------------------
// Normalization: Deployment / StatefulSet -> DatabaseInstance
// ---------------------------------------------------------------------------

/**
 * Build a normalized instance from a Deployment or StatefulSet, or null if no
 * container image matches a known database engine. `source` distinguishes the
 * two for the SOURCE badge.
 */
export function instanceFromWorkload(
  workload: WorkloadDB,
  source: "deployment" | "statefulset",
): DatabaseInstance | null {
  const containers = workload.spec?.template?.spec?.containers ?? [];
  let matchedImage: string | undefined;
  let kind: DatabaseKind | null = null;
  for (const c of containers) {
    const k = detectKindFromImage(c.image);
    if (k) {
      kind = k;
      matchedImage = c.image;
      break;
    }
  }
  if (!kind) return null;

  const name = workload.metadata.name;
  const namespace = workload.metadata.namespace ?? "default";
  const desiredReplicas = workload.spec?.replicas ?? workload.status?.replicas ?? 0;
  const readyReplicas = workload.status?.readyReplicas ?? 0;
  const isHealthy = readyReplicas === desiredReplicas && desiredReplicas > 0;

  return {
    id: workload.metadata.uid ?? `${namespace}/${name}`,
    name,
    namespace,
    kind,
    source,
    creationTimestamp: workload.metadata.creationTimestamp,
    image: matchedImage,
    desiredReplicas,
    readyReplicas,
    phaseText: isHealthy ? "Healthy" : "Degraded",
    isHealthy,
    labelSelector: workload.spec?.selector?.matchLabels ?? {},
  };
}

// ---------------------------------------------------------------------------
// Aggregate build (memoized on the caller side by cache revision)
// ---------------------------------------------------------------------------

/**
 * Build the full instance list from raw cluster resources, sorted by namespace
 * then name. CNPG clusters first detected, then image-detected workloads.
 */
export function buildInstances(args: {
  cnpgClusters: CNPGCluster[];
  scheduledBackups: CNPGScheduledBackup[];
  backups?: CNPGBackup[];
  deployments: WorkloadDB[];
  statefulSets: WorkloadDB[];
}): DatabaseInstance[] {
  const out: DatabaseInstance[] = [];
  for (const c of args.cnpgClusters) {
    out.push(instanceFromCNPG(c, args.scheduledBackups, args.backups ?? []));
  }
  for (const d of args.deployments) {
    const inst = instanceFromWorkload(d, "deployment");
    if (inst) out.push(inst);
  }
  for (const s of args.statefulSets) {
    const inst = instanceFromWorkload(s, "statefulset");
    if (inst) out.push(inst);
  }
  return sortInstances(out);
}

// ---------------------------------------------------------------------------
// Pod matching
// ---------------------------------------------------------------------------

/** True if a pod's labels include every key/value in the selector. */
function podMatchesSelector(
  podLabels: Record<string, string> | undefined,
  selector: Record<string, string>,
): boolean {
  const keys = Object.keys(selector);
  if (keys.length === 0) return false;
  if (!podLabels) return false;
  return keys.every((k) => podLabels[k] === selector[k]);
}

/**
 * Match child pods to an instance by label selector + namespace, sorted by
 * name. Primary detection compares the pod name to the CNPG currentPrimary.
 */
export function matchPods(
  instance: DatabaseInstance,
  pods: DatabasePodRaw[],
): DatabasePod[] {
  return pods
    .filter(
      (p) =>
        (p.metadata.namespace ?? "default") === instance.namespace &&
        podMatchesSelector(p.metadata.labels, instance.labelSelector),
    )
    .map((p) => ({
      name: p.metadata.name,
      phase: p.status?.phase ?? "Unknown",
      node: p.spec?.nodeName,
      isPrimary: !!instance.cnpgPrimary && p.metadata.name === instance.cnpgPrimary,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Distinct node names spanned by a set of pods, in stable order. */
export function podNodes(pods: DatabasePod[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of pods) {
    if (p.node && !seen.has(p.node)) {
      seen.add(p.node);
      out.push(p.node);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search & sort
// ---------------------------------------------------------------------------

/**
 * Case-insensitive substring match across name, namespace, kind, image, and
 * label keys/values. Empty/blank query matches everything. Mirrors the Swift
 * `matchesDatabase`.
 */
export function matchesDatabase(instance: DatabaseInstance, query: string): boolean {
  if (!query.trim()) return true;
  const labelText = Object.entries(instance.labelSelector)
    .flatMap(([k, v]) => [k, v])
    .join(" ");
  const haystack = [instance.name, instance.namespace, instance.kind, instance.image, labelText]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

/** Stable comparator: namespace ascending, then name ascending. */
export function compareInstances(a: DatabaseInstance, b: DatabaseInstance): number {
  if (a.namespace !== b.namespace) return a.namespace.localeCompare(b.namespace);
  return a.name.localeCompare(b.name);
}

/** Sort instances by namespace then name (stable). */
export function sortInstances(instances: DatabaseInstance[]): DatabaseInstance[] {
  return [...instances].sort(compareInstances);
}

// ---------------------------------------------------------------------------
// Connection string
// ---------------------------------------------------------------------------

/** Default connection scheme per database kind. */
export function defaultScheme(kind: DatabaseKind): string {
  switch (kind) {
    case "postgres":
      return "postgresql";
    case "mysql":
    case "mariadb":
      return "mysql";
    case "mongo":
      return "mongodb";
    case "redis":
    case "valkey":
    case "keydb":
    case "dragonfly":
      return "redis";
    case "clickhouse":
      return "clickhouse";
    case "elasticsearch":
    case "opensearch":
      return "https";
    case "cassandra":
    case "scylla":
      return "cassandra";
  }
}

/** Default port per database kind. */
export function defaultPort(kind: DatabaseKind): number {
  switch (kind) {
    case "postgres":
      return 5432;
    case "mysql":
    case "mariadb":
      return 3306;
    case "mongo":
      return 27017;
    case "redis":
    case "valkey":
    case "keydb":
    case "dragonfly":
      return 6379;
    case "clickhouse":
      return 8123;
    case "elasticsearch":
    case "opensearch":
      return 9200;
    case "cassandra":
    case "scylla":
      return 9042;
  }
}

/**
 * Build a display connection string. CNPG targets the service
 * `{name}-rw.{namespace}.svc:{port}`; image-detected targets the first pod or
 * the workload name `{target}.{namespace}:{port}`. Optional username/dbname.
 * Mirrors `{scheme}://{username@}{target}.{namespace}{.svc}:{port}/{dbname}`.
 */
export function connectionString(args: {
  kind: DatabaseKind;
  source: DatabaseSource;
  target: string;
  namespace: string;
  username?: string;
  dbname?: string;
  port?: number;
}): string {
  const scheme = defaultScheme(args.kind);
  const port = args.port ?? defaultPort(args.kind);
  const userPart = args.username ? `${args.username}@` : "";
  const host =
    args.source === "cnpg"
      ? `${args.target}.${args.namespace}.svc`
      : `${args.target}.${args.namespace}`;
  const dbPart = args.dbname ? `/${args.dbname}` : "";
  return `${scheme}://${userPart}${host}:${port}${dbPart}`;
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

/** "X/Y" ready/desired text. */
export function readyFraction(ready: number, desired: number): string {
  return `${ready}/${desired}`;
}

/** Ready badge color: green when healthy, red otherwise. */
export function readyColorClass(isHealthy: boolean): string {
  return isHealthy
    ? "bg-green-500/15 text-green-600 dark:text-green-400"
    : "bg-red-500/15 text-red-600 dark:text-red-400";
}

/** KIND-badge color class per database engine. */
export function kindColorClass(kind: DatabaseKind): string {
  switch (kind) {
    case "postgres":
      return "bg-blue-500/15 text-blue-600 dark:text-blue-400";
    case "mysql":
    case "mariadb":
      return "bg-orange-500/15 text-orange-600 dark:text-orange-400";
    case "redis":
    case "keydb":
    case "dragonfly":
      return "bg-red-500/15 text-red-600 dark:text-red-400";
    case "valkey":
      return "bg-sky-500/15 text-sky-600 dark:text-sky-400";
    case "mongo":
      return "bg-green-500/15 text-green-600 dark:text-green-400";
    case "clickhouse":
      return "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400";
    case "elasticsearch":
    case "opensearch":
      return "bg-teal-500/15 text-teal-600 dark:text-teal-400";
    case "cassandra":
    case "scylla":
      return "bg-purple-500/15 text-purple-600 dark:text-purple-400";
  }
}

/** Pod phase status-dot color class (background). */
export function phaseDotClass(phase: string): string {
  switch (phase) {
    case "Running":
      return "bg-green-500";
    case "Pending":
      return "bg-yellow-500";
    case "Failed":
      return "bg-red-500";
    default: // Succeeded / Unknown / other
      return "bg-muted-foreground";
  }
}

/** WAL archiving status-dot color class (background). */
export function walDotClass(status: WalArchivingStatus): string {
  switch (status) {
    case "healthy":
      return "bg-green-500";
    case "failing":
      return "bg-red-500";
    case "unknown":
      return "bg-muted-foreground";
  }
}

/** SOURCE-badge label: "CNPG" | "DEPLOY" | "STS". */
export function sourceBadgeLabel(source: DatabaseSource): string {
  switch (source) {
    case "cnpg":
      return "CNPG";
    case "deployment":
      return "DEPLOY";
    case "statefulset":
      return "STS";
  }
}

// ---------------------------------------------------------------------------
// Capabilities (action bar + connection + backup info)
//
// Pure helper mirroring the Swift `DatabaseOperatorRegistry` / `CNPGOperator` /
// `NoOperator` in Sources/Helmsman/Panels/Databases/DatabaseOperator.swift and
// `DatabasesViewModel.capabilities(for:)`. See docs/parity/databases-controls.md.
// ---------------------------------------------------------------------------

const PLUGIN_REASON = "Requires the kubectl-cnpg plugin";

/**
 * Connection port for an image-detected (NoOperator) instance. NOTE this is the
 * NATIVE-protocol port and differs from `defaultPort()` (used for the display
 * connection string) for clickhouse (9000 vs 8123). Mirrors
 * `NoOperator.defaultPort(for:)` in Swift exactly.
 */
function operatorPort(kind: DatabaseKind): number {
  switch (kind) {
    case "postgres":
      return 5432;
    case "mysql":
    case "mariadb":
      return 3306;
    case "mongo":
      return 27017;
    case "redis":
    case "valkey":
    case "keydb":
    case "dragonfly":
      return 6379;
    case "clickhouse":
      return 9000;
    case "elasticsearch":
    case "opensearch":
      return 9200;
    case "cassandra":
    case "scylla":
      return 9042;
  }
}

/**
 * Connection scheme for an image-detected (NoOperator) instance. Mirrors
 * `NoOperator.scheme(for:)` — note elasticsearch/opensearch use "http" here
 * (vs "https" in the display `defaultScheme()`).
 */
function operatorScheme(kind: DatabaseKind): string {
  switch (kind) {
    case "postgres":
      return "postgresql";
    case "mysql":
    case "mariadb":
      return "mysql";
    case "mongo":
      return "mongodb";
    case "redis":
    case "valkey":
    case "keydb":
    case "dragonfly":
      return "redis";
    case "clickhouse":
      return "clickhouse";
    case "elasticsearch":
    case "opensearch":
      return "http";
    case "cassandra":
    case "scylla":
      return "cassandra";
  }
}

/** Decode a base64 string to UTF-8, returning undefined on failure. */
function decodeBase64(b64: string | undefined): string | undefined {
  if (!b64) return undefined;
  try {
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return undefined;
  }
}

/** Decode the `username` key from a named secret in the given namespace. */
function usernameFromSecret(
  secrets: DatabaseSecret[],
  name: string,
  namespace: string,
): string | undefined {
  const s = secrets.find(
    (sec) => sec.metadata.name === name && (sec.metadata.namespace ?? "default") === namespace,
  );
  return decodeBase64(s?.data?.["username"]);
}

/** Raw container shape used for secret discovery (pod envFrom / env). */
interface DiscoverPod {
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  status?: { phase?: string };
  spec?: {
    containers?: Array<{
      envFrom?: Array<{ secretRef?: { name?: string } }>;
      env?: Array<{ valueFrom?: { secretKeyRef?: { name?: string } } }>;
    }>;
  };
}

/**
 * First secret name referenced by any container's `envFrom[].secretRef` or
 * `env[].valueFrom.secretKeyRef`, scanning pods in order. Mirrors
 * `NoOperator.discoverSecret(in:)`.
 */
function discoverSecret(pods: DiscoverPod[]): string | undefined {
  for (const pod of pods) {
    for (const ct of pod.spec?.containers ?? []) {
      const fromEnvFrom = ct.envFrom?.map((e) => e.secretRef?.name).find(Boolean);
      if (fromEnvFrom) return fromEnvFrom;
      const fromEnv = ct.env?.map((e) => e.valueFrom?.secretKeyRef?.name).find(Boolean);
      if (fromEnv) return fromEnv;
    }
  }
  return undefined;
}

/**
 * Compute the action bar + connection/backup info for one instance. Mirrors the
 * Swift operator registry: CNPG clusters use `cnpgCapabilities`, deployment /
 * statefulset use `imageDetectedCapabilities`.
 */
export function capabilities(args: {
  instance: DatabaseInstance;
  pods: DatabasePodRaw[];
  cnpgCluster?: CNPGCluster;
  scheduledBackups: CNPGScheduledBackup[];
  secrets: DatabaseSecret[];
  cnpgPluginAvailable: boolean;
}): DatabaseCapabilities {
  return args.instance.source === "cnpg"
    ? cnpgCapabilities(args)
    : imageDetectedCapabilities(args);
}

function cnpgCapabilities(args: {
  instance: DatabaseInstance;
  pods: DatabasePodRaw[];
  cnpgCluster?: CNPGCluster;
  scheduledBackups: CNPGScheduledBackup[];
  secrets: DatabaseSecret[];
  cnpgPluginAvailable: boolean;
}): DatabaseCapabilities {
  const { instance } = args;
  const pluginMissing = !args.cnpgPluginAvailable;

  // Running pods of this cluster (by cnpg.io/cluster label + namespace).
  const runningNames = args.pods
    .filter(
      (p) =>
        (p.metadata.namespace ?? "default") === instance.namespace &&
        p.metadata.labels?.["cnpg.io/cluster"] === instance.name &&
        p.status?.phase === "Running",
    )
    .map((p) => p.metadata.name);

  // A switchover only makes sense once a primary is elected — otherwise every
  // pod would falsely look like a promotable standby.
  const standby = instance.cnpgPrimary
    ? runningNames
        .filter((n) => n !== instance.cnpgPrimary)
        .sort((a, b) => a.localeCompare(b))[0]
    : undefined;

  const items: DatabaseActionItem[] = [];
  items.push({
    action: { type: "backupNow" },
    enabled: !pluginMissing,
    disabledReason: pluginMissing ? PLUGIN_REASON : undefined,
  });
  if (standby) {
    items.push({
      action: { type: "switchover", to: standby },
      enabled: !pluginMissing,
      disabledReason: pluginMissing ? PLUGIN_REASON : undefined,
    });
  } else {
    items.push({
      action: { type: "switchover", to: "" },
      enabled: false,
      disabledReason: "No ready standby to promote",
    });
  }
  if (instance.readyReplicas === 0) {
    items.push({
      action: { type: "hibernate", on: false }, // Resume
      enabled: !pluginMissing,
      disabledReason: pluginMissing ? PLUGIN_REASON : undefined,
    });
  } else {
    items.push({
      action: { type: "hibernate", on: true }, // Hibernate
      enabled: !pluginMissing,
      disabledReason: pluginMissing ? PLUGIN_REASON : undefined,
    });
  }
  items.push({
    action: { type: "scale", current: instance.desiredReplicas, desired: instance.desiredReplicas },
    enabled: true,
  });
  items.push({ action: { type: "portForward" }, enabled: true });
  items.push({ action: { type: "revealCredentials" }, enabled: true });
  items.push({ action: { type: "copyDSN" }, enabled: true });

  const cluster = args.cnpgCluster;
  const schedule = args.scheduledBackups.find(
    (sb) =>
      sb.spec?.cluster?.name === instance.name &&
      (sb.metadata.namespace ?? "default") === instance.namespace,
  )?.spec?.schedule;
  const walCond = (cluster?.status?.conditions ?? []).find(
    (c) => c.type === "ContinuousArchiving",
  );
  const backupInfo: BackupInfo = {
    lastBackup: instance.lastBackup,
    schedule,
    walArchivingHealthy: walCond ? walCond.status === "True" : undefined,
  };

  const secretName = `${instance.name}-app`;
  const connection: ConnectionInfo = {
    targetKind: "svc",
    targetName: `${instance.name}-rw`,
    namespace: instance.namespace,
    port: 5432,
    scheme: "postgresql",
    secretName,
    username: usernameFromSecret(args.secrets, secretName, instance.namespace),
    dbName: "app",
  };

  return { actions: items, backupInfo, connection };
}

function imageDetectedCapabilities(args: {
  instance: DatabaseInstance;
  pods: DatabasePodRaw[];
  secrets: DatabaseSecret[];
}): DatabaseCapabilities {
  const { instance } = args;
  const matched = args.pods.filter(
    (p) =>
      (p.metadata.namespace ?? "default") === instance.namespace &&
      Object.entries(instance.labelSelector).every(
        ([k, v]) => p.metadata.labels?.[k] === v,
      ),
  );
  const secretName = discoverSecret(matched as DiscoverPod[]);
  // Prefer the first Running pod, else the first matched pod (Swift uses the
  // same fallback when computing the connection target).
  const target =
    matched.find((p) => p.status?.phase === "Running") ?? matched[0];

  const items: DatabaseActionItem[] = [];
  items.push({
    action: { type: "scale", current: instance.desiredReplicas, desired: instance.desiredReplicas },
    enabled: true,
  });
  if (target) items.push({ action: { type: "portForward" }, enabled: true });
  if (secretName) items.push({ action: { type: "revealCredentials" }, enabled: true });
  items.push({ action: { type: "copyDSN" }, enabled: true });

  const connection: ConnectionInfo | undefined = target
    ? {
        targetKind: "pod",
        targetName: target.metadata.name,
        namespace: instance.namespace,
        port: operatorPort(instance.kind),
        scheme: operatorScheme(instance.kind),
        secretName,
        username: undefined,
        dbName: undefined,
      }
    : undefined;

  return { actions: items, connection };
}

// ---------------------------------------------------------------------------
// Action labels / icons / DSN
// ---------------------------------------------------------------------------

/** Button label for an action. Mirrors Swift `DatabaseAction.label`. */
export function actionLabel(action: DatabaseAction): string {
  switch (action.type) {
    case "backupNow":
      return "Back up";
    case "switchover":
      return "Switch over";
    case "hibernate":
      return action.on ? "Hibernate" : "Resume";
    case "scale":
      return "Scale";
    case "portForward":
      return "Port-forward";
    case "revealCredentials":
      return "Credentials";
    case "copyDSN":
      return "Copy DSN";
  }
}

/**
 * Build the DSN connection string. Mirrors Swift `DatabasesViewModel.dsn(for:)`:
 * `{scheme}://{user@}{target}.{namespace}{.svc}:{port}{/dbname}`. The `.svc`
 * suffix is added only for service targets (CNPG).
 */
export function dsn(c: ConnectionInfo): string {
  const hostSuffix = c.targetKind === "svc" ? `.${c.namespace}.svc` : `.${c.namespace}`;
  const userPart = c.username ? `${c.username}@` : "";
  const dbPart = c.dbName ? `/${c.dbName}` : "";
  return `${c.scheme}://${userPart}${c.targetName}${hostSuffix}:${c.port}${dbPart}`;
}

// ---------------------------------------------------------------------------
// Action → ActionBlock (confirm-sheet) conversion
//
// Returns null for non-mutating actions (portForward / revealCredentials /
// copyDSN) — those are handled directly in the UI layer. Mirrors the Swift
// `DatabaseRow.perform(_:)` action routing + the kubectl argv in the spec.
// ---------------------------------------------------------------------------

export function actionToBlock(
  action: DatabaseAction,
  instance: DatabaseInstance,
): ActionBlock | null {
  const ns = instance.namespace;
  const name = instance.name;

  switch (action.type) {
    case "backupNow":
      return {
        kind: "command",
        label: `Back up ${name}`,
        args: ["cnpg", "backup", name, "-n", ns],
        destructive: false,
      };

    case "switchover":
      if (!action.to) return null;
      return {
        kind: "command",
        label: `Switch over ${name} → ${action.to}`,
        args: ["cnpg", "promote", name, action.to, "-n", ns],
        destructive: true,
      };

    case "hibernate":
      return action.on
        ? {
            kind: "command",
            label: `Hibernate ${name}`,
            args: ["cnpg", "hibernate", "on", name, "-n", ns],
            destructive: true,
          }
        : {
            kind: "command",
            label: `Resume ${name}`,
            args: ["cnpg", "hibernate", "off", name, "-n", ns],
            destructive: false,
          };

    case "scale":
      if (instance.source === "cnpg") {
        return {
          kind: "command",
          label: `Scale ${name} → ${action.desired}`,
          args: [
            "patch",
            "cluster",
            name,
            "-n",
            ns,
            "--type=merge",
            "-p",
            `{"spec":{"instances":${action.desired}}}`,
          ],
          destructive: action.desired < action.current,
        };
      }
      // Image-detected: target the real workload kind so a StatefulSet-backed
      // DB scales `statefulset/<name>`, not `deployment/<name>` (server defaults
      // resourceKind to deployment). Mirrors Swift `scaleWorkload(kind:…)`.
      return {
        kind: "scale",
        name,
        namespace: ns,
        resourceKind: instance.source,
        replicas: action.desired,
      };

    // Non-mutating — handled in the UI layer.
    case "portForward":
    case "revealCredentials":
    case "copyDSN":
      return null;
  }
}
