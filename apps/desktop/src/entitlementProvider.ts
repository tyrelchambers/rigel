import type { EntitlementPayload } from "./billingClient";

const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
export const FREE_AUDITS: EntitlementPayload["audits"] = [];

export function free(nowMs: number): EntitlementPayload {
  return { plan: "free", audits: FREE_AUDITS, cloudConnect: false, agentAutonomy: false, fetchedAt: new Date(nowMs).toISOString() };
}

// A cached payload is honored for 14 days from its fetchedAt (the offline/outage
// grace), past that with no fresh fetch → FREE. No cache → FREE. A successful
// fetch overwrites the cache (see the provider) so a real cancellation drops to
// free immediately — grace applies ONLY when the resolver is unreachable.
export function applyGrace(cached: EntitlementPayload | null, nowMs: number): EntitlementPayload {
  if (!cached) return free(nowMs);
  const age = nowMs - Date.parse(cached.fetchedAt);
  return age <= GRACE_MS ? cached : free(nowMs);
}

// Edge-trigger for the Layer-1 agent downgrade (see the entitlement-lifecycle
// spec). True ONLY on a genuine agentAutonomy true → false transition backed by a
// SUCCESSFUL fetch. `prevAutonomy` is the last successfully-fetched value (null
// until the first in-process success), so this never fires on the initial load,
// the no-cache default, or a failed fetch (grace) — any of which would strand a
// paying user whose autonomy was silently disabled by a transient glitch.
export function detectAgentDowngrade(
  prevAutonomy: boolean | null,
  nextAutonomy: boolean,
  fetchSucceeded: boolean,
): boolean {
  return fetchSucceeded && prevAutonomy === true && nextAutonomy === false;
}

export interface EntitlementProviderDeps {
  client: { entitlements(): Promise<EntitlementPayload | null> };
  store: { load(): EntitlementPayload | null; save(v: EntitlementPayload): void };
  now: () => number;
}

export function createEntitlementProvider(deps: EntitlementProviderDeps) {
  let cached: EntitlementPayload | null = deps.store.load();
  // The last SUCCESSFULLY-fetched agentAutonomy, set only by an in-process fetch
  // (NOT seeded from the loaded cache) so the downgrade edge is a real transition
  // observed while the app is open, never the null/no-cache default.
  let prevAutonomy: boolean | null = null;
  const listeners = new Set<(e: EntitlementPayload) => void>();
  const downgradeListeners = new Set<() => void>();
  const emit = () => { const e = applyGrace(cached, deps.now()); for (const l of listeners) l(e); };
  return {
    current: () => applyGrace(cached, deps.now()),
    async refresh() {
      const fresh = await deps.client.entitlements().catch(() => null);
      const fetchSucceeded = fresh !== null;
      if (fresh) {
        const downgraded = detectAgentDowngrade(prevAutonomy, fresh.agentAutonomy, fetchSucceeded);
        cached = fresh;
        deps.store.save(fresh);
        prevAutonomy = fresh.agentAutonomy;
        if (downgraded) for (const l of downgradeListeners) l();
      }
      emit();
    },
    onChange(cb: (e: EntitlementPayload) => void) { listeners.add(cb); return () => listeners.delete(cb); },
    onDowngrade(cb: () => void) { downgradeListeners.add(cb); return () => downgradeListeners.delete(cb); },
  };
}
export type EntitlementProvider = ReturnType<typeof createEntitlementProvider>;
