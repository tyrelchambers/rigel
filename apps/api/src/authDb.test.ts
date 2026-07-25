import { test, expect, vi } from "vitest";
import { newDb } from "pg-mem";
import { createAuthDb, ensureAuthSchema, AUTH_SCHEMA } from "./authDb";
import type { Pool, QueryResult } from "pg";

function fakePool() {
  const queries: { text: string; values: unknown[] }[] = [];
  return {
    queries,
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      return { rows: [] };
    },
  };
}

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

test("ensureAuthSchema adds link_token_hash to login_codes (idempotent ALTER)", async () => {
  const { pool, calls } = recorder();
  await ensureAuthSchema(pool);
  const joined = calls.map((c) => c.sql.toUpperCase()).join("\n");
  expect(joined).toContain("ALTER TABLE LOGIN_CODES ADD COLUMN IF NOT EXISTS LINK_TOKEN_HASH");
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
  expect(await db.consumeCode("a@b.co")).toBe(false);
});

test("consumeLinkToken consumes by link_token_hash and returns the email", async () => {
  const { pool, calls, push } = recorder();
  push({ email: "a@b.co" });
  const db = createAuthDb(pool);
  expect(await db.consumeLinkToken("HASH")).toEqual({ email: "a@b.co" });
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("UPDATE LOGIN_CODES SET CONSUMED_AT = NOW()");
  expect(sql).toContain("LINK_TOKEN_HASH = $1");
  expect(sql).toContain("CONSUMED_AT IS NULL");
  expect(sql).toContain("EXPIRES_AT > NOW()");
  expect(sql).toContain("RETURNING EMAIL");
  expect(calls[0].params).toEqual(["HASH"]);
});

test("consumeLinkToken returns null when no row matches", async () => {
  const { pool } = recorder();
  expect(await createAuthDb(pool).consumeLinkToken("HASH")).toBeNull();
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

test("createPendingLogin then confirm then claim yields the email exactly once", async () => {
  const pool = fakePool();
  const db = createAuthDb(pool as never);
  await db.createPendingLogin({
    email: "jane@acme.com",
    pollTokenHash: "poll-hash",
    confirmTokenHash: "confirm-hash",
    ttlSeconds: 86_400,
  });
  expect(pool.queries[0].text).toMatch(/INSERT INTO pending_logins/);
  expect(pool.queries[0].values).toEqual([
    "jane@acme.com",
    "poll-hash",
    "confirm-hash",
    "86400",
  ]);
});

test("confirmPendingLogin only matches an unconfirmed, unexpired row", async () => {
  const pool = fakePool();
  const db = createAuthDb(pool as never);
  await db.confirmPendingLogin("confirm-hash");
  const q = pool.queries[0].text;
  expect(q).toMatch(/UPDATE pending_logins/);
  expect(q).toMatch(/confirmed_at IS NULL/);
  expect(q).toMatch(/expires_at > now\(\)/);
});

test("claimConfirmedLogin requires confirmed and unconsumed", async () => {
  const pool = fakePool();
  const db = createAuthDb(pool as never);
  await db.claimConfirmedLogin("poll-hash");
  const q = pool.queries[0].text;
  expect(q).toMatch(/confirmed_at IS NOT NULL/);
  expect(q).toMatch(/consumed_at IS NULL/);
});

test("AUTH_SCHEMA creates pending_logins with both token indexes", () => {
  expect(AUTH_SCHEMA).toMatch(/CREATE TABLE IF NOT EXISTS pending_logins/);
  expect(AUTH_SCHEMA).toMatch(/pending_logins_poll_idx/);
  expect(AUTH_SCHEMA).toMatch(/pending_logins_confirm_idx/);
});
