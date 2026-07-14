import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, type SafeStorageLike } from "./accountStore";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rigel-account-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// Fake safeStorage: "encrypts" by prefixing, so we can assert round-trips.
function fakeSafe(over: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptString: (s: string) => Buffer.from("enc:" + s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
    ...over,
  };
}

test("round-trips a token, persists across instances", () => {
  const a = new AccountStore(dir, fakeSafe());
  expect(a.available).toBe(true);
  a.setToken("tok-123");
  expect(a.getToken()).toBe("tok-123");
  expect(new AccountStore(dir, fakeSafe()).getToken()).toBe("tok-123"); // reloaded from disk
});

test("clear removes the token", () => {
  const a = new AccountStore(dir, fakeSafe());
  a.setToken("tok-123");
  a.clear();
  expect(a.getToken()).toBeNull();
  expect(new AccountStore(dir, fakeSafe()).getToken()).toBeNull();
});

test("getToken is null when nothing stored", () => {
  expect(new AccountStore(dir, fakeSafe()).getToken()).toBeNull();
});

test("fails closed when encryption unavailable", () => {
  const a = new AccountStore(dir, fakeSafe({ isEncryptionAvailable: () => false }));
  expect(a.available).toBe(false);
  expect(() => a.setToken("tok")).toThrow();
  expect(a.getToken()).toBeNull();
});

test("fails closed on the Linux basic_text backend (obfuscation, not encryption)", () => {
  const a = new AccountStore(dir, fakeSafe({ getSelectedStorageBackend: () => "basic_text" }));
  expect(a.available).toBe(false);
  expect(() => a.setToken("tok")).toThrow();
});

test("a corrupt/undecryptable file reads as null, not a crash", () => {
  // write a token with a working safe, then read with a throwing decrypt
  new AccountStore(dir, fakeSafe()).setToken("tok");
  const a = new AccountStore(dir, fakeSafe({ decryptString: () => { throw new Error("bad"); } }));
  expect(a.getToken()).toBeNull();
});
