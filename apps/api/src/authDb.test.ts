import { test, expect, vi } from "vitest";
import { newDb } from "pg-mem";
import { createAuthDb, ensureAuthSchema } from "./authDb";
import type { Pool, QueryResult } from "pg";

async function pendingLoginsPool() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool() as unknown as Pool;
  await pool.query(`
    CREATE TABLE pending_logins (
      id                 serial PRIMARY KEY,
      email              text NOT NULL,
      poll_token_hash    text NOT NULL,
      confirm_token_hash text NOT NULL,
      created_at         timestamptz NOT NULL DEFAULT now(),
      expires_at         timestamptz NOT NULL,
      confirmed_at       timestamptz,
      consumed_at        timestamptz
    )
  `);
  return pool;
}

function recorder() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const rowsToReturn: Record<string, unknown>[] = [];
  let nextRowCount: number | null = null;
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
      calls.push({ sql: sql.trim(), params });
      const rowCount = nextRowCount ?? 0;
      nextRowCount = null;
      return { rows: rowsToReturn.splice(0), rowCount, command: "", oid: 0, fields: [] };
    }),
  } as unknown as Pool;
  return {
    pool,
    calls,
    push: (r: Record<string, unknown>) => rowsToReturn.push(r),
    pushCount: (n: number) => { nextRowCount = n; },
  };
}

test("ensureAuthSchema issues CREATE TABLE for accounts and auth_tokens", async () => {
  const { pool, calls } = recorder();
  await ensureAuthSchema(pool);
  const joined = calls.map((c) => c.sql.toUpperCase()).join("\n");
  expect(joined).toContain("CREATE TABLE IF NOT EXISTS ACCOUNTS");
  expect(joined).toContain("CREATE TABLE IF NOT EXISTS AUTH_TOKENS");
});

test("ensureAuthSchema creates organizations + memberships and backfills", async () => {
  const { pool, calls } = recorder();
  await ensureAuthSchema(pool);
  const j = calls.map((c) => c.sql.toUpperCase()).join("\n");
  expect(j).toContain("CREATE TABLE IF NOT EXISTS ORGANIZATIONS");
  expect(j).toContain("CREATE TABLE IF NOT EXISTS MEMBERSHIPS");
  expect(j).toContain("INSERT INTO ORGANIZATIONS");
});

test("getOrgsForAccount joins memberships + organizations", async () => {
  const { pool, calls, push } = recorder();
  push({ id: "o1", kind: "personal", name: "Jane", role: "owner" });
  const db = createAuthDb(pool);
  expect(await db.getOrgsForAccount("acc-1")).toEqual([{ id: "o1", kind: "personal", name: "Jane", role: "owner" }]);
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("FROM MEMBERSHIPS");
  expect(sql).toContain("JOIN ORGANIZATIONS");
  expect(sql).toContain("ACCOUNT_ID = $1");
  expect(calls[0].params).toEqual(["acc-1"]);
});

test("billableOrgs returns each membership org id + its stripe customer", async () => {
  const { pool, calls, push } = recorder();
  push({ org_id: "org-1", stripe_customer_id: "cus_1" });
  push({ org_id: "org-2", stripe_customer_id: null });
  const db = createAuthDb(pool);
  const rows = await db.billableOrgs("acc-1");
  expect(calls[0].params).toEqual(["acc-1"]);
  expect(calls[0].sql.toUpperCase()).toContain("JOIN ORGANIZATIONS");
  expect(rows).toEqual([
    { orgId: "org-1", stripeCustomerId: "cus_1" },
    { orgId: "org-2", stripeCustomerId: null },
  ]);
});

test("ensurePersonalOrg upserts org + owner membership idempotently", async () => {
  const { pool, calls } = recorder();
  await createAuthDb(pool).ensurePersonalOrg("acc-1", "Jane");
  const j = calls.map((c) => c.sql.toUpperCase()).join("\n");
  expect(j).toContain("INSERT INTO ORGANIZATIONS");
  expect(j).toContain("ON CONFLICT");
  expect(j).toContain("INSERT INTO MEMBERSHIPS");
});

test("orgBilling returns customer id + caller role (null when not a member)", async () => {
  const { pool, push } = recorder();
  push({ stripe_customer_id: "cus_1", role: "owner" });
  const db = createAuthDb(pool);
  expect(await db.orgBilling("o1", "acc-1")).toEqual({ stripeCustomerId: "cus_1", role: "owner" });
});

test("orgSeatCount counts memberships", async () => {
  const { pool, push } = recorder();
  push({ n: "3" });
  const db = createAuthDb(pool);
  expect(await db.orgSeatCount("o1")).toBe(3);
});

