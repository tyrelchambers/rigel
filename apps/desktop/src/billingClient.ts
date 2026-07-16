// EntitlementPayload is DEFINED here (the desktop-package copy). Do NOT cross-import
// from @rigel/signups — that's a deployed-backend package, not wired for desktop
// import (package boundary). This is one of the boundary mirrors of the shape
// canonically defined in apps/signups/src/entitlements.ts; keep the fields +
// precise audit union identical. desktop.ts (web) and apps/server keep their own
// mirrors of the same shape (like Account/Org). Canonical = signups.
export interface EntitlementPayload {
  plan: "free" | "pro";
  audits: ("reliability" | "security" | "performance")[];
  cloudConnect: boolean;
  agentAutonomy: boolean;
  fetchedAt: string;
}

export interface BillingStore { getToken(): string | null; }

export function createBillingClient({ store, fetchFn, endpoint }: { store: BillingStore; fetchFn: typeof fetch; endpoint: string }) {
  const auth = () => ({ authorization: `Bearer ${store.getToken() ?? ""}`, "content-type": "application/json" });
  const postUrl = async (path: string, orgId: string): Promise<string | null> => {
    try {
      const res = await fetchFn(`${endpoint}${path}`, { method: "POST", headers: auth(), body: JSON.stringify({ orgId }) });
      if (!res.ok) {
        console.error(`[billing] POST ${endpoint}${path} (org ${orgId}) → ${res.status}: ${await res.text().catch(() => "")}`);
        return null;
      }
      return (await res.json()).url ?? null;
    } catch (e) {
      console.error(`[billing] POST ${endpoint}${path} threw: ${String(e)}`);
      return null;
    }
  };
  return {
    checkout: (orgId: string) => postUrl("/billing/checkout", orgId),
    portal: (orgId: string) => postUrl("/billing/portal", orgId),
    async entitlements(): Promise<EntitlementPayload | null> {
      const res = await fetchFn(`${endpoint}/entitlements`, { headers: auth() });
      return res.ok ? ((await res.json()) as EntitlementPayload) : null;
    },
    async agentToken(orgId: string): Promise<{ token: string; installId: string } | null> {
      const res = await fetchFn(`${endpoint}/agent/token`, { method: "POST", headers: auth(), body: JSON.stringify({ orgId }) });
      if (!res.ok) return null;
      const j = (await res.json()) as { token?: unknown; installId?: unknown };
      return typeof j.token === "string" && typeof j.installId === "string" ? { token: j.token, installId: j.installId } : null;
    },
  };
}
export type BillingClient = ReturnType<typeof createBillingClient>;
