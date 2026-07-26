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

/** All account/login/token IO behind one object, so the route handlers take one
 *  dep (matches the repo convention of a small injected IO surface). */
export interface AuthDb {
  createPendingLogin(
    input: { email: string; pollTokenHash: string; confirmTokenHash: string; ttlSeconds: number },
  ): Promise<void>;
  invalidatePendingLogins(email: string): Promise<void>;
  confirmPendingLogin(confirmTokenHash: string): Promise<{ email: string } | null>;
  pendingLoginByConfirmHash(confirmTokenHash: string): Promise<{ email: string; pollTokenHash: string } | null>;
  consumeConfirmedLogin(pollTokenHash: string): Promise<{ email: string } | null>;
  pendingLoginActive(pollTokenHash: string): Promise<boolean>;
  cleanupExpiredPendingLogins(): Promise<void>;
  upsertAccount(email: string): Promise<Account>;
  insertToken(tokenHash: string, accountId: string): Promise<void>;
  accountByToken(tokenHash: string): Promise<Account | null>;
  touchToken(tokenHash: string): Promise<void>;
  revokeToken(tokenHash: string): Promise<void>;
  ensurePersonalOrg(accountId: string, name: string): Promise<void>;
  getOrgsForAccount(accountId: string): Promise<OrgMembership[]>;
  billableOrgs(accountId: string): Promise<{ orgId: string; stripeCustomerId: string | null }[]>;
  orgBilling(orgId: string, accountId: string): Promise<{ stripeCustomerId: string | null; role: string } | null>;
  orgSeatCount(orgId: string): Promise<number>;
  setOrgStripeCustomer(orgId: string, customerId: string): Promise<void>;
  accountEmail(accountId: string): Promise<string>;
  createAgentToken(input: { orgId: string; installId: string; tokenHash: string }): Promise<void>;
  agentTokenByHash(hash: string): Promise<{ orgId: string; installId: string; revoked: boolean } | null>;
  orgStripeCustomer(orgId: string): Promise<string | null>;
}

const TOKEN_MAX_AGE = "1 year";

