import { createHash } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The code the app displays while waiting and the confirm page shows for the
 *  human to match. Derived from the poll-token hash, so both sides compute the
 *  same string with no extra column and no second secret. Crockford's alphabet
 *  drops I, L, O and U so nothing is misread when comparing character by
 *  character. */
export function displayCodeFor(pollTokenHash: string): string {
  const digest = createHash("sha256").update(`rigel-display:${pollTokenHash}`).digest();
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[digest[i] % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}