test("setOrgStripeCustomer writes the id only when still unset (guarded WHERE)", async () => {
  const { pool, calls } = recorder();
  const db = createAuthDb(pool);
  await db.setOrgStripeCustomer("o1", "cus_9");
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("UPDATE ORGANIZATIONS");
  expect(sql).toContain("STRIPE_CUSTOMER_ID IS NULL");
  expect(calls[0].params).toEqual(["cus_9", "o1"]);
});

test("setOrgStripeCustomer (pg-mem) sets when null but never overwrites an existing customer", async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool() as unknown as Pool;
  await pool.query(`CREATE TABLE organizations (id text PRIMARY KEY, stripe_customer_id text)`);
  await pool.query(`INSERT INTO organizations (id, stripe_customer_id) VALUES ('o1', null)`);
  const db = createAuthDb(pool);
  await db.setOrgStripeCustomer("o1", "cus_first");
  expect(await db.orgStripeCustomer("o1")).toBe("cus_first");
  await db.setOrgStripeCustomer("o1", "cus_second");
  expect(await db.orgStripeCustomer("o1")).toBe("cus_first");
});

test("accountEmail selects the email for the account id", async () => {
  const { pool, calls, push } = recorder();
  push({ email: "a@b.co" });
  const db = createAuthDb(pool);
  expect(await db.accountEmail("acc-1")).toBe("a@b.co");
  expect(calls[0].sql.toUpperCase()).toContain("SELECT EMAIL FROM ACCOUNTS");
  expect(calls[0].params).toEqual(["acc-1"]);
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

test("ensureAuthSchema creates the agent_tokens table", async () => {
  const { pool, calls } = recorder();
  await ensureAuthSchema(pool);
  const j = calls.map((c) => c.sql.toUpperCase()).join("\n");
  expect(j).toContain("CREATE TABLE IF NOT EXISTS AGENT_TOKENS");
});

test("createAgentToken inserts the hashed token bound to org + install", async () => {
  const { pool, calls } = recorder();
  const db = createAuthDb(pool);
  await db.createAgentToken({ orgId: "o1", installId: "inst-1", tokenHash: "HASH" });
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("INSERT INTO AGENT_TOKENS");
  expect(calls[0].params).toEqual(["HASH", "o1", "inst-1"]);
});

test("agentTokenByHash returns org + install + revoked (null when no row)", async () => {
  const { pool, calls, push } = recorder();
  push({ org_id: "o1", install_id: "inst-1", revoked: false });
  const db = createAuthDb(pool);
  expect(await db.agentTokenByHash("HASH")).toEqual({ orgId: "o1", installId: "inst-1", revoked: false });
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("FROM AGENT_TOKENS");
  expect(sql).toContain("TOKEN_HASH = $1");
  expect(calls[0].params).toEqual(["HASH"]);
  expect(await db.agentTokenByHash("MISSING")).toBeNull();
});

test("orgStripeCustomer selects the customer id (null when none/no row)", async () => {
  const { pool, calls, push } = recorder();
  push({ stripe_customer_id: "cus_1" });
  const db = createAuthDb(pool);
  expect(await db.orgStripeCustomer("o1")).toBe("cus_1");
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("SELECT STRIPE_CUSTOMER_ID FROM ORGANIZATIONS");
  expect(calls[0].params).toEqual(["o1"]);
  expect(await db.orgStripeCustomer("missing")).toBeNull();
});

test("ensureAuthSchema creates pending_logins with all three indexes", async () => {
  const { pool, calls } = recorder();
  await ensureAuthSchema(pool);
  const j = calls.map((c) => c.sql.toUpperCase()).join("\n");
  expect(j).toContain("CREATE TABLE IF NOT EXISTS PENDING_LOGINS");
  expect(j).toContain("PENDING_LOGINS_POLL_IDX");
  expect(j).toContain("PENDING_LOGINS_CONFIRM_IDX");
  expect(j).toContain("PENDING_LOGINS_EMAIL_IDX");
});

test("createPendingLogin inserts the hashed poll+confirm tokens with a ttl-based expiry", async () => {
  const { pool, calls } = recorder();
  const db = createAuthDb(pool);
  await db.createPendingLogin({
    email: "jane@acme.com",
    pollTokenHash: "poll-hash",
    confirmTokenHash: "confirm-hash",
    ttlSeconds: 86_400,
  });
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("INSERT INTO PENDING_LOGINS");
  expect(calls[0].params).toEqual(["jane@acme.com", "poll-hash", "confirm-hash", "86400"]);
});

test("confirmPendingLogin matches by confirm_token_hash, guarded, and returns the email", async () => {
  const { pool, calls, push } = recorder();
  push({ email: "jane@acme.com" });
  const db = createAuthDb(pool);
  expect(await db.confirmPendingLogin("confirm-hash")).toEqual({ email: "jane@acme.com" });
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("UPDATE PENDING_LOGINS SET CONFIRMED_AT = NOW()");
  expect(sql).toContain("CONFIRM_TOKEN_HASH = $1");
  expect(sql).toContain("CONFIRMED_AT IS NULL");
  expect(sql).toContain("CONSUMED_AT IS NULL");
  expect(sql).toContain("EXPIRES_AT > NOW()");
  expect(sql).toContain("RETURNING EMAIL");
  expect(sql).not.toContain("SELECT");
  expect(sql).not.toContain("WHERE ID =");
  expect(calls[0].params).toEqual(["confirm-hash"]);
});

test("confirmPendingLogin returns null when no row matches", async () => {
  const { pool } = recorder();
  expect(await createAuthDb(pool).confirmPendingLogin("missing")).toBeNull();
});

test("pendingLoginByConfirmHash reads the row by confirm_token_hash without mutating it", async () => {
  const { pool, calls, push } = recorder();
  push({ email: "jane@acme.com", poll_token_hash: "poll-hash" });
  const db = createAuthDb(pool);
  expect(await db.pendingLoginByConfirmHash("confirm-hash")).toEqual({
    email: "jane@acme.com",
    pollTokenHash: "poll-hash",
  });
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("FROM PENDING_LOGINS");
  expect(sql).toContain("CONFIRM_TOKEN_HASH = $1");
  expect(sql).toContain("CONFIRMED_AT IS NULL");
  expect(sql).toContain("CONSUMED_AT IS NULL");
  expect(sql).toContain("EXPIRES_AT > NOW()");
  expect(sql).not.toContain("UPDATE");
  expect(sql).not.toContain("DELETE");
  expect(calls[0].params).toEqual(["confirm-hash"]);
});

test("pendingLoginByConfirmHash returns null when no row matches", async () => {
  const { pool } = recorder();
  expect(await createAuthDb(pool).pendingLoginByConfirmHash("missing")).toBeNull();
});

test("pendingLoginByConfirmHash (pg-mem) returns the live row and leaves it confirmable", async () => {
  const pool = await pendingLoginsPool();
  const db = createAuthDb(pool);
  await db.createPendingLogin({ email: "jane@acme.com", pollTokenHash: "p", confirmTokenHash: "c", ttlSeconds: 86_400 });
  expect(await db.pendingLoginByConfirmHash("c")).toEqual({ email: "jane@acme.com", pollTokenHash: "p" });
  expect(await db.pendingLoginByConfirmHash("c")).toEqual({ email: "jane@acme.com", pollTokenHash: "p" });
  expect(await db.confirmPendingLogin("c")).toEqual({ email: "jane@acme.com" });
  expect(await db.pendingLoginByConfirmHash("c")).toBeNull();
});

test("consumeConfirmedLogin matches by poll_token_hash, requires confirmed+unconsumed, and returns the email", async () => {
  const { pool, calls, push } = recorder();
  push({ email: "jane@acme.com" });
  const db = createAuthDb(pool);
  expect(await db.consumeConfirmedLogin("poll-hash")).toEqual({ email: "jane@acme.com" });
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("UPDATE PENDING_LOGINS SET CONSUMED_AT = NOW()");
  expect(sql).toContain("POLL_TOKEN_HASH = $1");
  expect(sql).toContain("CONFIRMED_AT IS NOT NULL");
  expect(sql).toContain("CONSUMED_AT IS NULL");
  expect(sql).toContain("EXPIRES_AT > NOW()");
  expect(sql).toContain("RETURNING EMAIL");
  expect(sql).not.toContain("SELECT");
  expect(sql).not.toContain("WHERE ID =");
  expect(calls[0].params).toEqual(["poll-hash"]);
});

test("consumeConfirmedLogin returns null when no row matches", async () => {
  const { pool } = recorder();
  expect(await createAuthDb(pool).consumeConfirmedLogin("missing")).toBeNull();
});

test("pendingLoginActive reports whether an unconsumed, unexpired row exists", async () => {
  const { pool, calls, push } = recorder();
  push({ ok: 1 });
  const db = createAuthDb(pool);
  expect(await db.pendingLoginActive("poll-hash")).toBe(true);
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("FROM PENDING_LOGINS");
  expect(sql).toContain("POLL_TOKEN_HASH = $1");
  expect(sql).toContain("CONSUMED_AT IS NULL");
  expect(sql).toContain("EXPIRES_AT > NOW()");
  expect(calls[0].params).toEqual(["poll-hash"]);
  expect(await db.pendingLoginActive("missing")).toBe(false);
});

test("invalidatePendingLogins marks unconsumed rows for the email as consumed", async () => {
  const { pool, calls } = recorder();
  const db = createAuthDb(pool);
  await db.invalidatePendingLogins("jane@acme.com");
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("UPDATE PENDING_LOGINS SET CONSUMED_AT = NOW()");
  expect(sql).toContain("EMAIL = $1");
  expect(sql).toContain("CONSUMED_AT IS NULL");
  expect(calls[0].params).toEqual(["jane@acme.com"]);
});

test("cleanupExpiredPendingLogins deletes rows expired more than a day ago", async () => {
  const { pool, calls } = recorder();
  await createAuthDb(pool).cleanupExpiredPendingLogins();
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("DELETE FROM PENDING_LOGINS");
  expect(sql).toContain("EXPIRES_AT <");
});

test("pending_logins lifecycle (pg-mem): confirm then consume yields the email exactly once", async () => {
  const pool = await pendingLoginsPool();
  const db = createAuthDb(pool);
  await db.createPendingLogin({
    email: "jane@acme.com",
    pollTokenHash: "p",
    confirmTokenHash: "c",
    ttlSeconds: 86_400,
  });

  expect(await db.pendingLoginActive("p")).toBe(true);
  expect(await db.consumeConfirmedLogin("p")).toBeNull(); // not yet confirmed

  expect(await db.confirmPendingLogin("c")).toEqual({ email: "jane@acme.com" });
  expect(await db.confirmPendingLogin("c")).toBeNull(); // already confirmed

  expect(await db.consumeConfirmedLogin("p")).toEqual({ email: "jane@acme.com" }); // minted once
  expect(await db.consumeConfirmedLogin("p")).toBeNull(); // replay fails
  expect(await db.pendingLoginActive("p")).toBe(false);
});

test("invalidatePendingLogins (pg-mem) deactivates every unconsumed row for the email", async () => {
  const pool = await pendingLoginsPool();
  const db = createAuthDb(pool);
  await db.createPendingLogin({ email: "jane@acme.com", pollTokenHash: "p1", confirmTokenHash: "c1", ttlSeconds: 86_400 });
  await db.createPendingLogin({ email: "jane@acme.com", pollTokenHash: "p2", confirmTokenHash: "c2", ttlSeconds: 86_400 });
  await db.invalidatePendingLogins("jane@acme.com");
  expect(await db.pendingLoginActive("p1")).toBe(false);
  expect(await db.pendingLoginActive("p2")).toBe(false);
});

test("revokeTokensForAccount revokes the account's live tokens and returns how many", async () => {
  const { pool, calls, pushCount } = recorder();
  pushCount(3);
  const db = createAuthDb(pool);
  expect(await db.revokeTokensForAccount("acc-1")).toBe(3);
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("UPDATE AUTH_TOKENS SET REVOKED_AT = NOW()");
  expect(sql).toContain("ACCOUNT_ID = $1");
  expect(sql).toContain("REVOKED_AT IS NULL");
  expect(sql).not.toContain("SELECT");
  expect(sql).not.toContain("WHERE ID =");
  expect(calls[0].params).toEqual(["acc-1"]);
});

test("revokeTokensForAccount reports zero when the driver reports no rows", async () => {
  const { pool } = recorder();
  expect(await createAuthDb(pool).revokeTokensForAccount("acc-1")).toBe(0);
});

test("cleanupExpiredPendingLogins (pg-mem) deletes only rows expired more than a day ago", async () => {
  const pool = await pendingLoginsPool();
  await pool.query(
    `INSERT INTO pending_logins (email, poll_token_hash, confirm_token_hash, expires_at)
     VALUES ('old@acme.com', 'p-old', 'c-old', now() - interval '2 days')`,
  );
  await pool.query(
    `INSERT INTO pending_logins (email, poll_token_hash, confirm_token_hash, expires_at)
     VALUES ('fresh@acme.com', 'p-fresh', 'c-fresh', now() + interval '1 day')`,
  );
  const db = createAuthDb(pool);
  await db.cleanupExpiredPendingLogins();
  const r = await pool.query(`SELECT email FROM pending_logins`);
  expect(r.rows).toEqual([{ email: "fresh@acme.com" }]);
});
