import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("constructing does not probe safeStorage (availability is lazy)", () => {
  let probes = 0;
  const safe = fakeSafe({ isEncryptionAvailable: () => { probes++; return true; } });
  const a = new AccountStore(dir, safe);
  expect(probes).toBe(0);
  expect(a.available).toBe(true);
  expect(a.available).toBe(true);
  expect(probes).toBe(1);
});

test("hasToken reflects file presence without decrypting", () => {
  let decrypts = 0;
  const a = new AccountStore(dir, fakeSafe({ decryptString: (b) => { decrypts++; return b.toString("utf8").replace(/^enc:/, ""); } }));
  expect(a.hasToken()).toBe(false);
  a.setToken("tok");
  expect(a.hasToken()).toBe(true);
  a.clear();
  expect(a.hasToken()).toBe(false);
  expect(decrypts).toBe(0);
});

test("a corrupt/undecryptable file reads as null, not a crash", () => {
  // write a token with a working safe, then read with a throwing decrypt
  new AccountStore(dir, fakeSafe()).setToken("tok");
  const a = new AccountStore(dir, fakeSafe({ decryptString: () => { throw new Error("bad"); } }));
  expect(a.getToken()).toBeNull();
});

test("pending login round-trips through safeStorage", () => {
  const store = new AccountStore(dir, fakeSafe());
  expect(store.getPending()).toBeNull();

  store.setPending({ pollToken: "poll-abc", displayCode: "WX7Q", email: "jane@acme.com", startedAt: 1000, expiresAt: 90_000 });
  expect(store.getPending()).toEqual({
    pollToken: "poll-abc", displayCode: "WX7Q", email: "jane@acme.com", startedAt: 1000, expiresAt: 90_000,
  });

  store.clearPending();
  expect(store.getPending()).toBeNull();
});

test("pending login lives in its own file, so clear() does not drop the token", () => {
  const store = new AccountStore(dir, fakeSafe());
  store.setToken("bearer-1");
  store.setPending({ pollToken: "poll-abc", displayCode: "WX7Q", email: "jane@acme.com", startedAt: 0, expiresAt: 1 });

  store.clear();
  expect(store.getToken()).toBeNull();
  expect(store.getPending()).not.toBeNull();

  store.clearPending();
  expect(store.getPending()).toBeNull();
});

test("getPending returns null on corrupt contents rather than throwing", () => {
  const store = new AccountStore(dir, fakeSafe());
  writeFileSync(join(dir, "rigel-pending-login.bin"), "not-base64-json");
  expect(store.getPending()).toBeNull();
});

test("getPending rejects a record missing displayCode rather than surfacing undefined", () => {
  const safe = fakeSafe();
  const file = join(dir, "rigel-pending-login.bin");
  writeFileSync(
    file,
    safe.encryptString(JSON.stringify({ pollToken: "poll-abc", email: "jane@acme.com", startedAt: 0, expiresAt: 90_000 })).toString("base64"),
  );
  expect(new AccountStore(dir, safe).getPending()).toBeNull();
});
