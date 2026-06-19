import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstallStore } from "./installStore";
import { submitSignup, deliver } from "./signup";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rigel-signup-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const okFetch = async () => ({ ok: true }) as Response;
const failFetch = async () => { throw new Error("offline"); };

test("submit captures + delivers; pending cleared on 2xx", async () => {
  const s = new InstallStore(dir);
  let posted = 0;
  const fetchFn = (async (_u: string, init: RequestInit) => { posted++; return { ok: true } as Response; }) as typeof fetch;
  const r = await submitSignup(s, fetchFn, "https://api", "key", "Jane", "j@x.com", "0.1.0", "darwin");
  expect(r.ok).toBe(true);
  expect(s.captured).toBe(true);
  expect(posted).toBe(1);
  expect(s.pending).toBeNull();
});

test("submit still captures when delivery fails; pending kept for retry", async () => {
  const s = new InstallStore(dir);
  const r = await submitSignup(s, failFetch as unknown as typeof fetch, "https://api", "key", "Jane", "j@x.com", "0.1.0", "darwin");
  expect(r.ok).toBe(true);     // user is NOT blocked
  expect(s.captured).toBe(true);
  expect(s.pending).not.toBeNull();
});

test("deliver clears pending on success and is a no-op with no pending", async () => {
  const s = new InstallStore(dir);
  expect(await deliver(s, okFetch as unknown as typeof fetch, "https://api", "key")).toBe(true); // no pending
  s.setCapturedWithPending({ installId: s.installId, name: "J", email: "j@x.com", appVersion: "0", platform: "d" });
  expect(await deliver(s, okFetch as unknown as typeof fetch, "https://api", "key")).toBe(true);
  expect(s.pending).toBeNull();
});
