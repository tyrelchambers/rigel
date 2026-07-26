import { useCallback, useEffect, useState } from "react";
import { rigel, type Account, type EntitlementPayload, type MePayload, type Org, type PendingSignIn } from "@/lib/desktop";

export type AccountStatus = "loading" | "signed-out" | "signed-in";

export interface UseAccountResult {
  status: AccountStatus;
  account: Account | null;
  me: MePayload | null;
  orgs: Org[];
  entitlement: EntitlementPayload | null;
  /** An emailed sign-in link that has not been confirmed yet, if any. */
  pendingSignIn: PendingSignIn | null;
  startSignIn(email: string): Promise<{ ok: boolean; status: number }>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
  upgrade(orgId: string): Promise<{ clientSecret: string; publishableKey: string } | null>;
  manageBilling(orgId: string): Promise<{ ok: boolean } | undefined>;
  refreshBilling(): Promise<EntitlementPayload | null>;
}

export function useAccount(): UseAccountResult {
  const [me, setMe] = useState<MePayload | null>(null);
  const [status, setStatus] = useState<AccountStatus>(rigel ? "loading" : "signed-out");
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [entitlement, setEntitlement] = useState<EntitlementPayload | null>(null);
  const [pendingSignIn, setPendingSignIn] = useState<PendingSignIn | null>(null);

  const refresh = useCallback(async () => {
    if (!rigel) { setStatus("signed-out"); setOrgs([]); setEntitlement(null); setPendingSignIn(null); return; }
    const s = await rigel.account.status();
    setMe(s.account ? { account: s.account } : null);
    setOrgs(s.orgs ?? []);
    setStatus(s.signedIn ? "signed-in" : "signed-out");
    setPendingSignIn(s.pendingSignIn ?? null);
    setEntitlement((await rigel.billing?.entitlements()) ?? null);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!rigel) return;
    return rigel.account.onChanged(() => { void refresh(); });
  }, [refresh]);

  useEffect(() => {
    if (!rigel) return;
    return rigel.billing?.onChanged(() => { void refresh(); });
  }, [refresh]);

  const startSignIn = useCallback(
    async (email: string) => {
      const r = await rigel!.account.startSignIn(email);
      if (r.ok) await refresh(); // surfaces pendingSignIn immediately
      return r;
    },
    [refresh],
  );
  const signOut = useCallback(async () => {
    await rigel?.account.signOut();
    setMe(null);
    setOrgs([]);
    setEntitlement(null);
    setPendingSignIn(null);
    setStatus("signed-out");
  }, []);
  const upgrade = useCallback((orgId: string) => rigel?.billing?.checkout(orgId) ?? Promise.resolve(null), []);
  const manageBilling = useCallback((orgId: string) => rigel?.billing?.portal(orgId) ?? Promise.resolve(undefined), []);
  // Manual entitlement refetch (the provider re-emits rigel:billing:changed → this hook refetches).
  const refreshBilling = useCallback(() => rigel?.billing?.refresh() ?? Promise.resolve(null), []);

  return { status, account: me?.account ?? null, me, orgs, entitlement, pendingSignIn, startSignIn, signOut, refresh, upgrade, manageBilling, refreshBilling };
}
