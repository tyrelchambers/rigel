import { createHash, timingSafeEqual } from "node:crypto";

/** The complete gate on local `/api/*` + `/ws`: proof that the caller is this
 *  app's own renderer and not another process on the machine. When `expected` is
 *  empty the gate is DISABLED (allow-all) — used in web-dev and before the
 *  desktop delivers a secret. Both sides are hashed before comparison so a
 *  multibyte/attacker-controlled header can never mismatch the buffer
 *  byte-length inside timingSafeEqual.
 *
 *  Deliberately independent of account state. Local cluster access is free and
 *  needs no sign-in; paid gating lives on cloud connect, audits and
 *  right-sizing, keyed off the entitlement, not on this check. */
export function checkSessionSecret(provided: string | null | undefined, expected: string): boolean {
  if (!expected) return true;
  if (typeof provided !== "string") return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
