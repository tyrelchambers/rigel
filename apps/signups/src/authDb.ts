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
  claimAttempt(email: string): Promise<{ codeHash: string } | null>;
  consumeCode(email: string): Promise<boolean>;
  cleanupExpiredCodes(): Promise<void>;
  upsertAccount(email: string): Promise<Account>;
  insertToken(tokenHash: string, accountId: string): Promise<void>;
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
      return r.rows.length > 0;
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
