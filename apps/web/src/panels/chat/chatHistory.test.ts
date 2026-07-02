import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ageDescription } from "./chatHistory";

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
