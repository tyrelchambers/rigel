import type { Config } from "./config.js";
import { readState, writeState, type Entitlement } from "./state.js";

export type { Entitlement };

export type FetchResult =
  | { status: "ok"; value: Entitlement }
  | { status: "unauth" }
  | { status: "error" };

/** Validate a stored/fetched entitlement's shape. Null on missing/garbage. */
export function parseEntitlement(raw: unknown): Entitlement | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { agentEntitled?: unknown; fetchedAt?: unknown };
  if (typeof o.agentEntitled !== "boolean" || typeof o.fetchedAt !== "string") return null;
  return { agentEntitled: o.agentEntitled, fetchedAt: o.fetchedAt };
}

/** Read the cached entitlement out of assistant-state. Null on miss/garbage. */
export async function readEntitlementCache(cfg: Config): Promise<Entitlement | null> {
  const state = await readState(cfg.stateConfigMap, cfg.stateNamespace);
  return parseEntitlement(state.entitlement);
}

/** Persist the cached entitlement into assistant-state, preserving every other
 *  state key (read-modify-write via the agent's own state path). */
export async function writeEntitlementCache(cfg: Config, e: Entitlement): Promise<void> {
  const state = await readState(cfg.stateConfigMap, cfg.stateNamespace);
  await writeState(cfg.stateConfigMap, cfg.stateNamespace, { ...state, entitlement: e });
}

/** GET {endpoint}/agent/entitlement with a Bearer token. 2xx JSON → ok;
 *  401/403 → unauth; network/5xx/malformed → error. */
export async function fetchEntitlement(
  endpoint: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<FetchResult> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetchFn(`${endpoint.replace(/\/+$/, "")}/agent/entitlement`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    return { status: "error" };
  }
  if (res.status === 401 || res.status === 403) return { status: "unauth" };
  if (!res.ok) return { status: "error" };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: "error" };
  }
  const value = parseEntitlement(body);
  return value ? { status: "ok", value } : { status: "error" };
}

/** Whether a cached fetchedAt is temporally plausible: parses, not in the future,
 *  and within the grace window. */
function cacheWithinGrace(cache: Entitlement, now: number, graceMs: number): boolean {
  const t = Date.parse(cache.fetchedAt);
  if (!Number.isFinite(t) || t > now) return false;
  return now - t <= graceMs;
}

/**
 * PURE entitlement decision:
 *  - ok    → the fetched value (authoritative; an authenticated-free org downgrades now).
 *  - unauth→ false (bad/revoked token ⇒ free).
 *  - error → hold last-known-good IFF the cache is temporally valid and within grace,
 *            else false (fail closed to free).
 */
export function resolveEntitlement(args: {
  cfg: Config;
  now: number;
  cache: Entitlement | null;
  fetchResult: FetchResult;
}): boolean {
  const { cfg, now, cache, fetchResult } = args;
  if (fetchResult.status === "ok") return fetchResult.value.agentEntitled;
  if (fetchResult.status === "unauth") return false;
  if (cache && cacheWithinGrace(cache, now, cfg.entitlementGraceMs)) return cache.agentEntitled;
  return false;
}

/** True when there is no cache, the cached timestamp is implausible/in the future,
 *  or the check interval has elapsed since it was fetched. */
export function shouldRefetch(cache: Entitlement | null, now: number, cfg: Config): boolean {
  if (!cache) return true;
  const t = Date.parse(cache.fetchedAt);
  if (!Number.isFinite(t) || t > now) return true;
  return now - t >= cfg.entitlementCheckMs;
}

/**
 * The full per-tick entitlement decision, orchestrating the IO around the pure
 * decision. `cache` comes from the already-read assistant-state (no extra get).
 * Never throws — a failed fetch/write falls back to the grace-held cache (or free)
 * so it can never crash a tick or stop observe. An unconfigured token short-circuits
 * to free with no network call.
 */
export async function determineEntitlement(args: {
  cfg: Config;
  now: number;
  cache: Entitlement | null;
  fetchFn?: typeof fetch;
}): Promise<boolean> {
  const { cfg, now, cache } = args;
  if (cfg.agentToken === "") return false;
  // Default to "error" so a tick that does NOT refetch holds the last-known-good
  // cache through the grace window (or falls closed to free when there is none).
  let fetchResult: FetchResult = { status: "error" };
  if (shouldRefetch(cache, now, cfg)) {
    fetchResult = await fetchEntitlement(cfg.entitlementEndpoint, cfg.agentToken, args.fetchFn);
    if (fetchResult.status === "ok") {
      try {
        await writeEntitlementCache(cfg, fetchResult.value);
      } catch {
        // best-effort cache persist; the resolved value this tick is unaffected
      }
    }
  }
  return resolveEntitlement({ cfg, now, cache, fetchResult });
}