const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_lower_idx ON accounts (lower(email));

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
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_customer_id text;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_stripe_customer_idx
  ON organizations (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS memberships (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, account_id)
);
CREATE INDEX IF NOT EXISTS memberships_account_idx ON memberships (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_owner_idx ON memberships (org_id) WHERE role = 'owner';
CREATE TABLE IF NOT EXISTS agent_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text UNIQUE NOT NULL,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  install_id text NOT NULL,
  revoked    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_tokens_org_idx ON agent_tokens (org_id);
CREATE TABLE IF NOT EXISTS pending_logins (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL,
  poll_token_hash    text NOT NULL,
  confirm_token_hash text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  confirmed_at       timestamptz,
  consumed_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS pending_logins_poll_idx ON pending_logins (poll_token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS pending_logins_confirm_idx ON pending_logins (confirm_token_hash);
CREATE INDEX IF NOT EXISTS pending_logins_email_idx ON pending_logins (email);
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
  async function billableOrgs(accountId: string): Promise<{ orgId: string; stripeCustomerId: string | null }[]> {
    const r = await pool.query(
      `SELECT o.id AS org_id, o.stripe_customer_id
         FROM memberships m JOIN organizations o ON o.id = m.org_id
        WHERE m.account_id = $1`,
      [accountId],
    );
    return r.rows.map((x: { org_id: string; stripe_customer_id: string | null }) => ({
      orgId: x.org_id,
      stripeCustomerId: x.stripe_customer_id,
    }));
  }
  return {
    async createPendingLogin({ email, pollTokenHash, confirmTokenHash, ttlSeconds }) {
      await pool.query(
        `INSERT INTO pending_logins (email, poll_token_hash, confirm_token_hash, expires_at)
         VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
        [email, pollTokenHash, confirmTokenHash, String(ttlSeconds)],
      );
    },
    async invalidatePendingLogins(email) {
      await pool.query(
        `UPDATE pending_logins SET consumed_at = now()
         WHERE email = $1 AND consumed_at IS NULL`,
        [email],
      );
    },
    async confirmPendingLogin(confirmTokenHash) {
      const r = await pool.query(
        `UPDATE pending_logins SET confirmed_at = now()
         WHERE confirm_token_hash = $1 AND confirmed_at IS NULL
           AND consumed_at IS NULL AND expires_at > now()
         RETURNING email`,
        [confirmTokenHash],
      );
      const row = r.rows[0] as { email: string } | undefined;
      return row ? { email: row.email } : null;
    },
    async pendingLoginByConfirmHash(confirmTokenHash) {
      const r = await pool.query(
        `SELECT email, poll_token_hash FROM pending_logins
          WHERE confirm_token_hash = $1 AND confirmed_at IS NULL
            AND consumed_at IS NULL AND expires_at > now()
          LIMIT 1`,
        [confirmTokenHash],
      );
      const row = r.rows[0] as { email: string; poll_token_hash: string } | undefined;
      return row ? { email: row.email, pollTokenHash: row.poll_token_hash } : null;
    },
    async consumeConfirmedLogin(pollTokenHash) {
      const r = await pool.query(
        `UPDATE pending_logins SET consumed_at = now()
         WHERE poll_token_hash = $1 AND confirmed_at IS NOT NULL
           AND consumed_at IS NULL AND expires_at > now()
         RETURNING email`,
        [pollTokenHash],
      );
      const row = r.rows[0] as { email: string } | undefined;
      return row ? { email: row.email } : null;
    },
    async pendingLoginActive(pollTokenHash) {
      const r = await pool.query(
        `SELECT 1 AS ok FROM pending_logins
          WHERE poll_token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
          LIMIT 1`,
        [pollTokenHash],
      );
      return r.rows.length > 0;
    },
    async cleanupExpiredPendingLogins() {
      await pool.query(`DELETE FROM pending_logins WHERE expires_at < now() - interval '1 day'`);
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
    async orgBilling(orgId, accountId) {
      const r = await pool.query(
        `SELECT o.stripe_customer_id, m.role
           FROM organizations o JOIN memberships m ON m.org_id = o.id
          WHERE o.id = $1 AND m.account_id = $2`,
        [orgId, accountId],
      );
      if (r.rows.length === 0) return null;
      return { stripeCustomerId: r.rows[0].stripe_customer_id, role: r.rows[0].role };
    },
    async orgSeatCount(orgId) {
      const r = await pool.query(`SELECT count(*)::int AS n FROM memberships WHERE org_id = $1`, [orgId]);
      return Number(r.rows[0].n);
    },
    async setOrgStripeCustomer(orgId, customerId) {
      await pool.query(
        `UPDATE organizations SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL`,
        [customerId, orgId],
      );
    },
    async accountEmail(accountId) {
      const r = await pool.query(`SELECT email FROM accounts WHERE id = $1`, [accountId]);
      return r.rows[0].email;
    },
    async createAgentToken({ orgId, installId, tokenHash }) {
      await pool.query(
        `INSERT INTO agent_tokens (token_hash, org_id, install_id) VALUES ($1, $2, $3)`,
        [tokenHash, orgId, installId],
      );
    },
    async agentTokenByHash(hash) {
      const r = await pool.query(
        `SELECT org_id, install_id, revoked FROM agent_tokens WHERE token_hash = $1`,
        [hash],
      );
      const row = r.rows[0] as { org_id: string; install_id: string; revoked: boolean } | undefined;
      return row ? { orgId: row.org_id, installId: row.install_id, revoked: row.revoked } : null;
    },
    async orgStripeCustomer(orgId) {
      const r = await pool.query(`SELECT stripe_customer_id FROM organizations WHERE id = $1`, [orgId]);
      return (r.rows[0]?.stripe_customer_id as string | null) ?? null;
    },
    ensurePersonalOrg,
    getOrgsForAccount,
    billableOrgs,
  };
}
