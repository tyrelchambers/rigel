import { useCallback, useEffect, useState } from "react";
import { rigel, type Account, type EntitlementPayload, type MePayload, type Org, type VerifyResult } from "@/lib/desktop";

export type AccountStatus = "loading" | "signed-out" | "signed-in";

export interface UseAccountResult {
  status: AccountStatus;
  account: Account | null;
  me: MePayload | null;
  orgs: Org[];
  entitlement: EntitlementPayload | null;
  requestCode(email: string): Promise<{ ok: boolean; status: number }>;
  verifyCode(email: string, code: string): Promise<VerifyResult>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
  upgrade(orgId: string): Promise<{ clientSecret: string; publishableKey: string } | null>;
  manageBilling(orgId: string): Promise<{ ok: boolean } | undefined>;
  refreshBilling(): Promise<void>;
}

export function useAccount(): UseAccountResult {
  const [me, setMe] = useState<MePayload | null>(null);
  const [status, setStatus] = useState<AccountStatus>(rigel ? "loading" : "signed-out");
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [entitlement, setEntitlement] = useState<EntitlementPayload | null>(null);

  const refresh = useCallback(async () => {
    if (!rigel) { setStatus("signed-out"); setOrgs([]); setEntitlement(null); return; }
    const s = await rigel.account.status();
    setMe(s.account ? { account: s.account } : null);
    setOrgs(s.orgs ?? []);
    setStatus(s.signedIn ? "signed-in" : "signed-out");
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

  const requestCode = useCallback(
    (email: string) => rigel!.account.requestCode(email),
    [],
  );
  const verifyCode = useCallback(
    async (email: string, code: string): Promise<VerifyResult> => {
      const r = await rigel!.account.verifyCode(email, code);
      if (r.ok) await refresh();
      return r;
    },
    [refresh],
  );
  const signOut = useCallback(async () => {
    await rigel?.account.signOut();
    setMe(null);
    setOrgs([]);
    setEntitlement(null);
    setStatus("signed-out");
  }, []);
  const upgrade = useCallback((orgId: string) => rigel?.billing?.checkout(orgId) ?? Promise.resolve(null), []);
  const manageBilling = useCallback((orgId: string) => rigel?.billing?.portal(orgId) ?? Promise.resolve(undefined), []);
  // Manual entitlement refetch (the provider re-emits rigel:billing:changed → this hook refetches).
  const refreshBilling = useCallback(() => rigel?.billing?.refresh() ?? Promise.resolve(), []);

  return { status, account: me?.account ?? null, me, orgs, entitlement, requestCode, verifyCode, signOut, refresh, upgrade, manageBilling, refreshBilling };
}
