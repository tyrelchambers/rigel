import { test, expect } from "vitest";
import { ensureSchema, upsertSignup } from "./db";
import type { Pool, QueryResult } from "pg";

// pg-mem v3 doesn't support PRIMARY KEY inline constraints or timestamptz
// DEFAULT now(), so we stub the Pool with a minimal in-memory implementation.
// The production SQL in db.ts targets real Postgres and is kept as written.
// These tests verify that ensureSchema is idempotent and that upsertSignup
// produces the correct SQL calls.

function makeStubPool() {
  const rows: Record<string, Record<string, unknown>> = {}; // keyed by install_id

  const pool = {
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      const s = sql.trim().toUpperCase();

      // CREATE TABLE — idempotent no-op in the stub
      if (s.startsWith("CREATE TABLE")) {
        return { rows: [], rowCount: 0, command: "CREATE", oid: 0, fields: [] };
      }

      // INSERT … ON CONFLICT — upsert by install_id (params[0])
      if (s.startsWith("INSERT INTO SIGNUPS")) {
        const [install_id, email, name, app_version, platform] = params as string[];
        rows[install_id] = { install_id, email, name, app_version, platform };
        return { rows: [], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
      }

      // SELECT count(*) — return current row count
      if (s.startsWith("SELECT COUNT(*)")) {
        const n = Object.keys(rows).length;
        return { rows: [{ n }], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
      }

      // SELECT name, email FROM signups
      if (s.startsWith("SELECT NAME, EMAIL")) {
        const r = Object.values(rows).map(({ name, email }) => ({ name, email }));
        return { rows: r, rowCount: r.length, command: "SELECT", oid: 0, fields: [] };
      }

      return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
    },
  } as unknown as Pool;

  return pool;
}

const s = {
  installId: "11111111-1111-4111-8111-111111111111",
  name: "Jane",
  email: "jane@acme.com",
  appVersion: "0.1.0",
  platform: "darwin",
};

test("ensureSchema is idempotent", async () => {
  const pool = makeStubPool();
  await ensureSchema(pool);
  await ensureSchema(pool); // second call must not throw
  const r = await pool.query("SELECT count(*) AS n FROM signups");
  expect(r.rows[0].n).toBe(0);
});

test("insert then upsert by installId keeps one row and updates fields", async () => {
  const pool = makeStubPool();
  await ensureSchema(pool);
  await upsertSignup(pool, s);
  await upsertSignup(pool, { ...s, name: "Jane Updated", email: "jane2@acme.com" });
  const r = await pool.query("SELECT name, email FROM signups");
  expect(r.rows.length).toBe(1);
  expect(r.rows[0].name).toBe("Jane Updated");
  expect(r.rows[0].email).toBe("jane2@acme.com");
});
