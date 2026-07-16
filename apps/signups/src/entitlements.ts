export type FeatureKey = "reliability" | "security" | "performance" | "cloudConnect" | "agentAutonomy";
const AUDIT_KEYS = ["reliability", "security", "performance"] as const;

export interface EntitlementPayload {
  plan: "free" | "pro";
  audits: ("reliability" | "security" | "performance")[];
  cloudConnect: boolean;
  agentAutonomy: boolean;
  fetchedAt: string;
}

export function resolvePayload(keys: Set<string>, fetchedAt: string): EntitlementPayload {
  const audits = AUDIT_KEYS.filter((k) => keys.has(k));
  const cloudConnect = keys.has("cloudConnect");
  const agentAutonomy = keys.has("agentAutonomy");
  const anyPaid = audits.length > 0 || cloudConnect || agentAutonomy;
  return { plan: anyPaid ? "pro" : "free", audits, cloudConnect, agentAutonomy, fetchedAt };
}

export interface OrgEntitlement {
  agentEntitled: boolean;
  plan: "free" | "pro";
  fetchedAt: string;
}

export async function resolveOrgEntitlement(
  orgId: string,
  deps: {
    db: { orgStripeCustomer(orgId: string): Promise<string | null> };
    stripe: { activeFeatureKeys(customerId: string): Promise<Set<string>> };
    now: () => string;
  },
): Promise<OrgEntitlement> {
  const customerId = await deps.db.orgStripeCustomer(orgId);
  const keys = customerId ? await deps.stripe.activeFeatureKeys(customerId) : new Set<string>();
  const payload = resolvePayload(keys, deps.now());
  return { agentEntitled: payload.agentAutonomy, plan: payload.plan, fetchedAt: payload.fetchedAt };
}

export interface ResolverDeps {
  db: { billableOrgs(accountId: string): Promise<{ orgId: string; stripeCustomerId: string | null }[]> };
  stripe: { activeFeatureKeys(customerId: string): Promise<Set<string>> };
  now: () => string;
  monoNow?: () => number; // for cache; defaults to Date.now
}

const CACHE_MS = 60_000;

export function makeResolver(
  deps: ResolverDeps,
): (accountId: string, opts?: { fresh?: boolean }) => Promise<EntitlementPayload> {
  const mono = deps.monoNow ?? (() => Date.now());
  const cache = new Map<string, { at: number; payload: EntitlementPayload }>();
  return async (accountId, opts) => {
    const hit = cache.get(accountId);
    if (!opts?.fresh && hit && mono() - hit.at < CACHE_MS) return hit.payload;
    const orgs = await deps.db.billableOrgs(accountId);
    const keys = new Set<string>();
    for (const o of orgs) {
      if (!o.stripeCustomerId) continue;
      for (const k of await deps.stripe.activeFeatureKeys(o.stripeCustomerId)) keys.add(k);
    }
    const payload = resolvePayload(keys, deps.now());
    cache.set(accountId, { at: mono(), payload });
    return payload;
  };
}
