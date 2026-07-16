import type { Pool } from "pg";
import type { Signup } from "./validate";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS signups (
  install_id  uuid PRIMARY KEY,
  email       text NOT NULL,
  name        text NOT NULL,
  app_version text,
  platform    text,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now()
);`;

export async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(SCHEMA);
}

export async function upsertSignup(pool: Pool, s: Signup): Promise<void> {
  await pool.query(
    `INSERT INTO signups (install_id, email, name, app_version, platform)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (install_id) DO UPDATE SET
       email       = EXCLUDED.email,
       name        = EXCLUDED.name,
       app_version = EXCLUDED.app_version,
       platform    = EXCLUDED.platform,
       last_seen   = now();`,
    [s.installId, s.email, s.name, s.appVersion, s.platform],
  );
}
