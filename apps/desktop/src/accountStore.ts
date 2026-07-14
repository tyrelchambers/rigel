import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The slice of Electron's safeStorage we depend on (injected so this module
 *  stays electron-free and unit-testable, like installStore/signup). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class AccountStore {
  private file: string;
  private safe: SafeStorageLike;
  readonly available: boolean;
  constructor(userDataDir: string, safe: SafeStorageLike) {
    this.file = join(userDataDir, "rigel-account.bin");
    this.safe = safe;
    this.available =
      safe.isEncryptionAvailable() && safe.getSelectedStorageBackend?.() !== "basic_text";
  }
  getToken(): string | null {
    if (!this.available) return null;
    try {
      const b64 = readFileSync(this.file, "utf8");
      return this.safe.decryptString(Buffer.from(b64, "base64"));
    } catch {
      return null;
    }
  }
  setToken(token: string): void {
    if (!this.available) throw new Error("secure storage unavailable");
    const enc = this.safe.encryptString(token);
    writeFileSync(this.file, enc.toString("base64"), { mode: 0o600 });
  }
  clear(): void {
    try { rmSync(this.file, { force: true }); } catch { /* already gone */ }
  }
}
