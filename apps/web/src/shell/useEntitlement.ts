import { useEffect, useState, useCallback } from "react";
import { rigel, type EntitlementPayload } from "@/lib/desktop";
import { BETA_ENTITLEMENT, FREE_PUBLIC_BETA } from "@/lib/beta";

/**
 * Subscribes to the desktop entitlement provider: reads the current (grace-applied)
 * payload on mount, then refetches whenever the provider emits rigel:billing:changed.
 * `upgrade(orgId)` opens the in-app Stripe Checkout window. Inert on the web build
 * (no bridge) — payload stays null, which every gate treats as locked (free).
 */
export function useEntitlement(): { payload: EntitlementPayload | null; upgrade(orgId: string): void } {
  const [payload, setPayload] = useState<EntitlementPayload | null>(null);
  useEffect(() => {
    const b = rigel?.billing;
    if (!b) return;
    let cancelled = false;
    const load = () => b.entitlements().then((e) => { if (!cancelled) setPayload(e); }).catch(() => {});
    load();
    const off = b.onChanged(load);
    return () => { cancelled = true; off(); };
  }, []);
  const upgrade = useCallback((orgId: string) => void rigel?.billing?.checkout(orgId), []);
  return { payload: FREE_PUBLIC_BETA ? BETA_ENTITLEMENT : payload, upgrade };
}
