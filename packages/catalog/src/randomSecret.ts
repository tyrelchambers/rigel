// Locally-generated strong secret values — port of Sources/Helmsman/Catalog/RandomSecret.swift.
// Alphanumeric/hex only, to stay safe inside YAML scalars and shell args. Used
// to pre-fill the install wizard's detected secret placeholders.

import type { SecretFormat } from "./types";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX_ALPHABET = "0123456789abcdef";

/** Cryptographically-random index in [0, n). Uses Web Crypto (browser + Bun). */
function randomIndex(n: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}

/** Generate a random secret value. Mirrors Swift `RandomSecret.generate`. */
export function generateSecret(length = 32, format: SecretFormat = "alphanumeric"): string {
  const n = Math.max(1, length);
  const chars = format === "hex" ? HEX_ALPHABET : ALPHABET;
  let out = "";
  for (let i = 0; i < n; i++) {
    out += chars[randomIndex(chars.length)];
  }
  return out;
}
