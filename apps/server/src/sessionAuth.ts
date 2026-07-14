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

/** Full gate: valid session secret AND (when the gate is active) signed-in.
 *  The account requirement only applies when a secret is configured (desktop);
 *  in web-dev/Docker (`expected` empty) everything is allowed. */
export function accessAllowed(provided: string | null | undefined, expected: string, signedIn: boolean): boolean {
  if (!checkSessionSecret(provided, expected)) return false;
  if (expected && !signedIn) return false;
  return true;
}
