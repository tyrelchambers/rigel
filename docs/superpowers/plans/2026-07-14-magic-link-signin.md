# Magic-link sign-in — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** The sign-in email carries a "Sign in to Rigel" button that opens the desktop app via a `rigel://` deep link and signs the user in with zero typing — alongside the existing 6-digit code (either works). Builds on the passwordless OTP accounts system (HELM-15) and the branded email.

**Architecture:** On `/auth/request` the backend mints a high-entropy single-use **link token** in the SAME `login_codes` row as the code (so consuming either invalidates the other), and emails a `rigel://auth?token=<token>` button. The desktop registers the `rigel://` protocol; when the OS hands it the URL, Electron main verifies the token against a new `POST /auth/verify-link`, stores the bearer token, opens the server gate, focuses the window, and tells the renderer to re-check — flipping it from LoginGate to the app.

**Security:** the link token is 32 random bytes (base64url, 256-bit), SHA-256-hashed at rest, single-use, 10-minute TTL, shared row with the code (using one consumes both). The 6-digit code is NOT put in the URL (too low-entropy). The `rigel://` URL is handled OS→app (no browser referrer leak); single-use + short TTL bound the exposure if the launch args are logged.

**Tech Stack:** Hono + node-postgres, Electron (`setAsDefaultProtocolClient`, `open-url` / `second-instance`, single-instance lock), Resend, Vitest.

**Branch:** `feature/otp-email-design` (extends the branded-email work; PR #42 scope widens to "sign-in email + magic link").

**Deployed backend note:** `login_codes` already exists in prod, so the new column ships via an idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `ensureAuthSchema`.

---

## File structure
- `apps/signups/src/authDb.ts` — add `link_token_hash` to the `login_codes` schema (+ idempotent ALTER + index), extend `insertCode`, add `consumeLinkToken`.
- `apps/signups/src/auth.ts` — `/auth/request` mints the link token + passes the URL to `sendCode`; new `POST /auth/verify-link`.
- `apps/signups/src/resend.ts` — `sendCode(email, code, magicUrl)` + a "Sign in to Rigel" button in the HTML.
- `apps/desktop/src/accountClient.ts` — `verifyLink(token)`.
- `apps/desktop/src/main.ts` — register `rigel://`, single-instance, handle the deep link → verifyLink → pushServerAuth → notify renderer → focus.
- `apps/desktop/src/preload.ts` + `apps/web/src/lib/desktop.ts` — expose `account.onChanged(cb)`.
- `apps/web/src/shell/useAccount.ts` — subscribe to `onChanged` → refresh.

---

## Task 1: backend — link token in `authDb`

**Files:** `apps/signups/src/authDb.ts`, `apps/signups/src/authDb.test.ts`.

- [ ] **Step 1 (test, append):** assert `ensureAuthSchema` issues the ALTER, and `consumeLinkToken` sends the right guarded UPDATE:

```typescript
test("ensureAuthSchema adds link_token_hash to login_codes (idempotent ALTER)", async () => {
  const { pool, calls } = recorder();
  await ensureAuthSchema(pool);
  const joined = calls.map((c) => c.sql.toUpperCase()).join("\n");
  expect(joined).toContain("ALTER TABLE LOGIN_CODES ADD COLUMN IF NOT EXISTS LINK_TOKEN_HASH");
});

test("consumeLinkToken consumes by link_token_hash and returns the email", async () => {
  const { pool, calls, push } = recorder();
  push({ email: "a@b.co" });
  const db = createAuthDb(pool);
  const got = await db.consumeLinkToken("HASH");
  expect(got).toEqual({ email: "a@b.co" });
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("UPDATE LOGIN_CODES SET CONSUMED_AT = NOW()");
  expect(sql).toContain("LINK_TOKEN_HASH = $1");
  expect(sql).toContain("CONSUMED_AT IS NULL");
  expect(sql).toContain("EXPIRES_AT > NOW()");
  expect(sql).toContain("RETURNING EMAIL");
  expect(calls[0].params).toEqual(["HASH"]);
});
```
Also update the existing `insertCode` expectations if they assert the column list (it now inserts `link_token_hash`).

- [ ] **Step 2:** `pnpm --filter @rigel/server ... ` — no; `pnpm --filter signups test authDb` → FAIL.

- [ ] **Step 3:** In `authDb.ts`:
  - Append to `AUTH_SCHEMA` (after the `login_codes` CREATE + its index):
    ```sql
    ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS link_token_hash text;
    CREATE INDEX IF NOT EXISTS login_codes_link_idx ON login_codes (link_token_hash);
    ```
    (Multiple statements in one `pool.query` string are fine — same as the rest of `AUTH_SCHEMA`.)
  - Change `insertCode` to also store the link hash:
    ```typescript
    insertCode(email: string, codeHash: string, linkTokenHash: string, ttlSeconds: number): Promise<void>;
    ```
    ```typescript
    async insertCode(email, codeHash, linkTokenHash, ttlSeconds) {
      await pool.query(
        `INSERT INTO login_codes (email, code_hash, link_token_hash, expires_at)
         VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
        [email, codeHash, linkTokenHash, String(ttlSeconds)],
      );
    },
    ```
  - Add to the `AuthDb` interface + impl:
    ```typescript
    consumeLinkToken(linkTokenHash: string): Promise<{ email: string } | null>;
    ```
    ```typescript
    async consumeLinkToken(linkTokenHash) {
      const r = await pool.query(
        `UPDATE login_codes SET consumed_at = now()
         WHERE ctid = (
           SELECT ctid FROM login_codes
           WHERE link_token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
           ORDER BY created_at DESC LIMIT 1
         )
         RETURNING email`,
        [linkTokenHash],
      );
      const row = r.rows[0] as { email: string } | undefined;
      return row ? { email: row.email } : null;
    },
    ```

- [ ] **Step 4:** `pnpm --filter signups test authDb` → PASS; `typecheck`.
- [ ] **Step 5:** Commit `feat(signups): store a single-use magic-link token alongside the OTP`.

---

## Task 2: backend — mint link + `/auth/verify-link`

**Files:** `apps/signups/src/auth.ts`, `apps/signups/src/auth.test.ts`.

Context: `sendCode` becomes `(email, code, magicUrl)` (Task 3). The magic URL scheme is `rigel://auth?token=<token>`.

