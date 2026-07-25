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

export type StartSignInResult =
  | { ok: true; status: number; pollToken: string; displayCode: string }
  | { ok: false; status: number };
export type PollResult =
  | { status: "confirmed"; account: Account }
  | { status: "pending" }
  | { status: "expired" };

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
    /** Begin a device-authorization sign-in. Returns the poll token to hand to
     *  poll(), and the code the app must display for the user to match against
     *  the confirm page. */
    async startSignIn(email: string): Promise<StartSignInResult> {
      const res = await postJson("/auth/request", { email });
      if (!res.ok) return { ok: false, status: res.status };
      const body = (await res.json()) as { pollToken?: string; displayCode?: string };
      if (typeof body.pollToken !== "string" || typeof body.displayCode !== "string") {
        return { ok: false, status: res.status };
      }
      return { ok: true, status: res.status, pollToken: body.pollToken, displayCode: body.displayCode };
    },

    /** One poll tick. Network and server errors report "pending" so a blip never
     *  ends a sign-in that is still valid server-side; only an explicit 404 means
     *  the pending login is gone. */
    async poll(pollToken: string): Promise<PollResult> {
      let res: Awaited<ReturnType<typeof postJson>>;
      try {
        res = await postJson("/auth/poll", { pollToken });
      } catch {
        return { status: "pending" };
      }
      if (res.status === 404) return { status: "expired" };
      if (!res.ok) return { status: "pending" };
      const body = (await res.json()) as { status?: string; token?: string; account?: Account };
      if (body.status === "confirmed" && body.token && body.account) {
        store.setToken(body.token);
        return { status: "confirmed", account: body.account };
      }
      return { status: "pending" };
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

    /** Revoke every device, this one included. Unlike signOut the server call is
     *  the whole point, so a failure is reported rather than swallowed: clearing
     *  locally while other devices stay signed in would be a lie. */
    async signOutEverywhere(): Promise<{ ok: boolean }> {
      const token = store.getToken();
      if (!token) return { ok: true };
      const res = await postJson("/auth/logout-all", {}, token);
      if (!res.ok) throw new Error(`sign out everywhere failed: ${res.status}`);
      store.clear();
      return { ok: true };
    },
  };
}

export type AccountClient = ReturnType<typeof createAccountClient>;
