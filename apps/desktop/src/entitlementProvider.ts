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

export interface EntitlementProviderDeps {
  client: { entitlements(fresh?: boolean): Promise<EntitlementPayload | null> };
  store: { load(): EntitlementPayload | null; save(v: EntitlementPayload): void };
  now: () => number;
}

export function createEntitlementProvider(deps: EntitlementProviderDeps) {
  let cached: EntitlementPayload | null = deps.store.load();
  const listeners = new Set<(e: EntitlementPayload) => void>();
  const emit = () => { const e = applyGrace(cached, deps.now()); for (const l of listeners) l(e); };
  return {
    current: () => applyGrace(cached, deps.now()),
    async refresh(fresh?: boolean): Promise<EntitlementPayload> {
      const resolved = await deps.client.entitlements(fresh).catch(() => null);
      if (resolved) {
        cached = resolved;
        deps.store.save(resolved);
      }
      emit();
      return applyGrace(cached, deps.now());
    },
    onChange(cb: (e: EntitlementPayload) => void) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
export type EntitlementProvider = ReturnType<typeof createEntitlementProvider>;
