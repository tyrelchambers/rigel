// packages/k8s/src/digest.test.ts
import { describe, it, expect } from "vitest";
import { parseDigests, serializeDigests, type DigestSubscription } from "./digest.js";
import { normalizeDigest, nextDigests, digestScheduleSummary } from "./digest.js";

const sub: DigestSubscription = {
  id: "a", enabled: true, label: "Morning", channel: "signal",
  days: [0, 1, 2, 3, 4, 5, 6], time: "07:00", timezone: "America/Toronto",
  lookback: { mode: "sinceLast" }, createdAt: "2026-06-30T00:00:00.000Z",
};

describe("parseDigests", () => {
  it("round-trips a valid list", () => {
    expect(parseDigests(serializeDigests([sub]))).toEqual([sub]);
  });
  it("returns [] for empty/garbage", () => {
    expect(parseDigests(undefined)).toEqual([]);
    expect(parseDigests("not json")).toEqual([]);
    expect(parseDigests("{}")).toEqual([]);
  });
  it("drops entries missing required fields", () => {
    const bad = JSON.stringify([{ id: "x" }, sub]);
    expect(parseDigests(bad)).toEqual([sub]);
  });
  it("coerces fixed lookback and defaults enabled to true", () => {
    const raw = JSON.stringify([{ ...sub, enabled: undefined, lookback: { mode: "fixed", hours: 8 } }]);
    const out = parseDigests(raw);
    expect(out[0].enabled).toBe(true);
    expect(out[0].lookback).toEqual({ mode: "fixed", hours: 8 });
  });
});

describe("normalizeDigest", () => {
  const base = { label: "Morning", channel: "signal" as const, days: [1, 3], time: "07:00",
    timezone: "America/Toronto", lookback: { mode: "sinceLast" as const } };
  it("stamps id + createdAt + enabled", () => {
    const r = normalizeDigest(base, "id-1", Date.UTC(2026, 5, 30));
    expect(r.id).toBe("id-1");
    expect(r.enabled).toBe(true);
    expect(r.createdAt).toBe("2026-06-30T00:00:00.000Z");
  });
  it("honors explicit enabled: false and defaults to true when omitted", () => {
    expect(normalizeDigest({ ...base, enabled: false }, "i", 0).enabled).toBe(false);
    expect(normalizeDigest({ ...base, enabled: true }, "i", 0).enabled).toBe(true);
    expect(normalizeDigest(base, "i", 0).enabled).toBe(true);
  });
  it("rejects bad timezone / time / days / channel", () => {
    expect(() => normalizeDigest({ ...base, timezone: "Mars/Phobos" }, "i", 0)).toThrow();
    expect(() => normalizeDigest({ ...base, time: "25:00" }, "i", 0)).toThrow();
    expect(() => normalizeDigest({ ...base, days: [] }, "i", 0)).toThrow();
    expect(() => normalizeDigest({ ...base, channel: "sms" as never }, "i", 0)).toThrow();
  });
});

describe("nextDigests", () => {
  const a = normalizeDigest({ label: "A", channel: "signal", days: [1], time: "07:00",
    timezone: "UTC", lookback: { mode: "sinceLast" } }, "a", 0);
  it("adds, toggles, deletes", () => {
    let list = nextDigests([], { op: "add", sub: a });
    expect(list).toHaveLength(1);
    list = nextDigests(list, { op: "toggle", id: "a", enabled: false });
    expect(list[0].enabled).toBe(false);
    list = nextDigests(list, { op: "delete", id: "a" });
    expect(list).toEqual([]);
  });
});

describe("digestScheduleSummary", () => {
  it("renders daily", () => {
    const s = normalizeDigest({ label: "A", channel: "signal", days: [0,1,2,3,4,5,6], time: "07:00",
      timezone: "UTC", lookback: { mode: "sinceLast" } }, "a", 0);
    expect(digestScheduleSummary(s)).toBe("Daily at 07:00 (UTC)");
  });
  it("renders selected days", () => {
    const s = normalizeDigest({ label: "A", channel: "signal", days: [1,3], time: "06:30",
      timezone: "UTC", lookback: { mode: "sinceLast" } }, "a", 0);
    expect(digestScheduleSummary(s)).toBe("Mon, Wed at 06:30 (UTC)");
  });
});
