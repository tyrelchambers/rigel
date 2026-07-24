import { describe, it, expect } from "vitest";
import { addPrRecord, removePrRecord, parsePullRequests, type ChatPrRecord } from "./pullRequestLedger";

const rec = (over: Partial<ChatPrRecord>): ChatPrRecord => ({
  id: "1",
  prUrl: "https://github.com/o/r/pull/1",
  number: 1,
  repoSlug: "o/r",
  repoName: "myrepo",
  source: "web",
  title: "Fix",
  branch: "rigel/fix-1",
  filePath: "k8s/deploy.yaml",
  createdAt: "2026-07-24T00:00:00.000Z",
  ...over,
});

const NOW = Date.parse("2026-07-24T01:00:00.000Z");

describe("addPrRecord", () => {
  it("prepends the new record", () => {
    const out = addPrRecord([rec({ id: "old", prUrl: "https://github.com/o/r/pull/9" })], rec({ id: "new" }), { now: NOW });
    expect(out.map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("dedupes by prUrl", () => {
    const existing = rec({ id: "old", prUrl: "https://github.com/o/r/pull/1" });
    const out = addPrRecord([existing], rec({ id: "new", prUrl: "https://github.com/o/r/pull/1" }), { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("new");
  });

  it("caps the list at max", () => {
    const list = Array.from({ length: 5 }, (_, i) => rec({ id: `r${i}`, prUrl: `https://github.com/o/r/pull/${i + 10}` }));
    const out = addPrRecord(list, rec({ id: "new" }), { now: NOW, max: 3 });
    expect(out).toHaveLength(3);
    expect(out[0]!.id).toBe("new");
  });

  it("drops records older than the TTL", () => {
    const stale = rec({ id: "stale", prUrl: "https://github.com/o/r/pull/2", createdAt: "2026-06-01T00:00:00.000Z" });
    const out = addPrRecord([stale], rec({ id: "new" }), { now: NOW, ttlDays: 30 });
    expect(out.map((r) => r.id)).toEqual(["new"]);
  });
});

describe("removePrRecord", () => {
  it("removes the matching id", () => {
    const out = removePrRecord([rec({ id: "a" }), rec({ id: "b", prUrl: "x" })], "a");
    expect(out.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("parsePullRequests", () => {
  it("parses a JSON array", () => {
    expect(parsePullRequests(JSON.stringify([rec({ id: "a" })]))).toHaveLength(1);
  });
  it("returns [] for missing or bad input", () => {
    expect(parsePullRequests(undefined)).toEqual([]);
    expect(parsePullRequests("not json")).toEqual([]);
    expect(parsePullRequests("{}")).toEqual([]);
  });
});
