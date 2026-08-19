// Per-cluster user configuration, stored in the `rigel-user-config` Secret in
// the install namespace and read through the operator's own kubeconfig.
//
// There is deliberately NO local-file fallback: configuration follows the
// cluster it was entered against. With no cluster reachable, a read reports
// "unavailable" and a write fails, rather than saving somewhere the next
// connected session would not look.
//
// The kubectl surface here (get / apply / -n <install namespace> on secrets) is
// the same one connectGithub + readGithubSecret in git.ts already exercise with
// the operator's credentials, so it needs no permission the app does not have.
import { kubectl, type RunResult } from "@rigel/k8s/src/run";
import {
  USER_CONFIG_SECRET,
  emptyUserConfigData,
  isSecretAbsent,
  isUserConfigEmpty,
  parseUserConfigSecret,
  userConfigSecretJSON,
  type UserConfigData,
  type UserConfigKey,
} from "@rigel/k8s/src/userConfig";
import { applyManifest } from "./install";
import { STATE_NAMESPACE } from "./git";
import { readLocalConfig, removeLocalConfig } from "./localConfigMigration";

/** "ok" = the cluster answered, so an empty config means "not configured yet".
 *  "unavailable" = nothing was read, which is a different situation entirely. */
export type ClusterConfigState = "ok" | "unavailable";

export interface ClusterConfigStatus {
  /** The kubectl context the config belongs to; null = kubeconfig's current. */
  context: string | null;
  /** Namespace the Secret lives in, so the UI can name where it went. */
  namespace: string;
  /** The Secret holding it. */
  secret: string;
  state: ClusterConfigState;
  /** Why the read failed, when state is "unavailable". */
  message?: string;
}

export interface ClusterConfigRead extends ClusterConfigStatus {
  data: UserConfigData;
}

export interface ClusterConfigIO {
  read(context: string | null): Promise<RunResult>;
  write(context: string | null, manifestJSON: string): Promise<RunResult>;
  log(message: string): void;
}

const defaultIO: ClusterConfigIO = {
  read: (context) =>
    kubectl(context, ["get", "secret", USER_CONFIG_SECRET, "-n", STATE_NAMESPACE, "-o", "json"]),
  write: (context, manifestJSON) => applyManifest(context, manifestJSON),
  log: (message) => process.stderr.write(`${message}\n`),
};

let io: ClusterConfigIO = defaultIO;

/** Test seam: replace the kubectl boundary; pass null to restore it. */
export function __setClusterConfigIO(next: ClusterConfigIO | null): void {
  io = next ?? defaultIO;
}

// Config is read on per-request paths, so every read would otherwise be an API
// call. Successful reads are cached until a write replaces them; the server is
// the only writer of this Secret. A failed read expires quickly instead of
// being cached forever, so a cluster that comes back is picked up, while a
// burst of reads against a cluster that is down (agentsView asks per agent)
// still costs one timing-out kubectl rather than one per read.
const UNAVAILABLE_TTL_MS = 5_000;

interface CacheEntry {
  read: Promise<ClusterConfigRead>;
  /** Epoch ms after which this entry is stale; Infinity for a good read. */
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const migrated = new Set<string>();

function cacheKey(context: string | null): string {
  return context ?? "";
}

/** Test seam: drop every cached read and let migration run again. */
export function __resetClusterConfigCache(): void {
  cache.clear();
  migrated.clear();
}

function statusOf(context: string | null, state: ClusterConfigState, message?: string): ClusterConfigStatus {
  return {
    context,
    namespace: STATE_NAMESPACE,
    secret: USER_CONFIG_SECRET,
    state,
    ...(message ? { message } : {}),
  };
}

function failureMessage(res: RunResult): string {
  return res.stderr.trim() || res.stdout.trim() || `kubectl exited ${res.code}`;
}

/**
 * Lift whatever the local files still hold into a cluster that has no Secret
 * yet, then drain those files so no credential lives in two places. Files whose
 * values could not be decrypted here are kept and named in the log.
 */
async function migrateLocalConfig(context: string | null): Promise<UserConfigData | null> {
  const key = cacheKey(context);
  if (migrated.has(key)) return null;
  migrated.add(key);

  const local = await readLocalConfig();
  if (!local) return null;
  const data = { ...emptyUserConfigData(), ...local.data };
  if (isUserConfigEmpty(data)) {
    if (local.undecryptable.length === 0) await removeLocalConfig(local.files);
    return null;
  }

  const res = await io.write(context, userConfigSecretJSON(STATE_NAMESPACE, data));
  if (res.code !== 0) {
    migrated.delete(key);
    io.log(
      `rigel: could not move local config into ${USER_CONFIG_SECRET} on ${context ?? "the current context"}: ${failureMessage(res)}`,
    );
    return null;
  }

  if (local.undecryptable.length > 0) {
    io.log(
      `rigel: moved local config into ${USER_CONFIG_SECRET} on ${context ?? "the current context"}, but ${local.undecryptable.join(", ")} could not be decrypted on this machine, so ${local.files.join(", ")} were left in place`,
    );
    return data;
  }

  const failed = await removeLocalConfig(local.files);
  io.log(
    failed.length > 0
      ? `rigel: moved local config into ${USER_CONFIG_SECRET} on ${context ?? "the current context"}; could not remove ${failed.join(", ")}`
      : `rigel: moved local config into ${USER_CONFIG_SECRET} on ${context ?? "the current context"} and removed ${local.files.join(", ")}`,
  );
  return data;
}

async function loadUserConfig(context: string | null): Promise<ClusterConfigRead> {
  const res = await io.read(context);
  if (res.code === 0) {
    return {
      ...statusOf(context, "ok"),
      data: parseUserConfigSecret(res.stdout, (v) => Buffer.from(v, "base64").toString("utf8")),
    };
  }
  if (!isSecretAbsent(res)) {
    return { ...statusOf(context, "unavailable", failureMessage(res)), data: emptyUserConfigData() };
  }
  const lifted = await migrateLocalConfig(context);
  return { ...statusOf(context, "ok"), data: lifted ?? emptyUserConfigData() };
}

/** The cluster's stored config. Cached per context, invalidated by every write. */
export function readUserConfig(context: string | null): Promise<ClusterConfigRead> {
  const key = cacheKey(context);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.read;

  const entry: CacheEntry = { read: loadUserConfig(context), expiresAt: Infinity };
  cache.set(key, entry);
  entry.read.then(
    (read) => {
      if (read.state !== "ok") entry.expiresAt = Date.now() + UNAVAILABLE_TTL_MS;
    },
    () => {
      entry.expiresAt = Date.now() + UNAVAILABLE_TTL_MS;
    },
  );
  return entry.read;
}

// A write is a read-modify-write over one Secret, so two overlapping writes
// would each store a copy missing the other's change. This tail chains every
// write behind the previous one; the server is a single Node process and no
// other writer touches the Secret, so that is a complete fix.
let tail: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job);
  tail = run.catch(() => undefined);
  return run;
}

