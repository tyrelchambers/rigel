# Accounts + Auth — Phase 2 (Electron main identity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkbox syntax.

**Goal:** The Electron main process owns the account credential: it runs the OTP login against `api.rigel.run`, stores the bearer token encrypted via `safeStorage`, and exposes an `account` API to the renderer over contextBridge — the renderer never sees the raw token.

**Architecture:** Two pure, injectable modules (`accountStore`, `accountClient`) mirroring the existing `installStore.ts`/`signup.ts` convention (no direct `electron` import → unit-testable in plain Vitest), wired into `main.ts` (which supplies the real `safeStorage`) via `ipcMain` handlers and surfaced through `preload.ts` + `lib/desktop.ts`.

**Tech Stack:** Electron (`safeStorage`, `ipcMain`, `contextBridge`), TypeScript, Vitest. Reuses `SIGNUP_ENDPOINT` (`https://api.rigel.run`) already in `main.ts`.

**Scope note / deviation from the original umbrella plan:** the umbrella plan grouped "generate `sessionSecret` + `postMessage` the secret+token to the forked server" under Phase 2. That plumbing has **no consumer yet** (the session secret is consumed by the Phase-3 server middleware; the account token is consumed by HELM-16's entitlement fetch). Per YAGNI, this plan defers that plumbing to the phases that consume it: **session-secret generation/plumbing → Phase 3**, **token-to-server plumbing → HELM-16**. Phase 2 delivers only the main-process account identity that the Phase-4 UI drives (and that we can manually smoke once the backend deploys).

**Dependency:** the backend `/auth/*` + `/me` routes (Phase 1) exist in `apps/signups` but are **not deployed** yet. Phase 2 is fully unit-tested against injected `fetchFn`/`safeStorage` fakes; live end-to-end waits on backend rollout (Phase 4).

**Backend contract (Phase 1, shipped):**
- `POST /auth/request {email}` → `{ok:true}` (200) | 400 | 429 | 502
- `POST /auth/verify {email,code}` → `{ token, account:{id,email,name} }` (200) | 400 | 401 | 429
- `GET /me` (Bearer) → `{ account:{id,email,name} }` (200) | 401
- `POST /auth/logout` (Bearer) → `{ok:true}` (200)

All commands run from repo root. Desktop test: `pnpm --filter desktop test`. Typecheck: `pnpm --filter desktop typecheck`.

---

## File structure

- Create `apps/desktop/src/accountStore.ts` — encrypted token-at-rest via an injected `SafeStorageLike`. One responsibility: persist/retrieve/clear the bearer token, fail-closed when real OS encryption is unavailable.
- Create `apps/desktop/src/accountClient.ts` — `createAccountClient({ store, fetchFn, endpoint })` → `{ requestCode, verifyCode, me, signOut }`. One responsibility: the OTP HTTP flow + token lifecycle. Defines the shared `Account`/`MePayload` types.
- Modify `apps/desktop/src/main.ts` — construct the store+client with the real `safeStorage`/`fetch`/`SIGNUP_ENDPOINT`; add four `ipcMain.handle` channels; fire a launch refresh in `boot()`.
- Modify `apps/desktop/src/preload.ts` — expose `rigel.account = { requestCode, verifyCode, me, signOut }`.
- Modify `apps/web/src/lib/desktop.ts` — extend `RigelBridge` with the `account` API + re-export the payload types.

---

## Task 1: `accountStore.ts` — encrypted token at rest

**Files:**
- Create: `apps/desktop/src/accountStore.ts`
- Test: `apps/desktop/src/accountStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/accountStore.test.ts
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, type SafeStorageLike } from "./accountStore";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rigel-account-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// Fake safeStorage: "encrypts" by prefixing, so we can assert round-trips.
function fakeSafe(over: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptString: (s: string) => Buffer.from("enc:" + s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
    ...over,
  };
}

test("round-trips a token, persists across instances", () => {
  const a = new AccountStore(dir, fakeSafe());
  expect(a.available).toBe(true);
  a.setToken("tok-123");
  expect(a.getToken()).toBe("tok-123");
  expect(new AccountStore(dir, fakeSafe()).getToken()).toBe("tok-123"); // reloaded from disk
});

test("clear removes the token", () => {
  const a = new AccountStore(dir, fakeSafe());
  a.setToken("tok-123");
  a.clear();
  expect(a.getToken()).toBeNull();
  expect(new AccountStore(dir, fakeSafe()).getToken()).toBeNull();
});

test("getToken is null when nothing stored", () => {
  expect(new AccountStore(dir, fakeSafe()).getToken()).toBeNull();
});

test("fails closed when encryption unavailable", () => {
  const a = new AccountStore(dir, fakeSafe({ isEncryptionAvailable: () => false }));
  expect(a.available).toBe(false);
  expect(() => a.setToken("tok")).toThrow();
  expect(a.getToken()).toBeNull();
});

test("fails closed on the Linux basic_text backend (obfuscation, not encryption)", () => {
  const a = new AccountStore(dir, fakeSafe({ getSelectedStorageBackend: () => "basic_text" }));
  expect(a.available).toBe(false);
  expect(() => a.setToken("tok")).toThrow();
});

test("a corrupt/undecryptable file reads as null, not a crash", () => {
  const a = new AccountStore(dir, fakeSafe({ decryptString: () => { throw new Error("bad"); } }));
  a.constructor === AccountStore; // no-op
  // write a token with a working safe, then read with a throwing decrypt
  new AccountStore(dir, fakeSafe()).setToken("tok");
  expect(a.getToken()).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop test accountStore`
Expected: FAIL — `Cannot find module './accountStore'`.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/desktop/src/accountStore.ts
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The slice of Electron's safeStorage we depend on (injected so this module
 *  stays electron-free and unit-testable, like installStore/signup). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class AccountStore {
  private file: string;
  private safe: SafeStorageLike;
  readonly available: boolean;
  constructor(userDataDir: string, safe: SafeStorageLike) {
    this.file = join(userDataDir, "rigel-account.bin");
    this.safe = safe;
    // Fail closed: require real OS encryption. On Linux, isEncryptionAvailable()
    // returns true even for the hardcoded-key "basic_text" backend, which is
    // obfuscation, not encryption — treat that as unavailable.
    this.available =
      safe.isEncryptionAvailable() && safe.getSelectedStorageBackend?.() !== "basic_text";
  }
  getToken(): string | null {
    if (!this.available) return null;
    try {
      const b64 = readFileSync(this.file, "utf8");
      return this.safe.decryptString(Buffer.from(b64, "base64"));
    } catch {
      return null;
    }
  }
  setToken(token: string): void {
    if (!this.available) throw new Error("secure storage unavailable");
    const enc = this.safe.encryptString(token);
    writeFileSync(this.file, enc.toString("base64"), { mode: 0o600 });
  }
  clear(): void {
    try { rmSync(this.file, { force: true }); } catch { /* already gone */ }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop test accountStore`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/accountStore.ts apps/desktop/src/accountStore.test.ts
git commit -m "feat(desktop): safeStorage-encrypted account token store (fail-closed)"
```

---

## Task 2: `accountClient.ts` — OTP flow + token lifecycle

**Files:**
- Create: `apps/desktop/src/accountClient.ts`
- Test: `apps/desktop/src/accountClient.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/accountClient.test.ts
import { test, expect } from "vitest";
import { createAccountClient, type MePayload } from "./accountClient";

/** Minimal in-memory store matching the AccountStore surface the client uses. */
function memStore(initial: string | null = null) {
  let tok = initial;
  return {
    available: true,
    getToken: () => tok,
    setToken: (t: string) => { tok = t; },
    clear: () => { tok = null; },
    get value() { return tok; },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ENDPOINT = "https://api.test";

test("requestCode POSTs the email and returns the status", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return jsonResponse({ ok: true }); }) as typeof fetch;
  const client = createAccountClient({ store: memStore(), fetchFn, endpoint: ENDPOINT });
  const r = await client.requestCode("jane@acme.com");
  expect(r).toEqual({ ok: true, status: 200 });
  expect(calls[0].url).toBe(`${ENDPOINT}/auth/request`);
  expect(JSON.parse(calls[0].init!.body as string)).toEqual({ email: "jane@acme.com" });
});

test("requestCode surfaces a non-2xx status without throwing", async () => {
  const fetchFn = (async () => jsonResponse({ error: "rate limited" }, 429)) as typeof fetch;
  const client = createAccountClient({ store: memStore(), fetchFn, endpoint: ENDPOINT });
  expect(await client.requestCode("a@b.co")).toEqual({ ok: false, status: 429 });
});

test("verifyCode stores the token and returns the account on 200", async () => {
  const store = memStore();
  const fetchFn = (async () => jsonResponse({ token: "tok-xyz", account: { id: "1", email: "a@b.co", name: "Jane" } })) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  const r = await client.verifyCode("a@b.co", "123456");
  expect(r).toEqual({ ok: true, account: { id: "1", email: "a@b.co", name: "Jane" } });
  expect(store.value).toBe("tok-xyz");
});

test("verifyCode returns the status and stores no token on failure", async () => {
  const store = memStore();
  const fetchFn = (async () => jsonResponse({ error: "invalid code" }, 401)) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  expect(await client.verifyCode("a@b.co", "000000")).toEqual({ ok: false, status: 401 });
  expect(store.value).toBeNull();
});

test("me sends the bearer and returns the full payload", async () => {
  const calls: RequestInit[] = [];
  const fetchFn = (async (_u: string, init?: RequestInit) => { calls.push(init!); return jsonResponse({ account: { id: "1", email: "a@b.co", name: "Jane" } }); }) as typeof fetch;
  const client = createAccountClient({ store: memStore("tok-1"), fetchFn, endpoint: ENDPOINT });
  const me = (await client.me()) as MePayload;
  expect(me.account).toEqual({ id: "1", email: "a@b.co", name: "Jane" });
  expect((calls[0].headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
});

test("me returns null and clears the token on 401", async () => {
  const store = memStore("stale");
  const fetchFn = (async () => jsonResponse({ error: "unauthorized" }, 401)) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  expect(await client.me()).toBeNull();
  expect(store.value).toBeNull();
});

test("me returns null without calling fetch when there is no token", async () => {
  let called = false;
  const fetchFn = (async () => { called = true; return jsonResponse({}); }) as typeof fetch;
  const client = createAccountClient({ store: memStore(null), fetchFn, endpoint: ENDPOINT });
  expect(await client.me()).toBeNull();
  expect(called).toBe(false);
});

test("me returns null on a network error (keeps the token for retry)", async () => {
  const store = memStore("tok-1");
  const fetchFn = (async () => { throw new Error("offline"); }) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  expect(await client.me()).toBeNull();
  expect(store.value).toBe("tok-1"); // NOT cleared on a network failure
});

test("signOut revokes then clears the token, even if the request fails", async () => {
  const store = memStore("tok-1");
  const fetchFn = (async () => { throw new Error("offline"); }) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  await client.signOut();
  expect(store.value).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop test accountClient`
Expected: FAIL — `Cannot find module './accountClient'`.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/desktop/src/accountClient.ts
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
        return null; // network failure: keep the token, treat as offline
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop test accountClient`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/accountClient.ts apps/desktop/src/accountClient.test.ts
git commit -m "feat(desktop): account OTP client (request/verify/me/signOut + token lifecycle)"
```

---

## Task 3: preload bridge + renderer typing

**Files:**
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/web/src/lib/desktop.ts`

No unit test (thin IPC pass-through). Verified by typecheck.

- [ ] **Step 1: Edit `preload.ts`**

Add an `account` object to the `contextBridge.exposeInMainWorld("rigel", { ... })` literal (after `getSignupData`):

```typescript
  account: {
    requestCode: (email: string): Promise<{ ok: boolean; status: number }> =>
      ipcRenderer.invoke("rigel:account:request-code", email),
    verifyCode: (email: string, code: string): Promise<{ ok: true; account: { id: string; email: string; name: string | null } } | { ok: false; status: number }> =>
      ipcRenderer.invoke("rigel:account:verify-code", { email, code }),
    me: (): Promise<{ account: { id: string; email: string; name: string | null }; orgs?: unknown[]; invitations?: unknown[] } | null> =>
      ipcRenderer.invoke("rigel:account:me"),
    signOut: (): Promise<void> => ipcRenderer.invoke("rigel:account:sign-out"),
  },
```

- [ ] **Step 2: Edit `apps/web/src/lib/desktop.ts`**

Add the payload types and an `account` member to `RigelBridge`. Import the shared types from the desktop client's public types to avoid drift — but `apps/web` cannot import from `apps/desktop`, so re-declare the minimal shapes here (they mirror `accountClient.ts`):

```typescript
export interface Account { id: string; email: string; name: string | null }
export interface MePayload { account: Account; orgs?: unknown[]; invitations?: unknown[] }
export type VerifyResult = { ok: true; account: Account } | { ok: false; status: number };
```

Add to the `RigelBridge` interface:

```typescript
  account: {
    requestCode(email: string): Promise<{ ok: boolean; status: number }>;
    verifyCode(email: string, code: string): Promise<VerifyResult>;
    me(): Promise<MePayload | null>;
    signOut(): Promise<void>;
  };
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter desktop typecheck && pnpm --filter web typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/preload.ts apps/web/src/lib/desktop.ts
git commit -m "feat(desktop): expose rigel.account bridge + renderer types"
```

---

## Task 4: `main.ts` wiring — store, client, IPC, launch refresh

**Files:**
- Modify: `apps/desktop/src/main.ts`

Composition root — no unit test; verify by typecheck + build.

- [ ] **Step 1: Add imports** (near the `installStore`/`signup` imports):

```typescript
import { safeStorage } from "electron"; // add to the existing electron import if cleaner
import { AccountStore } from "./accountStore";
import { createAccountClient } from "./accountClient";
```

Note: `safeStorage` can be added to the existing `import { app, BrowserWindow, ... } from "electron";` destructure instead of a second import line — prefer that.

- [ ] **Step 2: Construct the store + client inside `boot()`**, right after `const installStore = new InstallStore(app.getPath("userData"));`:

```typescript
  const accountStore = new AccountStore(app.getPath("userData"), safeStorage);
  const accountClient = createAccountClient({ store: accountStore, fetchFn: fetch, endpoint: SIGNUP_ENDPOINT });
  // Launch refresh: validate/clear a stale token in the background (me() clears on 401).
  void accountClient.me();
```

- [ ] **Step 3: Add the four IPC handlers**, next to the existing `rigel:submit-signup` / `rigel:get-signup-data` handlers:

```typescript
  ipcMain.handle("rigel:account:request-code", (_e, email: string) => accountClient.requestCode(email));
  ipcMain.handle("rigel:account:verify-code", (_e, d: { email: string; code: string }) => accountClient.verifyCode(d.email, d.code));
  ipcMain.handle("rigel:account:me", () => accountClient.me());
  ipcMain.handle("rigel:account:sign-out", () => accountClient.signOut());
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter desktop typecheck`
Expected: no errors.
Run: `pnpm --filter desktop test`
Expected: all Phase-2 unit tests green (accountStore + accountClient), no regressions.

(Do NOT run `pnpm --filter desktop build` unless quick — it builds the web app too. Typecheck is the gate here; the full build runs in CI.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "feat(desktop): wire AccountStore + account IPC handlers + launch refresh"
```

---

## Phase 2 verification (before Phase 3)

- [ ] `pnpm --filter desktop typecheck` — clean.
- [ ] `pnpm --filter web typecheck` — clean (the `RigelBridge` change).
- [ ] `pnpm --filter desktop test` — accountStore + accountClient suites green.
- [ ] Live smoke deferred to Phase 4 (needs the backend `/auth/*` deployed). The `account` bridge is now callable from the renderer; Phase 4 builds the panel UI on it.

## Self-review notes (author)

- **Spec coverage:** covers HELM-15 spec Component 2 (accountStore via safeStorage with the basic_text fail-closed guard; the `account` contextBridge API; launch refresh keeping the token on network failure and clearing on 401). The `me()` full-payload return is the org forward-compat item. Session-secret + token-to-server plumbing deliberately deferred to their consuming phases (documented above).
- **Type consistency:** `Account { id, email, name: string|null }` and the `{ token, account }` verify shape match the Phase-1 backend and the `/me` + `/auth/verify` responses (which now include `id`). `createAccountClient`/`AccountStore` mirror the `createResendSender`/`InstallStore` factory+class conventions.
- **No placeholders:** every step has real code, commands, and expected output.
