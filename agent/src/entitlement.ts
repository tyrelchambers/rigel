import type { Config } from "./config.js";
import { readState, type Entitlement } from "./state.js";

export type { Entitlement };

export type FetchResult =
  | { status: "ok"; value: Entitlement }
  | { status: "unauth" }
  | { status: "error" };

/** Bound the entitlement fetch so a hung backend can't stall the tick (and thus
 *  observe) for undici's multi-minute default. The abort maps to `error` → grace. */
const FETCH_TIMEOUT_MS = 5000;

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

/** GET {endpoint}/agent/entitlement with a Bearer token. 2xx JSON → ok;
 *  401/403 → unauth; network/5xx/timeout/malformed → error. */
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
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

export interface EntitlementDecision {
  entitled: boolean;
  /** The value the caller should persist as the new cache — set ONLY on a
   *  successful fresh fetch, so the caller folds it into its own single state
   *  write (no second writer to clobber). Absent when nothing new was fetched. */
  cache?: Entitlement;
}

/**
 * The full per-tick entitlement decision, orchestrating the fetch around the pure
 * decision. `cache` comes from the already-read assistant-state (no extra get). It
 * does NOT write — it RETURNS the value to cache so the caller can fold it into its
 * own single state write. Never throws — a failed fetch falls back to the grace-held
 * cache (or free) so it can never crash a tick or stop observe. An unconfigured token
 * short-circuits to free with no network call.
 */
export async function determineEntitlement(args: {
  cfg: Config;
  now: number;
  cache: Entitlement | null;
  fetchFn?: typeof fetch;
  force?: boolean;
}): Promise<EntitlementDecision> {
  const { cfg, now, cache, force } = args;
  if (cfg.agentToken === "") return { entitled: false };
  // Default to "error" so a tick that does NOT refetch holds the last-known-good
  // cache through the grace window (or falls closed to free when there is none).
  let fetchResult: FetchResult = { status: "error" };
  let toCache: Entitlement | undefined;
  if (force || shouldRefetch(cache, now, cfg)) {
    fetchResult = await fetchEntitlement(cfg.entitlementEndpoint, cfg.agentToken, args.fetchFn);
    if (fetchResult.status === "ok")
      toCache = { agentEntitled: fetchResult.value.agentEntitled, fetchedAt: new Date(now).toISOString() };
  }
  return { entitled: resolveEntitlement({ cfg, now, cache, fetchResult }), cache: toCache };
}
