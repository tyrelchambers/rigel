import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

/** The slice of Electron's safeStorage we depend on (injected so this module
 *  stays electron-free and unit-testable, like installStore/signup). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** An in-flight device-authorization sign-in: the app polls `pollToken` until
 *  the user confirms the emailed link, or `expiresAt` passes. */
export interface PendingLogin {
  pollToken: string;
  displayCode: string;
  email: string;
  startedAt: number;
  expiresAt: number;
}

export class AccountStore {
  private tokenFile: string;
  private pendingFile: string;
  private safe: SafeStorageLike;
  private cachedAvailable: boolean | undefined;
  constructor(userDataDir: string, safe: SafeStorageLike) {
    this.tokenFile = join(userDataDir, "rigel-account.bin");
    this.pendingFile = join(userDataDir, "rigel-pending-login.bin");
    this.safe = safe;
  }
  get available(): boolean {
    if (this.cachedAvailable === undefined) {
      this.cachedAvailable =
        this.safe.isEncryptionAvailable() && this.safe.getSelectedStorageBackend?.() !== "basic_text";
    }
    return this.cachedAvailable;
  }
  private read(file: string): string | null {
    if (!this.available) return null;
    try {
      const b64 = readFileSync(file, "utf8");
      return this.safe.decryptString(Buffer.from(b64, "base64"));
    } catch {
      return null;
    }
  }
  private write(file: string, value: string): void {
    if (!this.available) throw new Error("secure storage unavailable");
    writeFileSync(file, this.safe.encryptString(value).toString("base64"), { mode: 0o600 });
  }
  private remove(file: string): void {
    try { rmSync(file, { force: true }); } catch { /* already gone */ }
  }
  hasToken(): boolean {
    return existsSync(this.tokenFile);
  }
  getToken(): string | null {
    return this.read(this.tokenFile);
  }
  setToken(token: string): void {
    this.write(this.tokenFile, token);
  }
  clear(): void {
    this.remove(this.tokenFile);
  }
  getPending(): PendingLogin | null {
    const raw = this.read(this.pendingFile);
    if (raw === null) return null;
    try {
      const p = JSON.parse(raw) as PendingLogin;
      if (typeof p?.pollToken !== "string" || typeof p?.displayCode !== "string" || typeof p?.expiresAt !== "number") return null;
      return p;
    } catch {
      return null;
    }
  }
  setPending(pending: PendingLogin): void {
    this.write(this.pendingFile, JSON.stringify(pending));
  }
  clearPending(): void {
    this.remove(this.pendingFile);
  }
}
