import { describe, it, expect } from "vitest";
import { isMuted, setMute, clearMute, parseIssueMutes, serializeIssueMutes, type IssueMutes } from "./mutes";

const now = new Date("2026-09-02T12:00:00Z");

describe("isMuted", () => {
  it("is false for an unknown fingerprint", () => {
    expect(isMuted({}, "a|b", now)).toBe(false);
  });

  it("is true for an indefinite mute", () => {
    expect(isMuted({ "a|b": { until: null } }, "a|b", now)).toBe(true);
  });

  it("is true for a snooze still in the future", () => {
    expect(isMuted({ "a|b": { until: "2026-09-02T13:00:00Z" } }, "a|b", now)).toBe(true);
  });

  it("is false for an expired snooze", () => {
    expect(isMuted({ "a|b": { until: "2026-09-02T11:00:00Z" } }, "a|b", now)).toBe(false);
  });
});

describe("setMute", () => {
  it("stores an indefinite mute", () => {
    expect(setMute({}, "a|b", null)).toEqual({ "a|b": { until: null } });
  });

  it("stores a snooze as an ISO instant", () => {
    const out = setMute({}, "a|b", { hours: 24 }, now);
    expect(out["a|b"].until).toBe("2026-09-03T12:00:00.000Z");
  });

  it("does not mutate its input", () => {
    const before: IssueMutes = {};
    setMute(before, "a|b", null);
    expect(before).toEqual({});
  });
});

describe("clearMute", () => {
  it("removes an entry", () => {
    expect(clearMute({ "a|b": { until: null } }, "a|b")).toEqual({});
  });
});

describe("parseIssueMutes", () => {
  it("returns an empty object for absent or invalid JSON", () => {
    expect(parseIssueMutes(undefined)).toEqual({});
    expect(parseIssueMutes("")).toEqual({});
    expect(parseIssueMutes("not json")).toEqual({});
    expect(parseIssueMutes("[1,2,3]")).toEqual({});
  });

  it("drops entries that are not shaped like a mute", () => {
    expect(parseIssueMutes('{"a|b":{"until":null},"bad":7}')).toEqual({ "a|b": { until: null } });
  });

  it("round-trips through serializeIssueMutes", () => {
    const m: IssueMutes = { "a|b": { until: "2026-09-03T12:00:00.000Z" } };
    expect(parseIssueMutes(serializeIssueMutes(m))).toEqual(m);
  });
});
