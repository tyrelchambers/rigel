// Display helpers for the Databases panel: detection, normalization, health,
// age, search, sort, pod matching, and connection-string construction.
// Mirrors the Swift `Sources/Helmsman/Panels/Databases/` helpers.
// See docs/parity/databases.md for the normative spec.

import type {
  CNPGCluster,
  CNPGScheduledBackup,
  DatabaseInstance,
  DatabaseKind,
  DatabasePod,
  DatabasePodRaw,
  DatabaseSource,
  WalArchivingStatus,
  WorkloadDB,
} from "./types";

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
 * Build a normalized instance from a CNPG cluster. ScheduledBackups are matched
 * by `spec.cluster.name` against the cluster name + namespace.
 */
export function instanceFromCNPG(
  cluster: CNPGCluster,
  scheduledBackups: CNPGScheduledBackup[],
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
    lastBackup: cluster.status?.lastSuccessfulBackup,
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
  deployments: WorkloadDB[];
  statefulSets: WorkloadDB[];
}): DatabaseInstance[] {
  const out: DatabaseInstance[] = [];
  for (const c of args.cnpgClusters) {
    out.push(instanceFromCNPG(c, args.scheduledBackups));
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
