# Accounts + Auth (HELM-15) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Rigel a real user account with a passwordless-OTP-issued bearer credential the desktop holds and presents to `api.rigel.run`, plus per-launch access control on the local app server and a real account panel — unblocking HELM-16 monetization.

**Architecture:** Four independently-testable units. (1) Accounts backend extends `apps/signups` (Hono + `node-postgres`) with OTP + opaque-token routes. (2) Electron main owns the credential (`safeStorage`, `postMessage` to the forked server). (3) A session-secret middleware gates the local `apps/server`. (4) The web account panel drives the login flow. Spec: `docs/superpowers/specs/2026-07-13-accounts-auth-design.md`.

**Tech Stack:** TypeScript, Hono, `node-postgres` (`pg`), Vitest, Resend (transactional email), Electron (`utilityProcess`, `safeStorage`, `contextBridge`), React 19 + Vitest/RTL.

**Phasing:** This document fully details **Phase 1 (accounts backend)** — self-contained and testable with zero desktop changes. Phases 2–4 are scoped at the end; each gets its own detailed plan authored just-in-time (their code depends on Phase 1's realized route/token shapes, so pinning task-level code now would drift). Build order is strict: 1 → 2 → 3 → 4.

---

## Phase 1 — Accounts backend (`apps/signups`)

### File structure

- Create `apps/signups/src/authValidate.ts` — email canonicalization + request/verify body parsing. One responsibility: input hygiene.
- Create `apps/signups/src/authDb.ts` — the `AuthDb` interface + `createAuthDb(pool)` real SQL implementation + the auth `AUTH_SCHEMA` string and `ensureAuthSchema(pool)`.
- Create `apps/signups/src/auth.ts` — `registerAuthRoutes(app, deps)`: the four pure route handlers. Depends only on injected `AuthDb`, `sendCode`, two limiters, and `now`.
- Create `apps/signups/src/resend.ts` — `createResendSender({ apiKey, from })` → a `sendCode(email, code)` function (the only Resend touch point).
- Modify `apps/signups/src/app.ts` — `createApp` accepts optional auth deps and calls `registerAuthRoutes`.
- Modify `apps/signups/src/index.ts` — construct `pool`, `authDb`, the two limiters, the Resend sender; run `ensureAuthSchema`; pass auth deps to `createApp`.
- Tests: `authValidate.test.ts`, `auth.test.ts`, `authDb.test.ts`, `resend.test.ts`.

All commands run from the repo root. The service's test command is `pnpm --filter signups test` (Vitest). Typecheck: `pnpm --filter signups typecheck`.

---

### Task 1: Email canonicalization + body parsing (`authValidate.ts`)

**Files:**
- Create: `apps/signups/src/authValidate.ts`
- Test: `apps/signups/src/authValidate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/signups/src/authValidate.test.ts
import { test, expect } from "vitest";
import { normalizeEmail, parseRequestBody, parseVerifyBody } from "./authValidate";

test("normalizeEmail lowercases and trims", () => {
  expect(normalizeEmail("  Foo@X.COM ")).toBe("foo@x.com");
});

test("parseRequestBody accepts a valid email, canonicalized", () => {
  expect(parseRequestBody({ email: "Jane@Acme.com" })).toEqual({ ok: true, email: "jane@acme.com" });
});

test("parseRequestBody rejects a bad email", () => {
  expect(parseRequestBody({ email: "nope" }).ok).toBe(false);
  expect(parseRequestBody({}).ok).toBe(false);
  expect(parseRequestBody(null).ok).toBe(false);
});

test("parseVerifyBody requires a 6-digit code and an email", () => {
  expect(parseVerifyBody({ email: "a@b.co", code: "123456" })).toEqual({ ok: true, email: "a@b.co", code: "123456" });
  expect(parseVerifyBody({ email: "a@b.co", code: "12345" }).ok).toBe(false);
  expect(parseVerifyBody({ email: "a@b.co", code: "abcdef" }).ok).toBe(false);
  expect(parseVerifyBody({ email: "bad", code: "123456" }).ok).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter signups test authValidate`
Expected: FAIL — `Cannot find module './authValidate'`.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/signups/src/authValidate.ts
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE = /^[0-9]{6}$/;

export function normalizeEmail(v: unknown): string {
  return (typeof v === "string" ? v.trim().toLowerCase() : "");
}

type ReqResult = { ok: true; email: string } | { ok: false };
export function parseRequestBody(body: unknown): ReqResult {
  if (typeof body !== "object" || body === null) return { ok: false };
  const email = normalizeEmail((body as Record<string, unknown>).email);
  if (email.length < 3 || email.length > 320 || !EMAIL.test(email)) return { ok: false };
  return { ok: true, email };
}

type VerifyResult = { ok: true; email: string; code: string } | { ok: false };
export function parseVerifyBody(body: unknown): VerifyResult {
  if (typeof body !== "object" || body === null) return { ok: false };
  const b = body as Record<string, unknown>;
  const email = normalizeEmail(b.email);
  const code = typeof b.code === "string" ? b.code.trim() : "";
  if (email.length < 3 || email.length > 320 || !EMAIL.test(email)) return { ok: false };
  if (!CODE.test(code)) return { ok: false };
  return { ok: true, email, code };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter signups test authValidate`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/signups/src/authValidate.ts apps/signups/src/authValidate.test.ts
git commit -m "feat(signups): email canonicalization + auth body parsing"
```

---

### Task 2: `AuthDb` interface + schema + real SQL (`authDb.ts`)

**Files:**
- Create: `apps/signups/src/authDb.ts`
- Test: `apps/signups/src/authDb.test.ts`

The atomic guarantees live in the SQL (single-statement `UPDATE ... RETURNING`). `pg-mem` cannot model `ctid`/`now()` defaults (see the existing `db.test.ts` note), so these tests assert the **SQL text + params** a stub pool receives, mirroring `db.test.ts`. True concurrency behavior is validated by the handler tests (Task 3) against the in-memory fake, and by a manual Postgres check noted at the end of the phase.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/signups/src/authDb.test.ts
import { test, expect, vi } from "vitest";
import { createAuthDb, ensureAuthSchema } from "./authDb";
import type { Pool, QueryResult } from "pg";

function recorder() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const rowsToReturn: Record<string, unknown>[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
      calls.push({ sql: sql.trim(), params });
      return { rows: rowsToReturn.splice(0), rowCount: 0, command: "", oid: 0, fields: [] };
    }),
  } as unknown as Pool;
  return { pool, calls, push: (r: Record<string, unknown>) => rowsToReturn.push(r) };
}

