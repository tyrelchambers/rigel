import { describe, expect, test } from "vitest";
import type { K8sEvent } from "./types";
import {
  absoluteWhen,
  eventBuckets,
  isWarning,
  matchesSearch,
  matchesTypeFilter,
  relativeAge,
  sortEvents,
  typeColorClass,
  when,
} from "./eventsDisplay";

function event(overrides: Partial<K8sEvent> = {}): K8sEvent {
  return {
    metadata: { name: "evt", namespace: "default", uid: "u1", ...overrides.metadata },
    type: "type" in overrides ? (overrides.type ?? null) : "Normal",
    reason: overrides.reason ?? null,
    message: overrides.message ?? null,
    count: overrides.count ?? null,
    firstTimestamp: overrides.firstTimestamp ?? null,
    lastTimestamp: overrides.lastTimestamp ?? null,
    involvedObject: overrides.involvedObject ?? null,
  };
}

const NOW = new Date("2026-06-09T15:00:00Z").getTime();

describe("relativeAge", () => {
  test("seconds", () => {
    expect(relativeAge("2026-06-09T14:59:55Z", NOW)).toBe("5s");
  });
  test("minutes (spec example)", () => {
    expect(relativeAge("2026-06-09T14:55:00Z", NOW)).toBe("5m");
  });
  test("hours", () => {
    expect(relativeAge("2026-06-09T13:00:00Z", NOW)).toBe("2h");
  });
  test("days", () => {
    expect(relativeAge("2026-06-08T15:00:00Z", NOW)).toBe("1d");
  });
  test("future timestamp clamps to 0s", () => {
    expect(relativeAge("2026-06-09T15:00:30Z", NOW)).toBe("0s");
  });
  test("missing timestamp → —", () => {
    expect(relativeAge(undefined, NOW)).toBe("—");
    expect(relativeAge(null, NOW)).toBe("—");
  });
  test("unparseable → —", () => {
    expect(relativeAge("not-a-date", NOW)).toBe("—");
  });
  test("exactly now → 0s", () => {
    expect(relativeAge("2026-06-09T15:00:00Z", NOW)).toBe("0s");
  });
});

describe("absoluteWhen", () => {
  test("formats a valid timestamp", () => {
    expect(absoluteWhen("2026-06-09T15:00:00Z")).not.toBeNull();
  });
  test("missing / unparseable → null", () => {
    expect(absoluteWhen(undefined)).toBeNull();
    expect(absoluteWhen(null)).toBeNull();
    expect(absoluteWhen("nope")).toBeNull();
  });
});

describe("typeColorClass", () => {
  test("Warning → red", () => {
    expect(typeColorClass("Warning")).toBe("text-red-600 bg-red-600/15");
  });
  test("Normal → green", () => {
    expect(typeColorClass("Normal")).toBe("text-green-600 bg-green-600/15");
  });
  test("nil → green (default)", () => {
    expect(typeColorClass(null)).toBe("text-green-600 bg-green-600/15");
    expect(typeColorClass(undefined)).toBe("text-green-600 bg-green-600/15");
  });
});

describe("isWarning / when", () => {
  test("isWarning only for Warning", () => {
    expect(isWarning(event({ type: "Warning" }))).toBe(true);
    expect(isWarning(event({ type: "Normal" }))).toBe(false);
    expect(isWarning(event({ type: null }))).toBe(false);
  });
  test("when prefers last > first > creation", () => {
    expect(
      when(
        event({
          lastTimestamp: "2026-06-09T14:00:00Z",
          firstTimestamp: "2026-06-09T13:00:00Z",
          metadata: { name: "e", uid: "u", creationTimestamp: "2026-06-09T12:00:00Z" },
        }),
      ),
    ).toBe("2026-06-09T14:00:00Z");
    expect(
      when(
        event({
          lastTimestamp: null,
          firstTimestamp: "2026-06-09T13:00:00Z",
          metadata: { name: "e", uid: "u", creationTimestamp: "2026-06-09T12:00:00Z" },
        }),
      ),
    ).toBe("2026-06-09T13:00:00Z");
    expect(
      when(
        event({
          lastTimestamp: null,
          firstTimestamp: null,
          metadata: { name: "e", uid: "u", creationTimestamp: "2026-06-09T12:00:00Z" },
        }),
      ),
    ).toBe("2026-06-09T12:00:00Z");
  });
  test("when returns undefined when all missing", () => {
    expect(when(event({ metadata: { name: "e", uid: "u" } }))).toBeUndefined();
  });
});

describe("matchesSearch", () => {
  const e = event({
    reason: "FailedScheduling",
    message: "0/3 nodes are available",
    involvedObject: { kind: "Pod", name: "web-5f4c8", namespace: "default", uid: "x" },
  });
  test("empty query matches all", () => {
    expect(matchesSearch(e, "")).toBe(true);
    expect(matchesSearch(e, "   ")).toBe(true);
  });
  test("matches reason, case-insensitive", () => {
    expect(matchesSearch(e, "failedsched")).toBe(true);
  });
  test("matches message substring", () => {
    expect(matchesSearch(e, "nodes are")).toBe(true);
  });
  test("matches involvedObject.name", () => {
    expect(matchesSearch(e, "web-5f4c8")).toBe(true);
  });
  test("no match", () => {
    expect(matchesSearch(e, "zzzz")).toBe(false);
  });
  test("tolerates null fields", () => {
    expect(matchesSearch(event(), "x")).toBe(false);
  });
});

