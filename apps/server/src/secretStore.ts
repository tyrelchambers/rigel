// At-rest codec for Rigel-managed secrets (agent API keys, the Claude OAuth token).
//
// Stored values carry an "enc:v1:" marker when they were encrypted with the OS
// keychain via Electron's safeStorage (macOS Keychain / Windows Credential Manager
// / libsecret). Real encryption ONLY happens in the Electron desktop, where the
// server runs inside the utility process and `require("electron").safeStorage` is
// available. In dev/tests (plain Node via tsx) electron is absent, so we fall back
// to PLAINTEXT — encrypt is a passthrough and a value without the marker is read
// as-is. This keeps existing plaintext keys/tokens (no marker) loading unchanged.
//
// encrypt/decrypt never throw: a missing `electron` module or an unavailable
// keychain degrades to the plaintext path. The one exception is decrypting a
// MARKED value when no keychain is present — there we return "" so the caller
// surfaces "not connected" rather than passing an encrypted blob as a key.
import { createRequire } from "node:module";

const MARKER = "enc:v1:";

interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(buf: Buffer): string;
}

let cachedSafeStorage: SafeStorage | null | undefined;

/**
 * Lazily resolve Electron's safeStorage, treating it as usable only when the OS
 * keychain is actually available. `electron` is loaded dynamically via
 * createRequire (precedent: claudeBridge.ts, guardedKubectl.ts) so the bundled
 * server can require it from the Electron utility process at runtime while plain
 * Node (dev/tests) — where the module is absent — falls through to null. Cached
 * after the first attempt. Anything going wrong → null (plaintext path).
 */
function safeStorage(): SafeStorage | null {
  if (cachedSafeStorage !== undefined) return cachedSafeStorage;
  try {
    const require = createRequire(import.meta.url);
    const electron = require("electron") as { safeStorage?: SafeStorage } | undefined;
    const ss = electron?.safeStorage;
    cachedSafeStorage = ss && ss.isEncryptionAvailable() ? ss : null;
  } catch {
    cachedSafeStorage = null;
  }
  return cachedSafeStorage;
}

/** Encrypt with the OS keychain when available; otherwise return `plain` as-is
 *  (plaintext fallback). Empty/whitespace input is returned unchanged. */
export function encryptSecret(plain: string): string {
  if (!plain.trim()) return plain;
  try {
    const ss = safeStorage();
    if (!ss) return plain;
    return MARKER + ss.encryptString(plain).toString("base64");
  } catch {
    return plain;
  }
}

/** Decrypt a stored value. A "enc:v1:"-marked value needs the keychain: if it is
 *  unavailable (dev/tests), return "" so the caller treats it as "not connected"
 *  instead of leaking an encrypted blob. An UNMARKED value is plaintext/legacy and
 *  is returned as-is (backward compatible). */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(MARKER)) return stored;
  try {
    const ss = safeStorage();
    if (!ss) return "";
    return ss.decryptString(Buffer.from(stored.slice(MARKER.length), "base64"));
  } catch {
    return "";
  }
}