test("ensureAuthSchema issues CREATE TABLE for the three auth tables", async () => {
  const { pool, calls } = recorder();
  await ensureAuthSchema(pool);
  const joined = calls.map((c) => c.sql.toUpperCase()).join("\n");
  expect(joined).toContain("CREATE TABLE IF NOT EXISTS ACCOUNTS");
  expect(joined).toContain("CREATE TABLE IF NOT EXISTS LOGIN_CODES");
  expect(joined).toContain("CREATE TABLE IF NOT EXISTS AUTH_TOKENS");
});

test("claimAttempt sends a single guarded UPDATE and returns the code hash", async () => {
  const { pool, calls, push } = recorder();
  push({ code_hash: "H" });
  const db = createAuthDb(pool);
  const got = await db.claimAttempt("a@b.co");
  expect(got).toEqual({ codeHash: "H" });
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("UPDATE LOGIN_CODES");
  expect(sql).toContain("ATTEMPTS = ATTEMPTS + 1");
  expect(sql).toContain("ATTEMPTS < 5");
  expect(sql).toContain("CONSUMED_AT IS NULL");
  expect(sql).toContain("EXPIRES_AT > NOW()");
  expect(sql).toContain("RETURNING CODE_HASH");
  expect(calls[0].params).toEqual(["a@b.co"]);
});

test("claimAttempt returns null when no row comes back", async () => {
  const { pool } = recorder();
  const db = createAuthDb(pool);
  expect(await db.claimAttempt("a@b.co")).toBeNull();
});

test("consumeCode returns true only when a row is updated", async () => {
  const { pool, push } = recorder();
  const db = createAuthDb(pool);
  push({ ok: 1 });
  expect(await db.consumeCode("a@b.co")).toBe(true);
  expect(await db.consumeCode("a@b.co")).toBe(false); // no row this time
});

