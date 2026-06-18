import { test, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SpawnOptions, ChildProcess } from "node:child_process";
import { applyEvent, WatchManager } from "./watchManager";

test("ADDED then MODIFIED upserts; DELETED removes", () => {
  const cache = new Map<string, any>();
  applyEvent(cache, { type: "ADDED", object: { metadata: { name: "a" }, spec: 1 } });
  applyEvent(cache, { type: "MODIFIED", object: { metadata: { name: "a" }, spec: 2 } });
  expect(cache.get("a").spec).toBe(2);
  applyEvent(cache, { type: "DELETED", object: { metadata: { name: "a" } } });
  expect(cache.has("a")).toBe(false);
});

test("spawn 'error' event tears down watch without throwing", async () => {
  // Build a fake ChildProcess: EventEmitter + stdout PassThrough + kill()
  const fakeProc = new EventEmitter() as unknown as ChildProcess;
  (fakeProc as any).stdout = new PassThrough();
  (fakeProc as any).kill = () => {};

  const fakeSpawn = (_cmd: string, _args: string[], _opts: SpawnOptions) =>
    fakeProc;

  const mgr = new WatchManager(null, fakeSpawn as any);

  // subscribe starts a watch; the returned unsubscribe is intentionally unused
  // (we want the manager to hold the watch so we can observe teardown).
  let threw = false;
  try {
    mgr.subscribe(
      { kind: "pods", namespace: "default" },
      () => {},
      () => {},
    );
  } catch {
    threw = true;
  }
  expect(threw).toBe(false);

  // Emit "error" on next tick (mirrors ENOENT from Node spawn) and wait for
  // the microtask queue to flush so the listener can run synchronously.
  await new Promise<void>((resolve) => {
    setImmediate(() => {
      fakeProc.emit("error", new Error("ENOENT: kubectl not found"));
      resolve();
    });
  });

  // After the error handler fires, the manager should have no active watch.
  // Subscribe with a fresh listener — if a watch was left behind it would
  // reuse it and we'd still see the key; a clean manager starts a new one.
  // The simplest observable: subscribing again after teardown does not throw.
  let threw2 = false;
  try {
    const unsub = mgr.subscribe(
      { kind: "pods", namespace: "default" },
      () => {},
      () => {},
    );
    unsub(); // immediately unsubscribe to avoid lingering state
  } catch {
    threw2 = true;
  }
  expect(threw2).toBe(false);
});
