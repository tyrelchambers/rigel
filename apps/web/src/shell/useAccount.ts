import { useCallback, useEffect, useState } from "react";
import { rigel, type Account, type MePayload, type Org, type VerifyResult } from "@/lib/desktop";

export type AccountStatus = "loading" | "signed-out" | "signed-in";

export interface UseAccountResult {
  status: AccountStatus;
  account: Account | null;
  me: MePayload | null;
  orgs: Org[];
  requestCode(email: string): Promise<{ ok: boolean; status: number }>;
  verifyCode(email: string, code: string): Promise<VerifyResult>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

export function useAccount(): UseAccountResult {
  const [me, setMe] = useState<MePayload | null>(null);
  const [status, setStatus] = useState<AccountStatus>(rigel ? "loading" : "signed-out");
  const [orgs, setOrgs] = useState<Org[]>([]);

  const refresh = useCallback(async () => {
    if (!rigel) { setStatus("signed-out"); setOrgs([]); return; }
    const s = await rigel.account.status();
    setMe(s.account ? { account: s.account } : null);
    setOrgs(s.orgs ?? []);
    setStatus(s.signedIn ? "signed-in" : "signed-out");
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!rigel) return;
    return rigel.account.onChanged(() => { void refresh(); });
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
    setStatus("signed-out");
  }, []);

  return { status, account: me?.account ?? null, me, orgs, requestCode, verifyCode, signOut, refresh };
}
