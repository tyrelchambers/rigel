import { describe, expect, test } from "vitest";
import { SessionStore, ONE_HOUR_MS } from "./sessionStore.js";

const ME = "+15550101234";

describe("SessionStore", () => {
  test("returns undefined before any session is recorded", () => {
    const s = new SessionStore();
    expect(s.resumeIdFor(ME, 1000)).toBeUndefined();
  });

  test("resumes within the hour", () => {
    const s = new SessionStore();
    s.record(ME, "sess-1", 0);
    expect(s.resumeIdFor(ME, ONE_HOUR_MS)).toBe("sess-1");
  });

  test("expires and evicts past the hour", () => {
    const s = new SessionStore();
    s.record(ME, "sess-1", 0);
    expect(s.resumeIdFor(ME, ONE_HOUR_MS + 1)).toBeUndefined();
    // evicted — a later lookup before re-recording is still empty
    expect(s.resumeIdFor(ME, ONE_HOUR_MS + 2)).toBeUndefined();
  });

  test("record extends the idle window", () => {
    const s = new SessionStore();
    s.record(ME, "sess-1", 0);
    s.record(ME, "sess-1", ONE_HOUR_MS); // a fresh message at the edge
    expect(s.resumeIdFor(ME, ONE_HOUR_MS + ONE_HOUR_MS)).toBe("sess-1");
  });

  test("isolates senders and normalizes formatting", () => {
    const s = new SessionStore();
    s.record(ME, "sess-1", 0);
    expect(s.resumeIdFor("+1 (555) 010-1234", 1)).toBe("sess-1"); // same number, formatted
    expect(s.resumeIdFor("+15559999999", 1)).toBeUndefined(); // different sender
  });

  test("clear drops the pointer", () => {
    const s = new SessionStore();
    s.record(ME, "sess-1", 0);
    s.clear(ME);
    expect(s.resumeIdFor(ME, 1)).toBeUndefined();
  });

  test("ignores an empty session id", () => {
    const s = new SessionStore();
    s.record(ME, "", 0);
    expect(s.resumeIdFor(ME, 1)).toBeUndefined();
  });
});
