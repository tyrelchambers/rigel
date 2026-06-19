import { test, expect, vi } from "vitest";
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

// ── Fake spawn harness ──────────────────────────────────────────────────────
// Each spawned kubectl is a fake ChildProcess (EventEmitter + stdout + kill()).
// We distinguish the one-shot LIST (`get ... -o json` WITHOUT --watch-only)
// from the delta stream (`--watch-only`) so a test can drive each one.

type FakeProc = ChildProcess & {
  isList: boolean;
  isWatch: boolean;
  args: string[];
  killed: boolean;
  // LIST helper: push a `{items:[...]}` body and finish the process.
  emitList(items: any[]): void;
  // LIST failure helper: empty stderr + non-zero exit (e.g. NotFound).
  emitListError(code?: number): void;
};

function makeFakeProc(args: string[]): FakeProc {
  const proc = new EventEmitter() as unknown as FakeProc;
  (proc as any).stdout = new PassThrough();
  proc.args = args;
  proc.isWatch = args.includes("--watch-only");
  // A LIST is a `get ... -o json` that is NOT the watch stream.
  proc.isList = !proc.isWatch && args.includes("get");
  proc.killed = false;
  (proc as any).kill = () => {
    proc.killed = true;
    return true;
  };
  proc.emitList = (items: any[]) => {
    (proc as any).stdout.write(JSON.stringify({ items }));
    proc.emit("exit", 0, null);
    proc.emit("close", 0, null);
  };
  proc.emitListError = (code = 1) => {
    proc.emit("exit", code, null);
    proc.emit("close", code, null);
  };
  return proc;
}

// A spawn recorder: keeps every fake proc so the test can find the LIST/watch.
function makeRecorder() {
  const procs: FakeProc[] = [];
  const spawnFn = (_cmd: string, args: string[], _opts: SpawnOptions) => {
    const p = makeFakeProc(args);
    procs.push(p);
    return p as unknown as ChildProcess;
  };
  return {
    spawnFn,
    procs,
    lists: () => procs.filter((p) => p.isList),
    watches: () => procs.filter((p) => p.isWatch),
    lastList: () => procs.filter((p) => p.isList).at(-1)!,
    lastWatch: () => procs.filter((p) => p.isWatch).at(-1)!,
  };
}

const pod = (name: string) => ({ metadata: { name } });

// (a) A cold subscribe LISTs first, then emits a snapshot with the listed items.
test("cold subscribe LISTs then emits a snapshot with the listed items", async () => {
  const rec = makeRecorder();
  const mgr = new WatchManager(null, rec.spawnFn as any);

  const snapshots: any[][] = [];
  mgr.subscribe({ kind: "pods", namespace: "default" }, (items) => snapshots.push(items), () => {});

  // The first thing spawned is the LIST, not the watch stream.
  expect(rec.lists().length).toBe(1);
  expect(rec.watches().length).toBe(0);

  // Complete the LIST with two pods.
  rec.lastList().emitList([pod("a"), pod("b")]);
  await new Promise((r) => setImmediate(r));

  // Snapshot carries the listed items, and the watch-only stream is now running.
  expect(snapshots.length).toBe(1);
  expect(snapshots[0].map((p) => p.metadata.name).sort()).toEqual(["a", "b"]);
  expect(rec.watches().length).toBe(1);
});

