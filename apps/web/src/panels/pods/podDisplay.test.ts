import { describe, expect, test } from "vitest";
import type { Pod } from "./types";
import {
  relativeAge,
  phaseColorClass,
  readyText,
  restartCount,
  matchesSearch,
  sortPods,
} from "./podDisplay";

function pod(overrides: Partial<Pod> = {}): Pod {
  return {
    metadata: { name: "web", namespace: "default", uid: "u1", ...overrides.metadata },
    spec: { containers: [{ name: "web" }], ...overrides.spec },
    status: overrides.status,
  };
}

describe("relativeAge", () => {
  const now = Date.parse("2026-06-09T12:00:00Z");
  test("seconds / minutes / hours / days", () => {
    expect(relativeAge("2026-06-09T11:59:55Z", now)).toBe("5s");
    expect(relativeAge("2026-06-09T11:57:00Z", now)).toBe("3m");
    expect(relativeAge("2026-06-09T10:00:00Z", now)).toBe("2h");
    expect(relativeAge("2026-06-07T12:00:00Z", now)).toBe("2d");
  });
  test("future clamps to 0s and missing/invalid yields dash", () => {
    expect(relativeAge("2026-06-09T12:00:30Z", now)).toBe("0s");
    expect(relativeAge(undefined, now)).toBe("—");
    expect(relativeAge("not-a-date", now)).toBe("—");
  });
});

describe("phaseColorClass", () => {
  test("known phases map to expected color families", () => {
    expect(phaseColorClass("Running")).toContain("green");
    expect(phaseColorClass("Succeeded")).toContain("green");
    expect(phaseColorClass("Pending")).toContain("yellow");
    expect(phaseColorClass("Failed")).toContain("red");
  });
  test("unknown / nil phase is muted gray", () => {
    expect(phaseColorClass("Weird")).toContain("muted");
    expect(phaseColorClass(undefined)).toContain("muted");
  });
});

describe("readyText", () => {
  test("ready/total from container statuses", () => {
    const p = pod({
      status: {
        containerStatuses: [
          { name: "a", ready: true, restartCount: 0 },
          { name: "b", ready: false, restartCount: 0 },
        ],
      },
    });
    expect(readyText(p)).toBe("1/2");
  });
  test("dash when no statuses", () => {
    expect(readyText(pod())).toBe("—");
    expect(readyText(pod({ status: { containerStatuses: [] } }))).toBe("—");
  });
});

describe("restartCount", () => {
  test("sums all container restart counts", () => {
    const p = pod({
      status: {
        containerStatuses: [
          { name: "a", ready: true, restartCount: 2 },
          { name: "b", ready: true, restartCount: 3 },
        ],
      },
    });
    expect(restartCount(p)).toBe(5);
  });
  test("zero when no statuses", () => {
    expect(restartCount(pod())).toBe(0);
  });
});

describe("matchesSearch", () => {
  const p = pod({
    metadata: { name: "memos-abc", namespace: "apps", uid: "u1", labels: { app: "memos", tier: "frontend" } },
  });
  test("empty query matches everything", () => {
    expect(matchesSearch(p, "")).toBe(true);
    expect(matchesSearch(p, "   ")).toBe(true);
  });
  test("case-insensitive match on name, namespace, label key and value", () => {
    expect(matchesSearch(p, "MEMOS")).toBe(true); // name + label value
    expect(matchesSearch(p, "apps")).toBe(true); // namespace
    expect(matchesSearch(p, "tier")).toBe(true); // label key
    expect(matchesSearch(p, "frontend")).toBe(true); // label value
  });
  test("no match returns false", () => {
    expect(matchesSearch(p, "nginx")).toBe(false);
  });
});

describe("sortPods", () => {
  test("sorts by namespace then name", () => {
    const a = pod({ metadata: { name: "z", namespace: "a", uid: "1" } });
    const b = pod({ metadata: { name: "a", namespace: "b", uid: "2" } });
    const c = pod({ metadata: { name: "a", namespace: "a", uid: "3" } });
    const sorted = sortPods([a, b, c]).map((p) => `${p.metadata.namespace}/${p.metadata.name}`);
    expect(sorted).toEqual(["a/a", "a/z", "b/a"]);
  });
});
