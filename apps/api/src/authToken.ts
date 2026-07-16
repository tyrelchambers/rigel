import { createHash } from "node:crypto";

/** SHA-256 hex of a token — bearer tokens are stored hashed at rest. */
export const sha = (v: string): string => createHash("sha256").update(v).digest("hex");

/** Extract the bearer token from an Authorization header (case-insensitive, trimmed). */
export function bearer(c: { req: { header: (k: string) => string | undefined } }): string | null {
  const h = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}