// (b) Last listener leaving does NOT stop immediately, but DOES stop after the
//     idle TTL with no new subscriber.
test("leaving keeps the warm watch until the idle TTL fires", async () => {
  vi.useFakeTimers();
  try {
    const rec = makeRecorder();
    const mgr = new WatchManager(null, rec.spawnFn as any, { idleTtlMs: 1000 });

    const unsub = mgr.subscribe({ kind: "pods", namespace: "default" }, () => {}, () => {});
    rec.lastList().emitList([pod("a")]);
    await vi.advanceTimersByTimeAsync(0);

    const watch = rec.lastWatch();
    unsub();

    // Not stopped immediately — still warm.
    expect(watch.killed).toBe(false);

    // After the TTL with no new subscriber, the watch is stopped.
    await vi.advanceTimersByTimeAsync(1000);
    expect(watch.killed).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

// (c) A new subscriber during the idle window cancels teardown and gets a warm
//     snapshot with NO new spawn.
test("a new subscriber during the idle window keeps the warm watch (no respawn)", async () => {
  vi.useFakeTimers();
  try {
    const rec = makeRecorder();
    const mgr = new WatchManager(null, rec.spawnFn as any, { idleTtlMs: 1000 });

    const unsub = mgr.subscribe({ kind: "pods", namespace: "default" }, () => {}, () => {});
    rec.lastList().emitList([pod("a")]);
    await vi.advanceTimersByTimeAsync(0);

    const watch = rec.lastWatch();
    const spawnsBefore = rec.procs.length;
    unsub();

    // Re-subscribe within the idle window.
    await vi.advanceTimersByTimeAsync(500);
    const snapshots: any[][] = [];
    mgr.subscribe({ kind: "pods", namespace: "default" }, (items) => snapshots.push(items), () => {});

    // Warm hit: served from cache, no new LIST/watch spawned.
    expect(rec.procs.length).toBe(spawnsBefore);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].map((p: any) => p.metadata.name)).toEqual(["a"]);

    // The idle teardown was cancelled — past the original TTL the watch lives on.
    await vi.advanceTimersByTimeAsync(1000);
    expect(watch.killed).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

// (d) The watch-only process ending (not via stop) triggers a restart: a new
//     LIST + watch spawn and a resync snapshot.
test("watch-only process exit triggers a restart with a resync snapshot", async () => {
  vi.useFakeTimers();
  try {
    const rec = makeRecorder();
    const mgr = new WatchManager(null, rec.spawnFn as any, { restartBaseMs: 100 });

    const snapshots: any[][] = [];
    mgr.subscribe({ kind: "pods", namespace: "default" }, (items) => snapshots.push(items), () => {});

    rec.lastList().emitList([pod("a")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.length).toBe(1);

    const firstWatch = rec.lastWatch();
    const listsBefore = rec.lists().length;

    // The watch stream dies on its own (server hiccup, connection reset).
    firstWatch.emit("exit", null, "SIGTERM");
    firstWatch.emit("close", null, "SIGTERM");

    // After the backoff delay, a fresh LIST is spawned (the restart).
    await vi.advanceTimersByTimeAsync(100);
    expect(rec.lists().length).toBe(listsBefore + 1);

    // Completing the new LIST emits a resync snapshot to the still-present listener.
    rec.lastList().emitList([pod("a"), pod("b")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.length).toBe(2);
    expect(snapshots[1].map((p: any) => p.metadata.name).sort()).toEqual(["a", "b"]);
  } finally {
    vi.useRealTimers();
  }
});

// (d2) A LIST that exits non-zero (missing kind) emits exactly ONE empty
//      snapshot, keeps retrying on the backoff (timer-gated, not a hot loop),
//      does not spam more empty snapshots, and recovers when the kind appears.
test("a failing LIST emits one empty snapshot, retries, and self-heals", async () => {
  vi.useFakeTimers();
  try {
    const rec = makeRecorder();
    const mgr = new WatchManager(null, rec.spawnFn as any, { restartBaseMs: 100 });

    const snapshots: any[][] = [];
    mgr.subscribe({ kind: "widgets", namespace: "default" }, (items) => snapshots.push(items), () => {});

    // The LIST fails (NotFound for a missing CRD).
    rec.lastList().emitListError(1);
    await vi.advanceTimersByTimeAsync(0);

    // The client gets exactly one (empty) snapshot so it renders empty, not a spinner.
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]).toEqual([]);
    expect(rec.lists().length).toBe(1); // retry is timer-gated, not immediate

    // After the first backoff a retry LIST is spawned; it fails too, but does NOT
    // re-emit an empty snapshot (no frame spam while a kind stays missing).
    await vi.advanceTimersByTimeAsync(100);
    expect(rec.lists().length).toBe(2);
    rec.lastList().emitListError(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.length).toBe(1);

    // The CRD is installed later: the next retry LIST succeeds and recovers with
    // a real snapshot. (Second failure used attempt=1 → 200ms backoff.)
    await vi.advanceTimersByTimeAsync(200);
    expect(rec.lists().length).toBe(3);
    rec.lastList().emitList([pod("w1")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.length).toBe(2);
    expect(snapshots[1].map((p: any) => p.metadata.name)).toEqual(["w1"]);
  } finally {
    vi.useRealTimers();
  }
});

// (e) A pinned (prewarmed) watch is NOT stopped when it has zero listeners.
test("a prewarmed watch is never idle-stopped", async () => {
  vi.useFakeTimers();
  try {
    const rec = makeRecorder();
    const mgr = new WatchManager(null, rec.spawnFn as any, { idleTtlMs: 1000 });

    mgr.prewarm(["pods"], "*");
    // The prewarm starts a LIST with no client listener.
    expect(rec.lists().length).toBe(1);
    rec.lastList().emitList([pod("a")]);
    await vi.advanceTimersByTimeAsync(0);

    const watch = rec.lastWatch();

    // Far past the idle TTL, the pinned watch is still alive (zero listeners).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watch.killed).toBe(false);

    // A first real subscriber gets the warm snapshot with no new spawn.
    const spawnsBefore = rec.procs.length;
    const snapshots: any[][] = [];
    mgr.subscribe({ kind: "pods", namespace: "*" }, (items) => snapshots.push(items), () => {});
    expect(rec.procs.length).toBe(spawnsBefore);
    expect(snapshots[0].map((p: any) => p.metadata.name)).toEqual(["a"]);
  } finally {
    vi.useRealTimers();
  }
});

// (f) Existing contract: a spawn "error" does not throw / crash the server.
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
