import { timingSafeEqual } from "node:crypto";

/** Local-access-control check. When `expected` is empty the gate is DISABLED
 *  (allow-all) — used in web-dev and before the desktop delivers a secret. */
export function checkSessionSecret(provided: string | null | undefined, expected: string): boolean {
  if (!expected) return true;
  if (typeof provided !== "string" || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
