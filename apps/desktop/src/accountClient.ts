export interface Account {
  id: string;
  email: string;
  name: string | null;
}

/** Forward-compatible with org/teams: orgs/invitations are optional and appear
 *  once the backend returns them (see the org-teams design record). */
export interface OrgSummary {
  id: string;
  kind: "personal" | "team";
  name: string;
  role: "owner" | "admin" | "member";
}
export interface PendingInvitation {
  id: string;
  orgName: string;
  role: string;
}
export interface MePayload {
  account: Account;
  orgs?: OrgSummary[];
  invitations?: PendingInvitation[];
}

/** The AccountStore surface the client needs (structurally satisfied by the real store). */
export interface TokenStore {
  getToken(): string | null;
  setToken(token: string): void;
  clear(): void;
}

export interface AccountClientDeps {
  store: TokenStore;
  fetchFn: typeof fetch;
  endpoint: string;
}

export type RequestResult = { ok: boolean; status: number };
export type VerifyResult = { ok: true; account: Account } | { ok: false; status: number };

export function createAccountClient({ store, fetchFn, endpoint }: AccountClientDeps) {
  const postJson = (path: string, body: unknown, token?: string) =>
    fetchFn(`${endpoint}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  return {
    async requestCode(email: string): Promise<RequestResult> {
      const res = await postJson("/auth/request", { email });
      return { ok: res.ok, status: res.status };
    },

    async verifyCode(email: string, code: string): Promise<VerifyResult> {
      const res = await postJson("/auth/verify", { email, code });
      if (!res.ok) return { ok: false, status: res.status };
      const body = (await res.json()) as { token: string; account: Account };
      store.setToken(body.token);
      return { ok: true, account: body.account };
    },

    async me(): Promise<MePayload | null> {
      const token = store.getToken();
      if (!token) return null;
      try {
        const res = await fetchFn(`${endpoint}/me`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401) { store.clear(); return null; }
        if (!res.ok) return null;
        return (await res.json()) as MePayload;
      } catch {
        return null;
      }
    },

    async signOut(): Promise<void> {
      const token = store.getToken();
      if (token) {
        try { await postJson("/auth/logout", {}, token); } catch { /* revoke best-effort */ }
      }
      store.clear();
    },
  };
}

export type AccountClient = ReturnType<typeof createAccountClient>;
