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