describe("matchesTypeFilter", () => {
  test("All matches everything", () => {
    expect(matchesTypeFilter(event({ type: "Warning" }), "All")).toBe(true);
    expect(matchesTypeFilter(event({ type: null }), "All")).toBe(true);
  });
  test("Warning matches only Warning", () => {
    expect(matchesTypeFilter(event({ type: "Warning" }), "Warning")).toBe(true);
    expect(matchesTypeFilter(event({ type: "Normal" }), "Warning")).toBe(false);
  });
  test("Normal matches only Normal", () => {
    expect(matchesTypeFilter(event({ type: "Normal" }), "Normal")).toBe(true);
    expect(matchesTypeFilter(event({ type: "Warning" }), "Normal")).toBe(false);
    expect(matchesTypeFilter(event({ type: null }), "Normal")).toBe(false);
  });
});

describe("sortEvents", () => {
  test("newest first by best timestamp", () => {
    const older = event({ metadata: { name: "a", uid: "a" }, lastTimestamp: "2026-06-09T10:00:00Z" });
    const newer = event({ metadata: { name: "b", uid: "b" }, lastTimestamp: "2026-06-09T14:00:00Z" });
    const sorted = sortEvents([older, newer]);
    expect(sorted.map((e) => e.metadata.uid)).toEqual(["b", "a"]);
  });
  test("falls back to firstTimestamp then creationTimestamp", () => {
    const a = event({ metadata: { name: "a", uid: "a" }, firstTimestamp: "2026-06-09T11:00:00Z" });
    const b = event({
      metadata: { name: "b", uid: "b", creationTimestamp: "2026-06-09T12:00:00Z" },
    });
    expect(sortEvents([a, b]).map((e) => e.metadata.uid)).toEqual(["b", "a"]);
  });
  test("events with no timestamp sort last", () => {
    const withTs = event({ metadata: { name: "a", uid: "a" }, lastTimestamp: "2026-06-09T10:00:00Z" });
    const noTs = event({ metadata: { name: "b", uid: "b" } });
    expect(sortEvents([noTs, withTs]).map((e) => e.metadata.uid)).toEqual(["a", "b"]);
  });
  test("does not mutate the input", () => {
    const input = [
      event({ metadata: { name: "a", uid: "a" }, lastTimestamp: "2026-06-09T10:00:00Z" }),
      event({ metadata: { name: "b", uid: "b" }, lastTimestamp: "2026-06-09T14:00:00Z" }),
    ];
    sortEvents(input);
    expect(input.map((e) => e.metadata.uid)).toEqual(["a", "b"]);
  });
});

describe("eventBuckets", () => {
  test("60 buckets spanning 1 hour", () => {
    const buckets = eventBuckets([], NOW, 3600, 60);
    expect(buckets).toHaveLength(60);
    expect(buckets[0].start).toBe(NOW - 3600 * 1000);
    expect(buckets[59].start).toBe(NOW - 60 * 1000);
  });
  test("places a warning and a normal event in the right bucket", () => {
    // 55 minutes ago → 5 min into the window → bucket index 5.
    const warn = event({ type: "Warning", lastTimestamp: "2026-06-09T14:05:00Z" });
    // 30 minutes ago → bucket index 30.
    const norm = event({ type: "Normal", lastTimestamp: "2026-06-09T14:30:00Z" });
    const buckets = eventBuckets([warn, norm], NOW, 3600, 60);
    expect(buckets[5].warnings).toBe(1);
    expect(buckets[5].normal).toBe(0);
    expect(buckets[30].normal).toBe(1);
  });
  test("an event exactly at now lands in the final bucket", () => {
    const e = event({ type: "Normal", lastTimestamp: "2026-06-09T15:00:00Z" });
    const buckets = eventBuckets([e], NOW, 3600, 60);
    expect(buckets[59].normal).toBe(1);
  });
  test("drops events outside the window and without timestamps", () => {
    const tooOld = event({ lastTimestamp: "2026-06-09T13:00:00Z" }); // 2h ago
    const future = event({ lastTimestamp: "2026-06-09T16:00:00Z" }); // in the future
    const noTs = event({});
    const buckets = eventBuckets([tooOld, future, noTs], NOW, 3600, 60);
    expect(buckets.reduce((n, b) => n + b.warnings + b.normal, 0)).toBe(0);
  });
  test("degenerate args → empty", () => {
    expect(eventBuckets([], NOW, 0, 60)).toEqual([]);
    expect(eventBuckets([], NOW, 3600, 0)).toEqual([]);
  });
});