/**
 * Apply an edit to the cluster's config. `edit` runs INSIDE the write queue on
 * the freshly read data, so a caller that merges into one key's document (the
 * voice and agents blobs both do) cannot lose a concurrent edit to that same
 * document. Throws when the cluster cannot be read or written: a save that goes
 * nowhere must not report success.
 */
export function writeUserConfig(
  context: string | null,
  edit: (current: UserConfigData) => Partial<Record<UserConfigKey, string>>,
): Promise<ClusterConfigRead> {
  return enqueue(async () => {
    const current = await readUserConfig(context);
    if (current.state !== "ok") {
      throw new Error(
        current.message
          ? `no cluster to save to: ${current.message}`
          : "no cluster to save to",
      );
    }
    const data: UserConfigData = { ...current.data, ...edit(current.data) };
    const res = await io.write(context, userConfigSecretJSON(STATE_NAMESPACE, data));
    if (res.code !== 0) throw new Error(failureMessage(res));
    const next: ClusterConfigRead = { ...statusOf(context, "ok"), data };
    cache.set(cacheKey(context), { read: Promise.resolve(next), expiresAt: Infinity });
    return next;
  });
}

/**
 * Test seam: replace the kubectl boundary with an in-memory Secret per context
 * and return a handle to it. Config is read on nearly every server path, so the
 * three config modules' tests all need this same double; it lives here rather
 * than being copied into each of them. Never create a real Secret to test this.
 */
export interface FakeClusterConfig {
  /** Stored Secret data, keyed by context ("" = the kubeconfig's current). */
  secrets: Map<string, UserConfigData>;
  /** Flip to false to simulate a cluster that cannot be reached. */
  reachable: boolean;
  /** Every manifest handed to `kubectl apply`, oldest first. */
  writes: string[];
  /** One entry per `kubectl get` that actually reached the boundary. */
  reads: (string | null)[];
  logs: string[];
}

export function __useFakeClusterConfig(): FakeClusterConfig {
  const fake: FakeClusterConfig = {
    secrets: new Map(),
    reachable: true,
    writes: [],
    reads: [],
    logs: [],
  };
  const unreachable: RunResult = {
    code: 1,
    stdout: "",
    stderr: "The connection to the server 127.0.0.1:6443 was refused",
  };
  __resetClusterConfigCache();
  __setClusterConfigIO({
    read: async (context) => {
      fake.reads.push(context);
      if (!fake.reachable) return unreachable;
      const data = fake.secrets.get(cacheKey(context));
      if (!data) {
        return {
          code: 1,
          stdout: "",
          stderr: `Error from server (NotFound): secrets "${USER_CONFIG_SECRET}" not found`,
        };
      }
      const encoded: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) encoded[k] = Buffer.from(v, "utf8").toString("base64");
      return { code: 0, stdout: JSON.stringify({ data: encoded }), stderr: "" };
    },
    write: async (context, manifestJSON) => {
      fake.writes.push(manifestJSON);
      if (!fake.reachable) return unreachable;
      const parsed = JSON.parse(manifestJSON) as { stringData: UserConfigData };
      fake.secrets.set(cacheKey(context), { ...parsed.stringData });
      return { code: 0, stdout: `secret/${USER_CONFIG_SECRET} configured`, stderr: "" };
    },
    log: (message) => fake.logs.push(message),
  });
  return fake;
}
