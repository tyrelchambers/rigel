import type { Pool } from "pg";

export interface Account {
  id: string;
  email: string;
  name: string | null;
}

export interface OrgMembership {
  id: string;
  kind: "personal" | "team";
  name: string;
  role: "owner" | "admin" | "member";
}

/** All account/code/token IO behind one object, so the route handlers take one
 *  dep (matches the repo convention of a small injected IO surface). */
export interface AuthDb {
  insertCode(email: string, codeHash: string, linkTokenHash: string, ttlSeconds: number): Promise<void>;
  invalidateCodes(email: string): Promise<void>;
  claimAttempt(email: string): Promise<{ codeHash: string } | null>;
  consumeCode(email: string): Promise<boolean>;
  consumeLinkToken(linkTokenHash: string): Promise<{ email: string } | null>;
  cleanupExpiredCodes(): Promise<void>;
  upsertAccount(email: string): Promise<Account>;
  insertToken(tokenHash: string, accountId: string): Promise<void>;
  accountByToken(tokenHash: string): Promise<Account | null>;
  touchToken(tokenHash: string): Promise<void>;
  revokeToken(tokenHash: string): Promise<void>;
  ensurePersonalOrg(accountId: string, name: string): Promise<void>;
  getOrgsForAccount(accountId: string): Promise<OrgMembership[]>;
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
ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS link_token_hash text;
CREATE INDEX IF NOT EXISTS login_codes_link_idx ON login_codes (link_token_hash);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash   text PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS auth_tokens_account_idx ON auth_tokens (account_id);

CREATE TABLE IF NOT EXISTS organizations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('personal','team')),
  name                text NOT NULL,
  personal_account_id uuid UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'personal') = (personal_account_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS memberships (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, account_id)
);
CREATE INDEX IF NOT EXISTS memberships_account_idx ON memberships (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_owner_idx ON memberships (org_id) WHERE role = 'owner';
INSERT INTO organizations (kind, name, personal_account_id)
  SELECT 'personal', coalesce(name, email), id FROM accounts a
  WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.personal_account_id = a.id)
  ON CONFLICT (personal_account_id) DO NOTHING;
INSERT INTO memberships (org_id, account_id, role)
  SELECT o.id, o.personal_account_id, 'owner' FROM organizations o
  WHERE o.kind = 'personal' AND o.personal_account_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.account_id = o.personal_account_id)
  ON CONFLICT (org_id, account_id) DO NOTHING;`;

export async function ensureAuthSchema(pool: Pool): Promise<void> {
  await pool.query(AUTH_SCHEMA);
}

export function createAuthDb(pool: Pool): AuthDb {
  async function ensurePersonalOrg(accountId: string, name: string): Promise<void> {
    await pool.query(
      `INSERT INTO organizations (kind, name, personal_account_id)
       VALUES ('personal', $2, $1) ON CONFLICT (personal_account_id) DO NOTHING`,
      [accountId, name],
    );
    await pool.query(
      `INSERT INTO memberships (org_id, account_id, role)
       SELECT id, personal_account_id, 'owner' FROM organizations
       WHERE personal_account_id = $1
       ON CONFLICT (org_id, account_id) DO NOTHING`,
      [accountId],
    );
  }
  async function getOrgsForAccount(accountId: string): Promise<OrgMembership[]> {
    const r = await pool.query(
      `SELECT o.id, o.kind, o.name, m.role
       FROM memberships m JOIN organizations o ON o.id = m.org_id
       WHERE m.account_id = $1
       ORDER BY (o.kind = 'personal') DESC, o.name`,
      [accountId],
    );
    return r.rows as OrgMembership[];
  }
  return {
    async insertCode(email, codeHash, linkTokenHash, ttlSeconds) {
      await pool.query(
        `INSERT INTO login_codes (email, code_hash, link_token_hash, expires_at)
         VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
        [email, codeHash, linkTokenHash, String(ttlSeconds)],
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
      const account = r.rows[0] as Account;
      await ensurePersonalOrg(account.id, account.name ?? account.email);
      return account;
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
    ensurePersonalOrg,
    getOrgsForAccount,
  };
}
