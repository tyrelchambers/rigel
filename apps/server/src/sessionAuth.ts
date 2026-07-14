import { createHash, timingSafeEqual } from "node:crypto";

/** Local-access-control check. When `expected` is empty the gate is DISABLED
 *  (allow-all) — used in web-dev and before the desktop delivers a secret.
 *  Both sides are hashed before comparison so a multibyte/attacker-controlled
 *  header can never mismatch the buffer byte-length inside timingSafeEqual. */
export function checkSessionSecret(provided: string | null | undefined, expected: string): boolean {
  if (!expected) return true;
  if (typeof provided !== "string") return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
