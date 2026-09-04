import { FAILOVER_CONFIG_KEY } from "@rigel/k8s/src/userConfig";
import {
  applyFailoverPatch,
  maskFailoverDestination,
  parseFailoverDestination,
  serializeFailoverDestination,
  type FailoverDestination,
  type FailoverDestinationPatch,
  type FailoverDestinationView,
} from "@rigel/k8s/src/failover/destination";
import { FAILOVER_STATE_KEY } from "@rigel/k8s/src/userConfig";
import { parseFailoverState } from "@rigel/k8s/src/failover/state";
import type { FailoverValidation } from "@rigel/k8s/src/failover/validation";
import { readUserConfig, writeUserConfig, type ClusterConfigStatus } from "./clusterConfigStore";
import { failoverOpsFor } from "./failoverProviders";
import { createBucket, validateObjectStore } from "./objectStore";

/** The fields that make a stored destination worth a network round trip. */
function touchesCredentials(patch: FailoverDestinationPatch): boolean {
  return patch.token !== undefined || patch.objectStore !== undefined;
}

export interface FailoverConfigRead extends FailoverDestinationView {
  cluster: ClusterConfigStatus;
}

export async function readFailoverDestination(context: string | null): Promise<FailoverDestination | null> {
  const read = await readUserConfig(context);
  return parseFailoverDestination(read.data[FAILOVER_CONFIG_KEY]);
}

export async function failoverConfigView(context: string | null): Promise<FailoverConfigRead> {
  const read = await readUserConfig(context);
  const dest = parseFailoverDestination(read.data[FAILOVER_CONFIG_KEY]);
  const { data: _data, ...cluster } = read;
  return { ...maskFailoverDestination(dest), cluster };
}

export function failoverPatchFromBody(body: unknown): FailoverDestinationPatch {
  if (!body || typeof body !== "object") return {};
  const o = body as Record<string, unknown>;
  const patch: FailoverDestinationPatch = {};
  if (typeof o.token === "string") patch.token = o.token;
  if (o.objectStore === null) patch.objectStore = null;
  else if (o.objectStore && typeof o.objectStore === "object") {
    const r = o.objectStore as Record<string, unknown>;
    const store: NonNullable<FailoverDestinationPatch["objectStore"]> = {};
    for (const field of ["endpoint", "region", "bucket", "accessKey", "secretKey"] as const) {
      if (typeof r[field] === "string") store[field] = r[field] as string;
    }
    if (r.addressing === "virtualHost" || r.addressing === "path") store.addressing = r.addressing;
    patch.objectStore = store;
  }
  if (typeof o.region === "string") patch.region = o.region;
  if (typeof o.nodeSize === "string") patch.nodeSize = o.nodeSize;
  if (typeof o.nodeCount === "number") patch.nodeCount = o.nodeCount;
  if (o.edge && typeof o.edge === "object") {
    const e = o.edge as { host?: unknown; backends?: unknown };
    const host = typeof e.host === "string" ? e.host.trim() : "";
    const backends = Array.isArray(e.backends)
      ? e.backends.flatMap((b) => {
          const r = (b ?? {}) as { name?: unknown; ip?: unknown };
          return typeof r.name === "string" && typeof r.ip === "string" && r.name && r.ip
            ? [{ name: r.name, ip: r.ip }]
            : [];
        })
      : [];
    if (host) patch.edge = { host, backends };
  }
  return patch;
}

export interface ValidateDeps {
  validateApi?: (dest: FailoverDestination) => Promise<Pick<FailoverValidation, "api" | "options">>;
  validateStore?: typeof validateObjectStore;
  createBucket?: typeof createBucket;
}

/**
 * Checks a patch merged onto what is stored, without writing anything. A merge
 * that is still missing a token answers inline rather than as an HTTP error,
 * because the wizard shows it under the field.
 */
export async function validateFailoverPatch(
  context: string | null,
  patch: FailoverDestinationPatch,
  deps: ValidateDeps = {},
): Promise<FailoverValidation> {
  const next = applyFailoverPatch(await readFailoverDestination(context), patch);
  if (!next) {
    return { ok: false, api: { ok: false, error: "DigitalOcean token is required" } };
  }
  const checkApi = deps.validateApi ?? ((d: FailoverDestination) => failoverOpsFor(d.provider).validate(d));
  const checkStore = deps.validateStore ?? validateObjectStore;

  const api = await checkApi(next);
  const objectStore = next.objectStore ? await checkStore(next.objectStore) : undefined;
  const ok = api.api.ok && (objectStore ? objectStore.ok : true);
  return { ok, ...api, ...(objectStore ? { objectStore } : {}) };
}

export async function writeFailoverPatch(
  context: string | null,
  patch: FailoverDestinationPatch,
  deps: ValidateDeps = {},
): Promise<FailoverConfigRead> {
  const current = await readFailoverDestination(context);
  const next = applyFailoverPatch(current, patch);
  if (!next) {
    throw new Error("A DigitalOcean token is required");
  }

  // Credentials are proved before they are stored. A patch that only moves the
  // cluster shape or the edge has nothing to prove, so it writes straight away.
  if (touchesCredentials(patch)) {
    const result = await validateFailoverPatch(context, patch, deps);
    if (!result.api.ok) throw new Error(result.api.error);
    if (result.objectStore && !result.objectStore.ok) throw new Error(result.objectStore.error);
    if (next.objectStore && result.objectStore?.ok && !result.objectStore.bucketExists) {
      await (deps.createBucket ?? createBucket)(next.objectStore);
    }
  }

  await writeUserConfig(context, () => ({
    [FAILOVER_CONFIG_KEY]: serializeFailoverDestination(next),
  }));
  return failoverConfigView(context);
}

/** The token is what destroys a cluster, so it cannot be removed while one exists. */
export async function deleteFailoverDestination(context: string | null): Promise<FailoverConfigRead> {
  const read = await readUserConfig(context);
  const state = parseFailoverState(read.data[FAILOVER_STATE_KEY] ?? "");
  if (state.failedOverTo || state.leftBehind) {
    const err = new Error(
      "A failover is still using this destination. Restore home, or destroy the cluster that was left behind, first.",
    ) as Error & { status: number };
    err.status = 409;
    throw err;
  }
  await writeUserConfig(context, () => ({ [FAILOVER_CONFIG_KEY]: "" }));
  return failoverConfigView(context);
}
