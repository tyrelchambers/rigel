import { test, expect } from "vitest";
import { createPollLoop, type PollLoopDeps } from "./pollLoop";
import type { PendingLogin } from "./accountStore";
import type { PollResult } from "./accountClient";

interface Timer { fn: () => void; ms: number; cleared: boolean }

function harness(over: Partial<PollLoopDeps> & { pending?: PendingLogin | null } = {}) {
  const timers: Timer[] = [];
  let pending: PendingLogin | null =
    over.pending === undefined
      ? { pollToken: "poll-abc", displayCode: "WX7Q", email: "jane@acme.com", startedAt: 0, expiresAt: 900_000 }
      : over.pending;
  const polled: string[] = [];
  const events: string[] = [];
  let now = 0;
  let results: PollResult[] = [{ status: "pending" }];

  const deps: PollLoopDeps = {
    getPending: () => pending,
    clearPending: () => { pending = null; },
    hasToken: () => false,
    poll: async (t) => { polled.push(t); return results.shift() ?? { status: "pending" }; },
    now: () => now,
    setTimer: (fn, ms) => { const t: Timer = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (h) => { (h as Timer).cleared = true; },
    onSignedIn: () => { events.push("signedIn"); },
    onEnded: () => { events.push("ended"); },
    ...over,
  };

  const loop = createPollLoop(deps);
  return {
    loop,
    timers,
    polled,
    events,
    setNow: (v: number) => { now = v; },
    setResults: (v: PollResult[]) => { results = v; },
    setPending: (v: PendingLogin | null) => { pending = v; },
    getPending: () => pending,
    /** Fire the most recently scheduled timer and let its async tick settle. */
    async fire() {
      const t = timers[timers.length - 1];
      if (!t) throw new Error("no timer scheduled");
      t.fn();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test("start schedules nothing when there is no pending login", () => {
  const h = harness({ pending: null });
  h.loop.start();
  expect(h.timers).toHaveLength(0);
});

test("start schedules the first tick at the fast interval", () => {
  const h = harness();
  h.loop.start();
  expect(h.timers).toHaveLength(1);
  expect(h.timers[0].ms).toBe(2000);
});

test("a pending poll result reschedules at 2000ms inside the fast window", async () => {
  const h = harness();
  h.loop.start();
  h.setNow(119_000);
  await h.fire();
  expect(h.polled).toEqual(["poll-abc"]);
  expect(h.timers).toHaveLength(2);
  expect(h.timers[1].ms).toBe(2000);
});

test("a pending poll result reschedules at 15000ms outside the fast window", async () => {
  const h = harness();
  h.loop.start();
  h.setNow(120_000);
  await h.fire();
  expect(h.timers).toHaveLength(2);
  expect(h.timers[1].ms).toBe(15000);
});

test("confirmed clears the pending login, signals sign-in, and schedules nothing further", async () => {
  const h = harness();
  h.setResults([{ status: "confirmed", account: { id: "1", email: "jane@acme.com", name: "Jane" } }]);
  h.loop.start();
  await h.fire();
  expect(h.getPending()).toBeNull();
  expect(h.events).toEqual(["signedIn"]);
  expect(h.timers).toHaveLength(1); // only the tick we just consumed
});

test("expired clears the pending login and signals ended, not signed-in", async () => {
  const h = harness();
  h.setResults([{ status: "expired" }]);
  h.loop.start();
  await h.fire();
  expect(h.getPending()).toBeNull();
  expect(h.events).toEqual(["ended"]);
  expect(h.timers).toHaveLength(1);
});

test("a pending login already past expiresAt ends without ever polling", async () => {
  const h = harness({ pending: { pollToken: "poll-abc", displayCode: "WX7Q", email: "jane@acme.com", startedAt: 0, expiresAt: 900_000 } });
  h.loop.start();
  h.setNow(900_000);
  await h.fire();
  expect(h.polled).toEqual([]);
  expect(h.getPending()).toBeNull();
  expect(h.events).toEqual(["ended"]);
  expect(h.timers).toHaveLength(1);
});

test("an already-signed-in app clears the stale pending login without polling", async () => {
  const h = harness({ hasToken: () => true });
  h.loop.start();
  await h.fire();
  expect(h.polled).toEqual([]);
  expect(h.getPending()).toBeNull();
  expect(h.events).toEqual([]);
  expect(h.timers).toHaveLength(1);
});

test("stop cancels the scheduled tick", () => {
  const h = harness();
  h.loop.start();
  h.loop.stop();
  expect(h.timers[0].cleared).toBe(true);
});

test("a tick that fires after the pending login vanished does nothing", async () => {
  const h = harness();
  h.loop.start();
  h.setPending(null);
  await h.fire();
  expect(h.polled).toEqual([]);
  expect(h.events).toEqual([]);
  expect(h.timers).toHaveLength(1);
});

test("start again cancels the previously scheduled tick", () => {
  const h = harness();
  h.loop.start();
  h.loop.start();
  expect(h.timers).toHaveLength(2);
  expect(h.timers[0].cleared).toBe(true);
  expect(h.timers[1].cleared).toBe(false);
});
