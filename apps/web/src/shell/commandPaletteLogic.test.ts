import { describe, it, expect } from "vitest";
import {
  filterEntries,
  scoreEntry,
  wrapIndex,
  type PaletteEntry,
} from "./commandPaletteLogic";

const makeEntry = (
  id: string,
  title: string,
  subtitle = "",
  route = `/${id}`,
): PaletteEntry => ({ id, title, subtitle, route, group: "Navigate" });

const ENTRIES: PaletteEntry[] = [
  makeEntry("overview", "Overview", "Health at a glance"),
  makeEntry("pods", "Pods", "Running containers"),
  makeEntry("deployments", "Deployments", "Rollouts & replicas"),
  makeEntry("nodes", "Nodes", "Cluster machines"),
  makeEntry("ingresses", "Ingresses", "External routing"),
];

describe("scoreEntry", () => {
  it("returns 0 for empty query", () => {
    expect(scoreEntry(ENTRIES[0], "")).toBe(0);
    expect(scoreEntry(ENTRIES[0], "   ")).toBe(0);
  });

  it("exact match scores 1000", () => {
    expect(scoreEntry(makeEntry("pods", "Pods"), "pods")).toBe(1000);
  });

  it("prefix match scores 500", () => {
    expect(scoreEntry(makeEntry("deploy", "Deployments"), "dep")).toBe(500);
  });

  it("substring in title scores 200 - offset", () => {
    // "ods" is at index 1 in "pods"
    expect(scoreEntry(makeEntry("pods", "Pods"), "ods")).toBe(200 - 1);
  });

  it("substring in subtitle scores 80 - offset", () => {
    const e = makeEntry("pods", "Pods", "Running containers");
    // "containers" is at index 8 in "running containers"
    expect(scoreEntry(e, "containers")).toBe(80 - 8);
  });

  it("returns -1 when no match", () => {
    expect(scoreEntry(makeEntry("pods", "Pods", "Running containers"), "xyz")).toBe(-1);
  });

  it("is case-insensitive", () => {
    expect(scoreEntry(makeEntry("pods", "Pods"), "POD")).toBe(500);
  });
});

describe("filterEntries", () => {
  it("returns all entries (up to limit) for empty query", () => {
    const result = filterEntries(ENTRIES, "");
    expect(result).toHaveLength(ENTRIES.length);
  });

  it("respects limit on empty query", () => {
    const result = filterEntries(ENTRIES, "", 2);
    expect(result).toHaveLength(2);
  });

  it("filters entries containing the query", () => {
    const result = filterEntries(ENTRIES, "pod");
    expect(result.every((e) => e.id === "pods")).toBe(true);
    expect(result).toHaveLength(1);
  });

  it("returns empty array when no match", () => {
    expect(filterEntries(ENTRIES, "zzzzz")).toHaveLength(0);
  });

  it("sorts exact matches before prefix before substring", () => {
    const entries = [
      makeEntry("b", "Health"), // subtitle has nothing
      makeEntry("a", "Pods", "pods info"), // exact match on "pods"
      makeEntry("c", "Pods count", "pods group"), // prefix match ("pods count" starts with "pods")
    ];
    const result = filterEntries(entries, "pods");
    expect(result[0].id).toBe("a"); // exact
    expect(result[1].id).toBe("c"); // prefix
  });

  it("subtitle match ranks lower than title match", () => {
    const entries = [
      makeEntry("sub", "Other", "contains pods"),
      makeEntry("title", "Pods", ""),
    ];
    const result = filterEntries(entries, "pods");
    expect(result[0].id).toBe("title"); // title match ranks higher
    expect(result[1].id).toBe("sub");
  });

  it("respects limit on non-empty query", () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeEntry(`e${i}`, `Entry ${i}`, "some info"),
    );
    const result = filterEntries(entries, "entry", 5);
    expect(result).toHaveLength(5);
  });
});

describe("wrapIndex", () => {
  it("returns 0 for empty list", () => {
    expect(wrapIndex(0, 0)).toBe(0);
    expect(wrapIndex(-1, 0)).toBe(0);
    expect(wrapIndex(5, 0)).toBe(0);
  });

  it("clamps in-range index", () => {
    expect(wrapIndex(0, 5)).toBe(0);
    expect(wrapIndex(4, 5)).toBe(4);
    expect(wrapIndex(2, 5)).toBe(2);
  });

  it("wraps negative to last", () => {
    expect(wrapIndex(-1, 5)).toBe(4);
  });

  it("wraps overflow to 0", () => {
    expect(wrapIndex(5, 5)).toBe(0);
    expect(wrapIndex(10, 5)).toBe(0);
  });
});