- [ ] **Step 1 (tests, append to `auth.test.ts`):** the fake `AuthDb` in the test needs `consumeLinkToken`; the fake `sendCode` now receives `(email, code, magicUrl)`. Add:
```typescript
test("request sends a code AND a magic link", async () => {
  const { app, sent } = make();               // capture sent {email, code, magicUrl}
  await json(app, "/auth/request", { email: "a@b.co" });
  expect(sent[0].magicUrl).toMatch(/^rigel:\/\/auth\?token=[A-Za-z0-9_-]+$/);
});

test("verify-link with a valid token → token + account", async () => {
  // fakeDb.consumeLinkToken returns {email} for the stored token; wire it in fakeDb.
  const { app } = make();
  const linkToken = /* the token captured from sent[0].magicUrl */;
  const res = await json(app, "/auth/verify-link", { token: linkToken });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.token.length).toBeGreaterThan(20);
  expect(body.account.email).toBe("a@b.co");
});

test("verify-link with an unknown/expired token → 401", async () => {
  const { app } = make();
  expect((await json(app, "/auth/verify-link", { token: "nope" })).status).toBe(401);
});
```
(Update the in-memory `fakeDb` from `auth.test.ts` to store the link hash on `insertCode` and honor `consumeLinkToken`.)

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3:** In `auth.ts`:
  - `AuthDeps.sendCode` type → `(email: string, code: string, magicUrl: string) => Promise<void>`.
  - In `/auth/request`, after generating the code, mint the link token and store both:
    ```typescript
    const linkToken = randomBytes(32).toString("base64url");
    await db.invalidateCodes(email);
    await db.insertCode(email, sha(code), sha(linkToken), CODE_TTL_SECONDS);
    db.cleanupExpiredCodes().catch(() => {});
    const magicUrl = `rigel://auth?token=${linkToken}`;
    try { await sendCode(email, code, magicUrl); } catch (e) { /* 502 as before */ }
    ```
  - New route:
    ```typescript
    app.post("/auth/verify-link", async (c) => {
      let body: unknown;
      try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
      const token = typeof (body as { token?: unknown })?.token === "string" ? (body as { token: string }).token : "";
      if (!token) return c.json({ error: "invalid" }, 400);
      if (!allowVerify(`auth:vrf:ip:${clientIp(c)}`)) return c.json({ error: "rate limited" }, 429);
      const claimed = await db.consumeLinkToken(sha(token));
      if (!claimed) return c.json({ error: "invalid or expired link" }, 401);
      const account = await db.upsertAccount(claimed.email);
      const bearer = randomBytes(32).toString("base64url");
      await db.insertToken(sha(bearer), account.id);
      return c.json({ token: bearer, account: { id: account.id, email: account.email, name: account.name } });
    });
    ```
    (Reuse the existing `sha`, `clientIp`, `allowVerify`.)

- [ ] **Step 4:** run auth tests → PASS; typecheck.
- [ ] **Step 5:** Commit `feat(signups): /auth/verify-link magic-link sign-in route`.

---

## Task 3: email — sign-in button

**Files:** `apps/signups/src/resend.ts`, `apps/signups/src/resend.test.ts`, `apps/signups/src/index.ts` (wiring).

- [ ] **Step 1 (test):** `sendCode(email, code, magicUrl)`; assert `payload.html` contains the `magicUrl` in an `href` and the code; `text` contains both the code and the URL.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:**
  - `renderCodeEmailHtml(code: string, magicUrl: string)` — add a primary button ABOVE the code chip:
    ```html
    <table role="presentation" width="100%" ...><tr><td align="center" style="padding:0 0 20px;">
      <a href="${magicUrl}" style="display:inline-block;background:#38bdf8;color:#04232e;font-family:...;font-size:14px;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:8px;">Sign in to Rigel</a>
    </td></tr></table>
    ```
    Keep the code chip below it, prefaced with "Or enter this code:". (Email clients don't run JS; a plain `<a href="rigel://…">` is fine — clicking hands the URL to the OS.)
  - `sendCode` signature → `(email, code, magicUrl)`; add `magicUrl` to the `text` too: `... Or open this link to sign in: ${magicUrl}`.
  - `index.ts`: no change to how `sendCode` is constructed (it's `createResendSender(...)`), but the CALLER is `auth.ts` which now passes `magicUrl` (Task 2). Confirm `index.ts` still wires `sendCode` into `createApp({ auth: { sendCode, ... }})` unchanged.
- [ ] **Step 4:** run → PASS; full signups suite green; typecheck.
- [ ] **Step 5:** Commit `feat(signups): magic-link button in the sign-in email`.

---

## Task 4: desktop — `accountClient.verifyLink`

**Files:** `apps/desktop/src/accountClient.ts`, `apps/desktop/src/accountClient.test.ts`.

- [ ] Add to the returned client:
```typescript
async verifyLink(token: string): Promise<VerifyResult> {
  const res = await postJson("/auth/verify-link", { token });
  if (!res.ok) return { ok: false, status: res.status };
  const body = (await res.json()) as { token: string; account: Account };
  store.setToken(body.token);
  return { ok: true, account: body.account };
},
```
Test (mirror the `verifyCode` tests): 200 stores token + returns account; non-ok returns `{ok:false,status}` and stores nothing. Commit `feat(desktop): accountClient.verifyLink`.

---

## Task 5: desktop — `rigel://` protocol + deep-link handler