test("accountByToken joins accounts and filters revoked/expired", async () => {
  const { pool, calls, push } = recorder();
  push({ id: "acc-1", email: "a@b.co", name: "Jane" });
  const db = createAuthDb(pool);
  const acc = await db.accountByToken("HASH");
  expect(acc).toEqual({ id: "acc-1", email: "a@b.co", name: "Jane" });
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("FROM AUTH_TOKENS");
  expect(sql).toContain("REVOKED_AT IS NULL");
  expect(sql).toContain("JOIN ACCOUNTS");
  expect(calls[0].params).toEqual(["HASH"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter signups test authDb`
Expected: FAIL — `Cannot find module './authDb'`.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/signups/src/authDb.ts
import type { Pool } from "pg";

export interface Account {
  id: string;
  email: string;
  name: string | null;
}

/** All account/code/token IO behind one object, so the route handlers take one
 *  dep (matches the repo convention of a small injected IO surface). */
export interface AuthDb {
  insertCode(email: string, codeHash: string, ttlSeconds: number): Promise<void>;
  invalidateCodes(email: string): Promise<void>;
  /** Atomically count an attempt against the newest valid code; null if none. */
  claimAttempt(email: string): Promise<{ codeHash: string } | null>;
  /** Atomically consume the newest unconsumed code; false if already consumed. */
  consumeCode(email: string): Promise<boolean>;
  cleanupExpiredCodes(): Promise<void>;
  /** Upsert the account (name backfilled from the newest matching signup). */
  upsertAccount(email: string): Promise<Account>;
  insertToken(tokenHash: string, accountId: string): Promise<void>;
  /** Account for a live (non-revoked, within max-age) token, or null. */
  accountByToken(tokenHash: string): Promise<Account | null>;
  touchToken(tokenHash: string): Promise<void>;
  revokeToken(tokenHash: string): Promise<void>;
}

const TOKEN_MAX_AGE = "1 year";

export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_lower_idx ON accounts (lower(email));

CREATE TABLE IF NOT EXISTS login_codes (
  email       text NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_codes_email_idx ON login_codes (email);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash   text PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS auth_tokens_account_idx ON auth_tokens (account_id);`;

export async function ensureAuthSchema(pool: Pool): Promise<void> {
  await pool.query(AUTH_SCHEMA);
}

export function createAuthDb(pool: Pool): AuthDb {
  return {
    async insertCode(email, codeHash, ttlSeconds) {
      await pool.query(
        `INSERT INTO login_codes (email, code_hash, expires_at)
         VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
        [email, codeHash, String(ttlSeconds)],
      );
    },
    async invalidateCodes(email) {
      await pool.query(
        `UPDATE login_codes SET consumed_at = now()
         WHERE email = $1 AND consumed_at IS NULL`,
        [email],
      );
    },
    async claimAttempt(email) {
      const r = await pool.query(
        `UPDATE login_codes SET attempts = attempts + 1
         WHERE ctid = (
           SELECT ctid FROM login_codes
           WHERE email = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < 5
           ORDER BY created_at DESC LIMIT 1
         )
         RETURNING code_hash`,
        [email],
      );
      const row = r.rows[0] as { code_hash: string } | undefined;
      return row ? { codeHash: row.code_hash } : null;
    },
    async consumeCode(email) {
      const r = await pool.query(
        `UPDATE login_codes SET consumed_at = now()
         WHERE ctid = (
           SELECT ctid FROM login_codes
           WHERE email = $1 AND consumed_at IS NULL AND expires_at > now()
           ORDER BY created_at DESC LIMIT 1
         )
         RETURNING 1 AS ok`,
        [email],
      );
      return (r.rowCount ?? 0) > 0;
    },
    async cleanupExpiredCodes() {
      await pool.query(`DELETE FROM login_codes WHERE expires_at < now() - interval '1 day'`);
    },
    async upsertAccount(email) {
      const r = await pool.query(
        `INSERT INTO accounts (email, name, last_login_at)
         VALUES ($1, (SELECT name FROM signups WHERE lower(email) = $1 ORDER BY last_seen DESC LIMIT 1), now())
         ON CONFLICT (lower(email)) DO UPDATE SET last_login_at = now()
         RETURNING id, email, name`,
        [email],
      );
      return r.rows[0] as Account;
    },
    async insertToken(tokenHash, accountId) {
      await pool.query(
        `INSERT INTO auth_tokens (token_hash, account_id) VALUES ($1, $2)`,
        [tokenHash, accountId],
      );
    },
    async accountByToken(tokenHash) {
      const r = await pool.query(
        `SELECT a.id, a.email, a.name
         FROM auth_tokens t JOIN accounts a ON a.id = t.account_id
         WHERE t.token_hash = $1 AND t.revoked_at IS NULL
           AND t.created_at > now() - interval '${TOKEN_MAX_AGE}'`,
        [tokenHash],
      );
      return (r.rows[0] as Account | undefined) ?? null;
    },
    async touchToken(tokenHash) {
      await pool.query(`UPDATE auth_tokens SET last_used_at = now() WHERE token_hash = $1`, [tokenHash]);
    },
    async revokeToken(tokenHash) {
      await pool.query(`UPDATE auth_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash]);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter signups test authDb`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/signups/src/authDb.ts apps/signups/src/authDb.test.ts
git commit -m "feat(signups): AuthDb schema + atomic OTP/token queries"
```

---

### Task 3: Auth route handlers (`auth.ts`) — the core logic, TDD against a fake `AuthDb`

**Files:**
- Create: `apps/signups/src/auth.ts`
- Test: `apps/signups/src/auth.test.ts`

This is where the OTP lifecycle, attempt cap, single-use, hashing, and no-enumeration behavior are proven. The test builds a real Hono app with `registerAuthRoutes` wired to an in-memory fake `AuthDb`, a capturing `sendCode`, and always-allow limiters.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/signups/src/auth.test.ts
import { test, expect, vi } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { registerAuthRoutes } from "./auth";
import type { AuthDb, Account } from "./authDb";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

/** In-memory AuthDb honoring the same contract the SQL implements. */
function fakeDb() {
  const codes: { email: string; codeHash: string; attempts: number; consumed: boolean }[] = [];
  const accounts = new Map<string, Account>();
  const tokens = new Map<string, string>(); // tokenHash -> accountId
  const revoked = new Set<string>();
  let seq = 0;
  const db: AuthDb = {
    async insertCode(email, codeHash) { codes.push({ email, codeHash, attempts: 0, consumed: false }); },
    async invalidateCodes(email) { codes.forEach((c) => { if (c.email === email) c.consumed = true; }); },
    async claimAttempt(email) {
      const c = [...codes].reverse().find((c) => c.email === email && !c.consumed && c.attempts < 5);
      if (!c) return null;
      c.attempts++;
      return { codeHash: c.codeHash };
    },
    async consumeCode(email) {
      const c = [...codes].reverse().find((c) => c.email === email && !c.consumed);
      if (!c) return false;
      c.consumed = true;
      return true;
    },
    async cleanupExpiredCodes() {},
    async upsertAccount(email) {
      let a = accounts.get(email);
      if (!a) { a = { id: `acc-${++seq}`, email, name: "Jane" }; accounts.set(email, a); }
      return a;
    },
    async insertToken(tokenHash, accountId) { tokens.set(tokenHash, accountId); },
    async accountByToken(tokenHash) {
      if (revoked.has(tokenHash)) return null;
      const accId = tokens.get(tokenHash);
      if (!accId) return null;
      return [...accounts.values()].find((a) => a.id === accId) ?? null;
    },
    async touchToken() {},
    async revokeToken(tokenHash) { revoked.add(tokenHash); },
  };
  return { db, codes };
}

function make(over: { sendCode?: (e: string, c: string) => Promise<void>; allow?: () => boolean } = {}) {
  const { db, codes } = fakeDb();
  const sent: { email: string; code: string }[] = [];
  const sendCode = over.sendCode ?? (async (email, code) => { sent.push({ email, code }); });
  const allow = over.allow ?? (() => true);
  const app = new Hono();
  registerAuthRoutes(app, { db, sendCode, allowRequest: allow, allowVerify: allow });
  return { app, db, codes, sent };
}

const json = (app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("request → sends a 6-digit code and returns ok", async () => {
  const { app, sent } = make();
  const res = await json(app, "/auth/request", { email: "Jane@Acme.com" });
  expect(res.status).toBe(200);
  expect(sent.length).toBe(1);
  expect(sent[0].email).toBe("jane@acme.com");
  expect(sent[0].code).toMatch(/^[0-9]{6}$/);
});

test("request with a bad email → 400, nothing sent", async () => {
  const { app, sent } = make();
  expect((await json(app, "/auth/request", { email: "nope" })).status).toBe(400);
  expect(sent.length).toBe(0);
});

test("request returns 502 when Resend fails (not hidden)", async () => {
  const { app } = make({ sendCode: async () => { throw new Error("resend down"); } });
  expect((await json(app, "/auth/request", { email: "a@b.co" })).status).toBe(502);
});

test("verify with the right code → token + account", async () => {
  const { app, sent } = make();
  await json(app, "/auth/request", { email: "a@b.co" });
  const res = await json(app, "/auth/verify", { email: "a@b.co", code: sent[0].code });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; account: { email: string; name: string } };
  expect(body.token.length).toBeGreaterThan(20);
  expect(body.account).toEqual({ email: "a@b.co", name: "Jane" });
});

test("verify with the wrong code → 401", async () => {
  const { app, sent } = make();
  await json(app, "/auth/request", { email: "a@b.co" });
  const wrong = sent[0].code === "000000" ? "111111" : "000000";
  expect((await json(app, "/auth/verify", { email: "a@b.co", code: wrong })).status).toBe(401);
});

test("verify is single-use", async () => {
  const { app, sent } = make();
  await json(app, "/auth/request", { email: "a@b.co" });
  expect((await json(app, "/auth/verify", { email: "a@b.co", code: sent[0].code })).status).toBe(200);
  expect((await json(app, "/auth/verify", { email: "a@b.co", code: sent[0].code })).status).toBe(401);
});

test("verify caps at 5 attempts then locks the code out", async () => {
  const { app, sent } = make();
  await json(app, "/auth/request", { email: "a@b.co" });
  for (let i = 0; i < 5; i++) await json(app, "/auth/verify", { email: "a@b.co", code: "000000" });
  // even the correct code is now rejected (attempts exhausted)
  expect((await json(app, "/auth/verify", { email: "a@b.co", code: sent[0].code })).status).toBe(401);
});

test("me returns the account for a valid bearer, 401 after logout", async () => {
  const { app, sent } = make();
  await json(app, "/auth/request", { email: "a@b.co" });
  const body = (await (await json(app, "/auth/verify", { email: "a@b.co", code: sent[0].code })).json()) as { token: string };
  const auth = { authorization: `Bearer ${body.token}` };
  expect((await app.request("/me", { headers: auth })).status).toBe(200);
  expect((await app.request("/auth/logout", { method: "POST", headers: auth })).status).toBe(200);
  expect((await app.request("/me", { headers: auth })).status).toBe(401);
});

test("me without a token → 401", async () => {
  const { app } = make();
  expect((await app.request("/me")).status).toBe(401);
});

test("request rate-limited → 429", async () => {
  const { app, sent } = make({ allow: () => false });
  expect((await json(app, "/auth/request", { email: "a@b.co" })).status).toBe(429);
  expect(sent.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter signups test src/auth.test.ts`
Expected: FAIL — `Cannot find module './auth'`.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/signups/src/auth.ts
import type { Hono } from "hono";
import { createHash, randomInt, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthDb } from "./authDb";
import { parseRequestBody, parseVerifyBody } from "./authValidate";

export interface AuthDeps {
  db: AuthDb;
  sendCode: (email: string, code: string) => Promise<void>;
  /** Per-key rate limiters (createRateLimiter). Return false to reject. */
  allowRequest: (key: string) => boolean;
  allowVerify: (key: string) => boolean;
}

const CODE_TTL_SECONDS = 600; // 10 minutes
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function bearer(c: { req: { header: (k: string) => string | undefined } }): string | null {
  const h = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export function registerAuthRoutes(app: Hono, deps: AuthDeps): void {
  const { db, sendCode, allowRequest, allowVerify } = deps;

  app.post("/auth/request", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    const parsed = parseRequestBody(body);
    if (!parsed.ok) return c.json({ error: "invalid email" }, 400);
    const { email } = parsed;
    if (!allowRequest(`auth:req:ip:${clientIp(c)}`) || !allowRequest(`auth:req:email:${email}`)) {
      return c.json({ error: "rate limited" }, 429);
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await db.invalidateCodes(email);
    await db.insertCode(email, sha(code), CODE_TTL_SECONDS);
    db.cleanupExpiredCodes().catch(() => {}); // opportunistic, never blocks the response
    try {
      await sendCode(email, code);
    } catch (e) {
      console.error("auth: sendCode failed", e);
      return c.json({ error: "could not send code" }, 502);
    }
    return c.json({ ok: true });
  });

  app.post("/auth/verify", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    const parsed = parseVerifyBody(body);
    if (!parsed.ok) return c.json({ error: "invalid" }, 400);
    const { email, code } = parsed;
    if (!allowVerify(`auth:vrf:ip:${clientIp(c)}`) || !allowVerify(`auth:vrf:email:${email}`)) {
      return c.json({ error: "rate limited" }, 429);
    }
    const claim = await db.claimAttempt(email);
    if (!claim || !timingSafeEqualHex(sha(code), claim.codeHash)) return c.json({ error: "invalid code" }, 401);
    if (!(await db.consumeCode(email))) return c.json({ error: "invalid code" }, 401);
    const account = await db.upsertAccount(email);
    const token = randomBytes(32).toString("base64url");
    await db.insertToken(sha(token), account.id);
    return c.json({ token, account: { email: account.email, name: account.name } });
  });

  app.get("/me", async (c) => {
    const token = bearer(c);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const account = await db.accountByToken(sha(token));
    if (!account) return c.json({ error: "unauthorized" }, 401);
    await db.touchToken(sha(token));
    return c.json({ account: { email: account.email, name: account.name } });
  });

  app.post("/auth/logout", async (c) => {
    const token = bearer(c);
    if (token) await db.revokeToken(sha(token));
    return c.json({ ok: true });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter signups test src/auth.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/signups/src/auth.ts apps/signups/src/auth.test.ts
git commit -m "feat(signups): OTP request/verify + bearer me/logout routes"
```

---

### Task 4: Resend sender (`resend.ts`)

**Files:**
- Create: `apps/signups/src/resend.ts`
- Test: `apps/signups/src/resend.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/signups/src/resend.test.ts
import { test, expect, vi } from "vitest";
import { createResendSender } from "./resend";

test("posts the code to Resend and resolves on 200", async () => {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ id: "x" }), { status: 200 }));
  const send = createResendSender({ apiKey: "re_test", from: "Rigel <login@rigel.run>", fetchFn });
  await send("jane@acme.com", "123456");
  expect(fetchFn).toHaveBeenCalledTimes(1);
  const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://api.resend.com/emails");
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
  const payload = JSON.parse(init.body as string);
  expect(payload.to).toBe("jane@acme.com");
  expect(payload.from).toBe("Rigel <login@rigel.run>");
  expect(payload.subject).toContain("123456");
  expect(payload.text).toContain("123456");
});

test("throws on a non-2xx from Resend", async () => {
  const fetchFn = vi.fn(async () => new Response("nope", { status: 422 }));
  const send = createResendSender({ apiKey: "re_test", from: "x", fetchFn });
  await expect(send("a@b.co", "000000")).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter signups test resend`
Expected: FAIL — `Cannot find module './resend'`.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/signups/src/resend.ts
export interface ResendConfig {
  apiKey: string;
  from: string;
  fetchFn?: typeof fetch;
}

/** Returns a sendCode(email, code) that emails the OTP via Resend. */
export function createResendSender({ apiKey, from, fetchFn = fetch }: ResendConfig) {
  return async function sendCode(email: string, code: string): Promise<void> {
    const res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: email,
        subject: `Your Rigel sign-in code: ${code}`,
        text: `Your Rigel sign-in code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
      }),
    });
    if (!res.ok) throw new Error(`resend failed: ${res.status} ${await res.text().catch(() => "")}`);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter signups test resend`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/signups/src/resend.ts apps/signups/src/resend.test.ts
git commit -m "feat(signups): Resend OTP email sender"
```

---

### Task 5: Wire auth routes into `createApp`

**Files:**
- Modify: `apps/signups/src/app.ts`
- Test: `apps/signups/src/app.test.ts` (add one wiring assertion)

- [ ] **Step 1: Write the failing test** (append to `app.test.ts`)

```typescript
import { registerAuthRoutes } from "./auth"; // add to imports at top

test("auth routes are mounted when auth deps are provided", async () => {
  const app = createApp({
    appKey: "secret",
    upsert: async () => {},
    allow: () => true,
    auth: {
      db: {
        insertCode: async () => {}, invalidateCodes: async () => {}, claimAttempt: async () => null,
        consumeCode: async () => false, cleanupExpiredCodes: async () => {},
        upsertAccount: async () => ({ id: "a", email: "a@b.co", name: null }),
        insertToken: async () => {}, accountByToken: async () => null, touchToken: async () => {}, revokeToken: async () => {},
      },
      sendCode: async () => {},
      allowRequest: () => true,
      allowVerify: () => true,
    },
  });
  // /me with no token is a mounted route that returns 401 (not a 404)
  expect((await app.request("/me")).status).toBe(401);
});

test("auth routes are absent when no auth deps (waitlist-only build)", async () => {
  const app = createApp({ appKey: "secret", upsert: async () => {}, allow: () => true });
  expect((await app.request("/me")).status).toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter signups test src/app.test.ts`
Expected: FAIL — `createApp` does not accept `auth`; `/me` is 404 in the first test.

- [ ] **Step 3: Modify `app.ts`**

Add the import and extend `AppDeps` + `createApp`:

```typescript
// apps/signups/src/app.ts — add near the other imports
import { registerAuthRoutes, type AuthDeps } from "./auth";
```

Extend the interface:

```typescript
export interface AppDeps {
  appKey: string;
  upsert: (s: Signup) => Promise<void>;
  allow: (key: string) => boolean;
  notify?: (s: Signup) => Promise<void>;
  /** When present, mounts the /auth/* + /me account routes. */
  auth?: AuthDeps;
}
```

Inside `createApp`, after the existing `app.post("/signups", ...)` block and before `return app;`:

```typescript
  if (auth) registerAuthRoutes(app, auth);
```

And add `auth` to the destructure: `export function createApp({ appKey, upsert, allow, notify, auth }: AppDeps): Hono {`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter signups test src/app.test.ts`
Expected: PASS (all existing tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add apps/signups/src/app.ts apps/signups/src/app.test.ts
git commit -m "feat(signups): mount auth routes in createApp when auth deps present"
```

---

### Task 6: Production wiring in `index.ts`

**Files:**
- Modify: `apps/signups/src/index.ts`

No new test (this is the composition root; behavior is covered by the unit tests). Verify by typecheck + a boot smoke.

- [ ] **Step 1: Edit `index.ts`**

Add imports:

```typescript
import { ensureAuthSchema, createAuthDb } from "./authDb";
import { createResendSender } from "./resend";
```

Add config reads near the others:

```typescript
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const RESEND_FROM = process.env.RESEND_FROM ?? "Rigel <login@rigel.run>";
if (!RESEND_API_KEY) console.warn("RESEND_API_KEY not set — auth code emails will fail");
```

After `await ensureSchema(pool);` add:

```typescript
await ensureAuthSchema(pool);
```

Before `const app = createApp(...)`, build the auth deps:

```typescript
const authDb = createAuthDb(pool);
const sendCode = createResendSender({ apiKey: RESEND_API_KEY, from: RESEND_FROM });
// Tighter, separate limiters (namespaced keys prevent collision with /signups).
const allowRequest = createRateLimiter(5, 10 * 60_000);  // 5 code requests / 10 min per key
const allowVerify = createRateLimiter(10, 10 * 60_000);  // 10 verify attempts / 10 min per key
```

Extend the `createApp` call:

```typescript
const app = createApp({
  appKey: APP_KEY,
  upsert: (s) => upsertSignup(pool, s),
  allow,
  notify,
  auth: { db: authDb, sendCode, allowRequest, allowVerify },
});
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter signups typecheck`
Expected: no errors.

- [ ] **Step 3: Boot smoke (no DB needed for the compile check)**

Run: `pnpm --filter signups build`
Expected: build succeeds (bundle written).

- [ ] **Step 4: Commit**

```bash
git add apps/signups/src/index.ts
git commit -m "feat(signups): wire AuthDb + Resend + auth limiters at startup"
```

---

### Task 7: Deploy config — `RESEND_API_KEY`

**Files:**
- Modify: the accounts service Secret / deployment manifest (locate with the step below).

- [ ] **Step 1: Locate the signups Secret + deployment**

Run: `grep -rl "APP_KEY\|signups" deploy/ 2>/dev/null; ls deploy/signups 2>/dev/null`
Expected: the manifest dir/files for the signups service.

- [ ] **Step 2: Add `RESEND_API_KEY` (and optional `RESEND_FROM`) to the Secret and reference it in the Deployment env**, following the exact pattern the existing `APP_KEY`/`KIT_API_KEY` use in that manifest. Obtain the key from Resend and store it in 1Password alongside the other app secrets.

- [ ] **Step 3: Commit**

```bash
git add deploy/
git commit -m "chore(deploy): add RESEND_API_KEY to the signups/accounts service"
```

> Do NOT roll this out yet — the desktop side (Phases 2–4) is not built, and rolling the backend early is harmless but pointless. Rollout happens when Phase 4 lands, using the standard CI deploy pattern.

---

### Phase 1 verification (run before starting Phase 2)

- [ ] `pnpm --filter signups typecheck` — clean.
- [ ] `pnpm --filter signups test` — all green.
- [ ] **Manual Postgres atomicity check** (the one thing `pg-mem`/stubs cannot prove). Against a scratch Postgres:
  1. `ensureAuthSchema`, insert one code, fire two concurrent `consumeCode(email)` calls, assert exactly one returns `true`.
  2. Fire six concurrent `claimAttempt(email)` calls, assert `attempts` lands at exactly 5 (the `attempts < 5` guard held) and no 6th attempt succeeded.

  Record the result in the PR description. If it fails, the `ctid` sub-select needs `FOR UPDATE SKIP LOCKED`; note it and fix before Phase 2.

---

## Subsequent phases (each gets its own detailed plan when reached)

These are intentionally NOT expanded to task-level here — their code depends on Phase 1's now-real route/token shapes, and pinning it prematurely invites drift. Author each plan (via writing-plans) at the start of that phase.

### Phase 2 — Electron main identity
- **New** `apps/desktop/src/accountStore.ts`: `safeStorage`-encrypted token at `rigel-account.bin` (0600). Fail closed unless `isEncryptionAvailable()` AND `getSelectedStorageBackend() !== "basic_text"`. Unit-tested with `safeStorage` faked (encrypt/decrypt round-trip, clear, unavailable → fail closed), mirroring `installStore.test.ts`.
- **New** `apps/desktop/src/accountClient.ts`: `requestCode`/`verifyCode`/`me`/`signOut` calling `api.rigel.run` (endpoint from an env/const like the signups `endpoint`), holding the token via `accountStore`. Pure, `fetchFn`-injected, unit-tested.
- **Modify** `apps/desktop/src/main.ts`: `ipcMain.handle` for `rigel:account:*` (four channels), and **Modify** `apps/desktop/src/preload.ts` to expose `rigel.account = { requestCode, verifyCode, me, signOut }` over `contextBridge` (renderer never sees the raw token). Launch refresh: on ready, `me()`; on 401 clear. Generate `sessionSecret` (`randomBytes`) once per launch.
- **Modify** `forkServer` (`main.ts:198`): after fork, `child.postMessage({ type: "secrets", sessionSecret, accountToken })`; re-send inside every `forkServer` call (covers `scheduleServerRestart`). Remove the temptation to pass either via `env`.
- Depends on: Phase 1 routes live.

### Phase 3 — Local server session-secret middleware
- **New** `apps/server/src/sessionAuth.ts`: middleware requiring `x-rigel-session` on `/api/*` except `/api/health`, plus a WS first-frame handshake check with a short pre-auth timeout. Receives the secret via `process.parentPort.on("message", ...)`. Unit-tested (accept correct / reject missing / reject wrong, for both HTTP and the WS gate).
- **Modify** `apps/server/src/index.ts`: install the middleware; exempt `/api/health`; enforce the WS handshake at `wss.on("connection")`.
- **Modify** `apps/web/src/lib/api.ts` `apiFetch`: stamp `x-rigel-session` (read from a preload-exposed `rigel.sessionSecret`) alongside the existing `X-Rigel-Context`. **Modify** the WS client to send the handshake frame before any subscribe.
- **Modify** `apps/desktop/src/main.ts` `waitForHealth` (unauthenticated `/api/health` stays fine) and the smoke test (`main.ts:450`) to stamp the handshake. Ship the health-exemption + main-stamping in this same phase or boot goes red.
- Depends on: Phase 2 (secret delivery plumbing).

### Phase 4 — Account panel UI
- **Modify** `apps/web/src/shell/AccountModal.tsx` + `AccountGate.tsx`: signed-out email→code login (calls `rigel.account.requestCode`/`verifyCode`), signed-in name/email from `rigel.account.me()`, neutral "Sign out". Absorb the first-run name capture into the account row. Follow Dialog primitives + Tailwind/tokens (no inline styles for new UI). Component-tested (RTL) across states: signed-out, code-sent, invalid/expired (resend), rate-limited, network error, signed-in.
- **Modify** `apps/web/src/lib/desktop.ts` typing for the new `rigel.account` surface.
- Depends on: Phases 2–3. When this lands, roll out the Phase 1/7 backend (standard CI deploy) and mark PR #41 ready.

---

## Self-review notes (author, pre-handoff)

- **Spec coverage:** Phase 1 tasks cover spec Component 1 in full (tables, four routes, Resend, rate-limits, canonicalization, atomicity, no-enumeration, cleanup, DB-time expiry, `crypto.randomInt`). Components 2–4 map to Phases 2–4. No spec requirement is unassigned.
- **Type consistency:** `AuthDb` method names/signatures are identical across `authDb.ts`, `auth.ts`, and the fakes in `auth.test.ts`/`app.test.ts`. `sendCode(email, code)` and the `{ token, account: { email, name } }` verify shape are used identically in the handler, its test, and the Phase-2 client scope.
- **No placeholders:** every Phase-1 step ships real code, an exact command, and expected output. Phase 2–4 are explicitly future plans, not in-plan TODOs.
