# Mandatory server-enforced login gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** When signed-out, the desktop app shows ONLY a full-screen login form; the app is inaccessible until sign-in. The gate is genuinely enforced: the local app server refuses `/api/*` + `/ws` until Electron main confirms sign-in, so hiding the client overlay via devtools yields a dead app.

**Architecture:** Two layers. (1) **Client** — `App.tsx` renders `<LoginGate>` instead of the app when signed-out (the app tree isn't mounted). (2) **Server guard** — the existing session-secret gate on `/api/*` + `/ws` also requires an account `signedIn` flag that main delivers (env at fork + `postMessage` at runtime). The account token never leaves main; only a boolean crosses.

**Threat framing:** desktop app, user owns the machine — bypass can't be made *impossible* (they could run kubectl directly), but the server refusing data makes the naive overlay-delete useless. The account gate is INERT when no session secret is configured (web-dev/Docker), exactly like the session gate.

**Sub-decisions (accepted):** the full-screen login **replaces** the first-run name+email `AccountGate` (email-only login; account name optional/backfilled). **Offline** with a stored token stays signed-in (only a 401 clears it).

**Tech Stack:** Electron (`utilityProcess.postMessage` / `process.parentPort`, env, ipc), Node `ws` + `@hono/node-server`, React 19, Vitest.

**Builds on:** HELM-15 Phases 1-4 (accounts backend, `rigel.account` bridge, session-secret gate). Integration points confirmed: server gate at `apps/server/src/index.ts:148` (`/api/*`) + `:1268` (`/ws`); `forkServer` env at `main.ts:~211`; `accountStore`/`accountClient` + ipc in `main.ts` boot(); `useAccount`/`AccountModal` in `apps/web/src/shell`; `App.tsx` account gating at `:105,242-258`.

Commands from repo root.

---

## File structure
- Modify `apps/server/src/sessionAuth.ts` — add pure `accessAllowed(provided, expected, signedIn)` combining the session + account checks.
- Modify `apps/server/src/index.ts` — read `RIGEL_SIGNED_IN`; `process.parentPort` message handler to update it; use `accessAllowed` in the `/api/*` + `/ws` gates.
- Modify `apps/desktop/src/main.ts` — module-level `accountSignedIn`; set `env.RIGEL_SIGNED_IN` in `forkServer`; `pushServerAuth()`; `rigel:account:status` ipc; push on login/logout.
- Modify `apps/desktop/src/preload.ts` + `apps/web/src/lib/desktop.ts` — expose/type `rigel.account.status()`.
- Modify `apps/web/src/shell/useAccount.ts` — drive status from `account.status()` (optimistic offline).
- Create `apps/web/src/shell/SignInFlow.tsx` — the email→code flow extracted from `AccountModal`.
- Modify `apps/web/src/shell/AccountModal.tsx` — use `<SignInFlow>` for its signed-out state.
- Create `apps/web/src/shell/LoginGate.tsx` — full-screen gate wrapping `<SignInFlow>`.
- Modify `apps/web/src/App.tsx` — render `<LoginGate>` when signed-out; remove the old `accountMissing`/`AccountGate` gate.

---

## Task 1: `accessAllowed` (server, pure)

**Files:** Modify `apps/server/src/sessionAuth.ts`; Modify `apps/server/src/sessionAuth.test.ts`.

- [ ] **Step 1: Add the failing test** (append to the existing describe or a new one):

```typescript
import { checkSessionSecret, accessAllowed } from "./sessionAuth";

describe("accessAllowed", () => {
  it("is fully open when no secret is configured (web-dev/Docker)", () => {
    expect(accessAllowed(null, "", false)).toBe(true);
    expect(accessAllowed("whatever", "", false)).toBe(true);
  });
  it("requires the session secret AND signed-in when configured", () => {
    expect(accessAllowed("sekret", "sekret", true)).toBe(true);   // valid + signed-in
    expect(accessAllowed("sekret", "sekret", false)).toBe(false); // valid secret but signed-out → denied
    expect(accessAllowed("wrong", "sekret", true)).toBe(false);   // bad secret
    expect(accessAllowed(null, "sekret", true)).toBe(false);      // missing secret
  });
});
```

- [ ] **Step 2:** `pnpm --filter @rigel/server test sessionAuth` → FAIL (accessAllowed missing).

- [ ] **Step 3: Add to `sessionAuth.ts`:**

```typescript
/** Full gate: valid session secret AND (when the gate is active) signed-in.
 *  The account requirement only applies when a secret is configured (desktop);
 *  in web-dev/Docker (`expected` empty) everything is allowed. */
export function accessAllowed(provided: string | null | undefined, expected: string, signedIn: boolean): boolean {
  if (!checkSessionSecret(provided, expected)) return false;
  if (expected && !signedIn) return false;
  return true;
}
```

- [ ] **Step 4:** `pnpm --filter @rigel/server test sessionAuth` → PASS. Typecheck clean.
- [ ] **Step 5: Commit** `feat(server): accessAllowed = session secret + signed-in gate`.

---

## Task 2: enforce the account gate in the server

**Files:** Modify `apps/server/src/index.ts`.

- [ ] **Step 1:** Change the import to include `accessAllowed`:
```typescript
import { accessAllowed } from "./sessionAuth";
```
(Drop the now-unused `checkSessionSecret` import if nothing else uses it — check.)

- [ ] **Step 2:** Add the runtime auth state near `SESSION_SECRET` (:74):
```typescript
let accountSignedIn = process.env.RIGEL_SIGNED_IN === "1";
process.parentPort?.on("message", (e: { data?: unknown }) => {
  const m = e?.data as { type?: string; signedIn?: boolean } | undefined;
  if (m?.type === "account-auth") accountSignedIn = !!m.signedIn;
});
```
(`process.parentPort` exists in the Electron utilityProcess child; `?.` guards non-Electron test/Docker runs where it stays env-derived / inert.)

- [ ] **Step 3:** Replace the `/api/*` gate (currently `checkSessionSecret(req.headers.get("x-rigel-session"), SESSION_SECRET)`) with:
```typescript
    if (url.pathname.startsWith("/api/") && !accessAllowed(req.headers.get("x-rigel-session"), SESSION_SECRET, accountSignedIn)) {
      return new Response("unauthorized", { status: 401 });
    }
```

- [ ] **Step 4:** Replace the `/ws` upgrade gate similarly:
```typescript
    if (!accessAllowed(url.searchParams.get("s"), SESSION_SECRET, accountSignedIn)) {
      socket.destroy();
      return;
    }
```

- [ ] **Step 5: Verify** `pnpm --filter @rigel/server typecheck` clean; `pnpm --filter @rigel/server test` green (gate inert with no env); `build` succeeds.
- [ ] **Step 6: Commit** `feat(server): require signed-in for /api/* + /ws (account gate)`.

---

## Task 3: deliver signed-in state from main

**Files:** Modify `apps/desktop/src/main.ts`.

- [ ] **Step 1:** Add a module-level `let accountSignedIn = false;` near `let serverProc`.
- [ ] **Step 2:** In `forkServer`, add to `env`:
```typescript
  env.RIGEL_SIGNED_IN = accountSignedIn ? "1" : "0";
```
- [ ] **Step 3:** Add a module-level helper:
```typescript
function pushServerAuth(signedIn: boolean): void {
  accountSignedIn = signedIn;
  serverProc?.postMessage({ type: "account-auth", signedIn });
}
```
- [ ] **Step 4:** In `boot()`, right after `accountStore`/`accountClient` are constructed and BEFORE `forkServer` is called for `serverProc`, set the initial flag:
```typescript
  accountSignedIn = accountStore.getToken() != null;
```
(Confirm order: `accountStore` must be constructed before the `serverProc = forkServer(...)` call. If `forkServer` is called earlier in boot than `accountStore`, move the `accountStore` construction up so the fork env is correct.)
- [ ] **Step 5:** Replace the Phase-2 launch line `void accountClient.me();` with a status refresh that also authorizes the server:
```typescript
  void refreshAccount();
```
and add the function (module-level or in boot scope):
```typescript
async function refreshAccount(): Promise<{ signedIn: boolean; account: Awaited<ReturnType<typeof accountClient.me>> extends infer T ? (T extends { account: infer A } ? A : null) : null }> {
  const payload = await accountClient.me();          // clears on 401, keeps token on network-fail
  const signedIn = accountStore.getToken() != null;
  pushServerAuth(signedIn);
  return { signedIn, account: payload?.account ?? null };
}
```
(If the generic return type is awkward, type it explicitly as `{ signedIn: boolean; account: { id: string; email: string; name: string | null } | null }`.)
Note: `accountClient`/`accountStore` are created in `boot()`; make `refreshAccount` a closure inside `boot()` (or lift `accountStore`/`accountClient` to module scope). Keep it consistent with how the ipc handlers already reference them.

- [ ] **Step 6:** Add the status ipc + push on login/logout. Update the existing account ipc handlers:
```typescript
  ipcMain.handle("rigel:account:status", () => refreshAccount());
  ipcMain.handle("rigel:account:verify-code", async (_e, d: { email: string; code: string }) => {
    const r = await accountClient.verifyCode(d.email, d.code);
    if (r.ok) pushServerAuth(true);
    return r;
  });
  ipcMain.handle("rigel:account:sign-out", async () => {
    await accountClient.signOut();
    pushServerAuth(false);
  });
```
(Keep `rigel:account:request-code` and `rigel:account:me` as they are.)

- [ ] **Step 7: Verify** `pnpm --filter desktop typecheck` clean; `pnpm --filter desktop test` green.
- [ ] **Step 8: Commit** `feat(desktop): deliver signed-in state to the server + account status ipc`.

---

## Task 4: expose `account.status()` to the renderer

**Files:** Modify `apps/desktop/src/preload.ts`, `apps/web/src/lib/desktop.ts`.

- [ ] **Step 1:** In `preload.ts`, add to the `account` bridge object:
```typescript
    status: (): Promise<{ signedIn: boolean; account: { id: string; email: string; name: string | null } | null }> =>
      ipcRenderer.invoke("rigel:account:status"),
```
- [ ] **Step 2:** In `desktop.ts`, add to the `RigelBridge['account']` type:
```typescript
    status(): Promise<{ signedIn: boolean; account: Account | null }>;
```
- [ ] **Step 3:** `pnpm --filter desktop typecheck` + `pnpm --filter web typecheck` → clean.
- [ ] **Step 4: Commit** `feat(desktop): expose rigel.account.status()`.

---

## Task 5: `useAccount` drives status from `account.status()`

**Files:** Modify `apps/web/src/shell/useAccount.ts`, `apps/web/src/shell/useAccount.test.tsx`.

- [ ] **Step 1: Update the tests** — `refresh`/mount now call `rigel.account.status()` (returns `{ signedIn, account }`) instead of `me()`. Signed-in when `signedIn` true (even if `account` is null → offline). Keep `verifyCode`→refresh→signed-in and `signOut`→signed-out. Update the mock to provide `status`.

- [ ] **Step 2: Implement** — change `refresh` to:
```typescript
  const refresh = useCallback(async () => {
    if (!rigel) { setStatus("signed-out"); return; }
    const s = await rigel.account.status();
    setMe(s.account ? { account: s.account } : null);
    setStatus(s.signedIn ? "signed-in" : "signed-out");
  }, []);
```
Keep `requestCode`/`verifyCode`/`signOut` (verifyCode still `await refresh()` on ok; signOut sets signed-out + calls the bridge). `account` derives from `me?.account ?? null`.

- [ ] **Step 3:** `pnpm --filter web test useAccount` → green; typecheck clean.
- [ ] **Step 4: Commit** `feat(web): useAccount reads account.status() (optimistic offline)`.

---

## Task 6: extract `SignInFlow`, add `LoginGate`, wire `App.tsx`

**Files:** Create `apps/web/src/shell/SignInFlow.tsx`; Create `apps/web/src/shell/LoginGate.tsx`; Modify `apps/web/src/shell/AccountModal.tsx`; Modify `apps/web/src/App.tsx`; update/move tests.

- [ ] **Step 1: Extract `SignInFlow`** from `AccountModal`'s signed-out `email`/`code` steps into `apps/web/src/shell/SignInFlow.tsx`. Props: `{ account: UseAccountResult; onSignedIn?: () => void }`. It owns the local `step`/`email`/`code`/`error`/`busy` state and renders the brand + email step + code step exactly as the current `AccountModal` signed-out UI (same tokens, same `aria-label="Verification code"`, placeholder `jane@acme.com`, forms/enter-to-submit, resend guard). Keep the design (Pencil frame `uTr7u`).

- [ ] **Step 2: `AccountModal`** — replace its inline signed-out email/code markup with `<SignInFlow account={account} />`. The signed-in panel + loading placeholder stay in `AccountModal`. Update `AccountModal.test.tsx` if the DOM moved (the same anchors — "Sign in to Rigel", placeholder, "Send code", "Verify & sign in", "Check your email" — must still resolve, now rendered by `SignInFlow`). Move the email/code-step tests to a new `SignInFlow.test.tsx` if cleaner; keep the signed-in tests in `AccountModal.test.tsx`.

- [ ] **Step 3: `LoginGate`** — full-screen: a `--surface-sunken` page filling the viewport, centered, containing the account card shell (`#101012`-equivalent via existing tokens) wrapping `<SignInFlow account={account} />`. Mirror the existing `AccountGate.tsx` full-screen shell layout but with `SignInFlow` inside. Component test: renders the email step ("Sign in to Rigel").

- [ ] **Step 4: `App.tsx`** — add `const account = useAccount();` (already added in Phase 4). At the top-level render, BEFORE the app:
```tsx
  if (account.status === "loading") {
    return <div style={{ height: "100vh", background: "var(--surface-sunken)" }} />;
  }
  if (account.status === "signed-out") {
    return <LoginGate account={account} />;
  }
```
Remove the old `accountMissing` state, its `getSignupData` effect, the `AccountGate` import + its render branch (`:242-247`), and the `AccountGate` gating. The `<AccountModal open={accountOpen} .../>` stays (header-opened; now only reachable when signed-in). Leave the onboarding wizard etc. untouched.

- [ ] **Step 5: Verify** `pnpm --filter web typecheck` clean; `pnpm --filter web test` green (update any test that rendered `<App>` expecting the old gate, and the `AccountGate.test.tsx` — delete it if `AccountGate` is removed, or keep `AccountGate` unused? Prefer deleting `AccountGate.tsx` + its test since it's superseded; confirm nothing else imports it).
- [ ] **Step 6: Commit** `feat(web): full-screen LoginGate; app gated on sign-in`.

---

## Verification (whole feature)
- [ ] All packages typecheck; `@rigel/server` + `web` + `desktop` suites green.
- [ ] **Live smoke (desktop, when backend deployed):** launch signed-out → only the login form; open devtools, delete the gate DOM → app does NOT appear and any manual `fetch('/api/contexts')` returns 401, `/ws` closes. Sign in → app loads, WS connects, `/api` works. Sign out → back to the login form and the server starts refusing again. `/api/health` stays 200 throughout.

## Self-review notes (author)
- The account gate reuses the session-gate's inert-when-unconfigured rule (via `expected` empty), so web-dev/tests are unaffected.
- Initial signed-in state rides the fork env (race-free at boot); runtime changes ride `postMessage`; a brief login→WS race self-heals via the WS client's existing reconnect backoff.
- `SignInFlow` is the single source for the email→code UI (gate + modal), no duplication.