**Files:** `apps/desktop/src/main.ts`.

- [ ] **Register + single-instance** (near app startup, before/around `app.whenReady`):
```typescript
app.setAsDefaultProtocolClient("rigel");
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
```
(Guard: if the app already ran `whenReady().then(boot)`, keep that; just add the lock + protocol registration. On `!gotLock`, quit early.)

- [ ] **Handle the URL** — add a module-level `handleAuthUrl(url)` and wire the OS entry points. `accountClient` lives in `boot()`, so expose it (or a `signInWithLink`) to module scope via a module-level `let signInWithLink: ((token: string) => Promise<void>) | null = null;` set inside `boot()`:
```typescript
let signInWithLink: ((token: string) => Promise<void>) | null = null;
function parseAuthToken(url: string): string | null {
  try { const u = new URL(url); if (u.protocol !== "rigel:" || u.hostname !== "auth") return null; return u.searchParams.get("token"); }
  catch { return null; }
}
async function handleAuthUrl(url: string): Promise<void> {
  const token = parseAuthToken(url);
  if (!token || !signInWithLink) return;
  await signInWithLink(token);
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
}
```
Note `new URL("rigel://auth?token=x")` → protocol `rigel:`, hostname `auth`. Confirm parsing.

Inside `boot()`, after `accountClient` is created, set:
```typescript
  signInWithLink = async (token: string) => {
    const r = await accountClient.verifyLink(token);
    if (r.ok) { pushServerAuth(true); mainWindow?.webContents.send("rigel:account:changed"); }
  };
```

