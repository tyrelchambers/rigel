import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstallStore } from "./installStore";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rigel-install-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("generates a stable installId persisted across instances", () => {
  const a = new InstallStore(dir);
  const id = a.installId;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(new InstallStore(dir).installId).toBe(id); // reloaded
});

test("starts uncaptured; setCapturedWithPending flips captured + stores pending; clearPending clears", () => {
  const s = new InstallStore(dir);
  expect(s.captured).toBe(false);
  const payload = { installId: s.installId, name: "J", email: "j@x.com", appVersion: "0", platform: "darwin" };
  s.setCapturedWithPending(payload);
  expect(s.captured).toBe(true);
  expect(new InstallStore(dir).pending).toEqual(payload); // persisted
  s.clearPending();
  expect(new InstallStore(dir).pending).toBeNull();
  expect(new InstallStore(dir).captured).toBe(true); // captured stays
});

test("setCapturedWithPending stores a durable profile that survives clearPending", () => {
  const s = new InstallStore(dir);
  s.setCapturedWithPending({ installId: s.installId, name: "Tyrel", email: "t@x.com", appVersion: "1", platform: "darwin" });
  expect(s.profile).toEqual({ name: "Tyrel", email: "t@x.com" });
  s.clearPending();
  expect(new InstallStore(dir).profile).toEqual({ name: "Tyrel", email: "t@x.com" }); // survives delivery
  expect(new InstallStore(dir).pending).toBeNull();
});

test("backfills profile from legacy pending when the profile field is absent", () => {
  writeFileSync(join(dir, "rigel-install.json"), JSON.stringify({
    installId: "x", captured: true,
    pending: { installId: "x", name: "Old", email: "o@x.com", appVersion: "1", platform: "linux" },
  }));
  expect(new InstallStore(dir).profile).toEqual({ name: "Old", email: "o@x.com" });
});

test("profile is null on a fresh store", () => {
  expect(new InstallStore(dir).profile).toBeNull();
});
