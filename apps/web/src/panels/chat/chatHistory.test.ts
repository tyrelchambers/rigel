import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ageDescription, loadSessions, type ChatHistoryEntry } from "./chatHistory";

// `ageDescription` reads `Date.now()` internally, so pin the clock.
describe("ageDescription", () => {
  const NOW = Date.parse("2026-06-09T12:00:00Z");
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("sub-minute (and future) is 'just now'", () => {
    expect(ageDescription(NOW - 30_000)).toBe("just now");
    expect(ageDescription(NOW)).toBe("just now");
    expect(ageDescription(NOW + 60_000)).toBe("just now");
  });
  test("minutes / hours / days ago", () => {
    expect(ageDescription(NOW - 5 * 60_000)).toBe("5m ago");
    expect(ageDescription(NOW - 3 * 3600_000)).toBe("3h ago");
    expect(ageDescription(NOW - 2 * 86400_000)).toBe("2d ago");
  });
});

describe("retired voice sessions", () => {
  beforeEach(() => localStorage.clear());

  const entry = (over: Partial<ChatHistoryEntry>): ChatHistoryEntry => ({
    id: "c1",
    title: "scale the api",
    createdAt: 1,
    updatedAt: 1,
    sessionId: null,
    messages: [{ id: "m1", role: "user", text: "hi" }],
    ...over,
  });

  test("drops the one-sided voice transcripts the old writer left behind", () => {
    localStorage.setItem(
      "rigel.chat.sessions",
      JSON.stringify([entry({ id: "voice-abc", title: "Voice session" }), entry({})]),
    );
    expect(loadSessions().map((e) => e.id)).toEqual(["c1"]);
  });

  test("keeps a typed conversation that happens to be titled the same way", () => {
    localStorage.setItem(
      "rigel.chat.sessions",
      JSON.stringify([entry({ id: "c2", title: "Voice session" })]),
    );
    expect(loadSessions().map((e) => e.id)).toEqual(["c2"]);
  });

  test("writes the sweep back, so it runs once rather than on every read", () => {
    localStorage.setItem(
      "rigel.chat.sessions",
      JSON.stringify([entry({ id: "voice-abc", title: "Voice session" }), entry({})]),
    );
    loadSessions();
    expect(JSON.parse(localStorage.getItem("rigel.chat.sessions")!)).toHaveLength(1);
  });
});