- [ ] **OS entry points:**
  - macOS: `app.on("open-url", (e, url) => { e.preventDefault(); void handleAuthUrl(url); });` (register this early, even before `whenReady`, and also process any URL that arrives before the window exists — if `mainWindow` is null, still `signInWithLink` runs; the renderer picks up state on mount via `status()`).
  - Windows/Linux: the URL comes as an argv on a second launch:
    ```typescript
    app.on("second-instance", (_e, argv) => {
      const url = argv.find((a) => a.startsWith("rigel://"));
      if (url) void handleAuthUrl(url);
    });
    ```
    And on first launch, check `process.argv` for a `rigel://` arg after boot.

- [ ] Verify `pnpm --filter desktop typecheck` + `test`. Commit `feat(desktop): handle rigel:// magic-link sign-in`.

---

## Task 6: desktop — `account.onChanged` bridge

**Files:** `apps/desktop/src/preload.ts`, `apps/web/src/lib/desktop.ts`.

- [ ] preload — add to the `account` object:
```typescript
  onChanged: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on("rigel:account:changed", listener);
    return () => ipcRenderer.removeListener("rigel:account:changed", listener);
  },
```
- [ ] `desktop.ts` — add to `RigelBridge['account']`: `onChanged(cb: () => void): () => void;`
- [ ] typecheck (desktop + web). Commit `feat(desktop): rigel.account.onChanged bridge`.

---

## Task 7: renderer — react to magic-link sign-in

**Files:** `apps/web/src/shell/useAccount.ts`, `apps/web/src/shell/useAccount.test.tsx`.

- [ ] In `useAccount`, subscribe to `onChanged` and refresh:
```typescript
  useEffect(() => {
    if (!rigel) return;
    return rigel.account.onChanged(() => { void refresh(); });
  }, [refresh]);
```
- [ ] Test: mock `rigel.account.onChanged` to capture the callback; assert that invoking it re-calls `status()` and flips signed-out → signed-in. Commit `feat(web): re-check account when main signs in (magic link)`.

---

## Verification
- All packages typecheck; signups + desktop + web suites green.
- **Live smoke (desktop):** request a code → the email has a "Sign in to Rigel" button → clicking it focuses the app and signs in without typing; the 6-digit code still works; using one invalidates the other.

## Self-review notes (author)
- Code + link share the `login_codes` row → consuming either invalidates the other (single sign-in intent). Link token is 256-bit, hashed, single-use, 10-min TTL, not in the subject or the code path.
- Magic link opens OS→app (no browser); the renderer flips via the `onChanged` push + `status()` (which also re-authorizes the server gate through main). Race-free: `signInWithLink` runs even if the URL arrives before the window; the renderer reconciles on mount.
