import { describe, expect, test } from "vitest";
import { SessionStore, ONE_HOUR_MS } from "./sessionStore.js";
import { normalizeNumber } from "./signalInbound.js";

const ME = "+15550101234";

describe("SessionStore (signal: TTL + number normalization)", () => {
  const signalStore = () => new SessionStore(ONE_HOUR_MS, normalizeNumber);

  test("returns undefined before any session is recorded", () => {
    expect(signalStore().resumeIdFor(ME, 1000)).toBeUndefined();
  });

  test("resumes within the hour", () => {
    const s = signalStore();
    s.record(ME, "sess-1", 0);
    expect(s.resumeIdFor(ME, ONE_HOUR_MS)).toBe("sess-1");
  });

  test("expires and evicts past the hour", () => {
    const s = signalStore();
    s.record(ME, "sess-1", 0);
    expect(s.resumeIdFor(ME, ONE_HOUR_MS + 1)).toBeUndefined();
    expect(s.resumeIdFor(ME, ONE_HOUR_MS + 2)).toBeUndefined();
  });

  test("record extends the idle window", () => {
    const s = signalStore();
    s.record(ME, "sess-1", 0);
    s.record(ME, "sess-1", ONE_HOUR_MS);
    expect(s.resumeIdFor(ME, ONE_HOUR_MS + ONE_HOUR_MS)).toBe("sess-1");
  });

  test("isolates senders and normalizes formatting", () => {
    const s = signalStore();
    s.record(ME, "sess-1", 0);
    expect(s.resumeIdFor("+1 (555) 010-1234", 1)).toBe("sess-1");
    expect(s.resumeIdFor("+15559999999", 1)).toBeUndefined();
  });

  test("clear drops the pointer", () => {
    const s = signalStore();
    s.record(ME, "sess-1", 0);
    s.clear(ME);
    expect(s.resumeIdFor(ME, 1)).toBeUndefined();
  });

  test("ignores an empty session id", () => {
    const s = signalStore();
    s.record(ME, "", 0);
    expect(s.resumeIdFor(ME, 1)).toBeUndefined();
  });
});

describe("SessionStore (matrix: durable, opaque keys)", () => {
  const ROOM = "!AbCd:matrix.tail8a13da.ts.net";
  const durable = () => new SessionStore(Number.POSITIVE_INFINITY);

  test("keeps opaque room-id keys verbatim (no normalization mangling dots/colons)", () => {
    const s = durable();
    s.record(ROOM, "sess-room", 0);
    expect(s.resumeIdFor(ROOM, 1)).toBe("sess-room");
    // A key that would collide under number-normalization stays distinct.
    expect(s.resumeIdFor("!AbCdmatrixtail8a13datsnet", 1)).toBeUndefined();
  });

  test("never expires with an infinite TTL", () => {
    const s = durable();
    s.record(ROOM, "sess-room", 0);
    expect(s.resumeIdFor(ROOM, ONE_HOUR_MS * 24 * 365)).toBe("sess-room");
  });

  test("snapshot returns key -> sessionId for every live entry", () => {
    const s = durable();
    s.record("!a:hs", "s-a", 0);
    s.record("!b:hs", "s-b", 0);
    expect(s.snapshot()).toEqual({ "!a:hs": "s-a", "!b:hs": "s-b" });
  });

  test("load hydrates a snapshot so resume works after a restart", () => {
    const s = durable();
    s.load({ "!a:hs": "s-a" }, 0);
    expect(s.resumeIdFor("!a:hs", 1)).toBe("s-a");
  });

  test("load ignores undefined and empty ids", () => {
    const s = durable();
    s.load(undefined, 0);
    s.load({ "!a:hs": "" }, 0);
    expect(s.snapshot()).toEqual({});
  });
});
