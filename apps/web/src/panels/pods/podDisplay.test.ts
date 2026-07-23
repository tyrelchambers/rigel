import { describe, expect, test } from "vitest";
import type { Pod } from "./types";
import {
  relativeAge,
  humanAge,
  phaseColorClass,
  readyText,
  restartCount,
  podHasError,
  matchesSearch,
  matchesNode,
  sortPods,
  podSortOptions,
  matchesPhase,
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

describe("humanAge", () => {
  const now = Date.parse("2026-06-09T12:00:00Z");
  test("missing / invalid yields dash", () => {
    expect(humanAge(undefined, now)).toBe("—");
    expect(humanAge("not-a-date", now)).toBe("—");
  });
  test("sub-minute and future clamp to 'just now'", () => {
    expect(humanAge("2026-06-09T11:59:30Z", now)).toBe("just now");
    expect(humanAge("2026-06-09T12:00:00Z", now)).toBe("just now");
    expect(humanAge("2026-06-09T12:05:00Z", now)).toBe("just now");
  });
  test("largest unit, pluralized", () => {
    expect(humanAge("2026-06-09T11:59:00Z", now)).toBe("1 minute");
    expect(humanAge("2026-06-09T11:55:00Z", now)).toBe("5 minutes");
    expect(humanAge("2026-06-09T11:00:00Z", now)).toBe("1 hour");
    expect(humanAge("2026-06-09T10:00:00Z", now)).toBe("2 hours");
    expect(humanAge("2026-06-08T12:00:00Z", now)).toBe("1 day");
    expect(humanAge("2025-12-26T12:00:00Z", now)).toBe("165 days");
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

describe("podHasError", () => {
  test("CrashLoopBackOff / ImagePullBackOff waiting reasons are errors", () => {
    expect(podHasError(pod({ status: { containerStatuses: [{ name: "c", ready: false, restartCount: 5, state: { waiting: { reason: "CrashLoopBackOff" } } }] } }))).toBe(true);
    expect(podHasError(pod({ status: { containerStatuses: [{ name: "c", ready: false, restartCount: 0, state: { waiting: { reason: "ImagePullBackOff" } } }] } }))).toBe(true);
  });
  test("Failed phase is an error", () => {
    expect(podHasError(pod({ status: { phase: "Failed" } }))).toBe(true);
  });
  test("running / completed pods are not errors", () => {
    expect(podHasError(pod({ status: { phase: "Running", containerStatuses: [{ name: "c", ready: true, restartCount: 0, state: { running: { startedAt: "x" } } }] } }))).toBe(false);
    expect(podHasError(pod({ status: { containerStatuses: [{ name: "c", ready: false, restartCount: 0, state: { terminated: { reason: "Completed", exitCode: 0 } } }] } }))).toBe(false);
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

describe("matchesNode", () => {
  const onA = pod({ spec: { containers: [{ name: "web" }], nodeName: "node-a" } });
  const unscheduled = pod({ spec: { containers: [{ name: "web" }] } });
  test("empty filter matches every pod", () => {
    expect(matchesNode(onA, "")).toBe(true);
    expect(matchesNode(unscheduled, "")).toBe(true);
  });
  test("matches only pods scheduled on the given node", () => {
    expect(matchesNode(onA, "node-a")).toBe(true);
    expect(matchesNode(onA, "node-b")).toBe(false);
    expect(matchesNode(unscheduled, "node-a")).toBe(false);
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

describe("podSortOptions", () => {
  test("omits CPU/Mem options when no metric accessor is given", () => {
    const values = podSortOptions().map((o) => o.value);
    expect(values).not.toContain("cpu");
    expect(values).not.toContain("mem");
  });
  test("includes CPU/Mem when a metric accessor is given", () => {
    const values = podSortOptions(() => ({ cpu: 0, mem: 0 })).map((o) => o.value);
    expect(values).toContain("cpu");
    expect(values).toContain("mem");
  });
  const optByValue = (v: string, metric?: (p: Pod) => { cpu: number; mem: number }) =>
    podSortOptions(metric).find((o) => o.value === v)!;

  test("sorts by restarts ascending", () => {
    const a = pod({ metadata: { name: "a", uid: "1" }, status: { phase: "Running", containerStatuses: [{ name: "c", ready: true, restartCount: 5 } as any] } });
    const b = pod({ metadata: { name: "b", uid: "2" }, status: { phase: "Running", containerStatuses: [{ name: "c", ready: true, restartCount: 1 } as any] } });
    expect([a, b].sort(optByValue("restarts").compare).map((p) => p.metadata.name)).toEqual(["b", "a"]);
  });

  test("namespace option breaks ties by name", () => {
    const a = pod({ metadata: { name: "b", namespace: "ns", uid: "1" } });
    const b = pod({ metadata: { name: "a", namespace: "ns", uid: "2" } });
    expect([a, b].sort(optByValue("namespace").compare).map((p) => p.metadata.name)).toEqual(["a", "b"]);
  });

  test("sorts by name", () => {
    const a = pod({ metadata: { name: "b", uid: "1" } });
    const b = pod({ metadata: { name: "a", uid: "2" } });
    expect([a, b].sort(optByValue("name").compare).map((p) => p.metadata.name)).toEqual(["a", "b"]);
  });

  test("sorts by phase", () => {
    const running = pod({ metadata: { name: "running", uid: "1" }, status: { phase: "Running" } });
    const failed = pod({ metadata: { name: "failed", uid: "2" }, status: { phase: "Failed" } });
    const pending = pod({ metadata: { name: "pending", uid: "3" }, status: { phase: "Pending" } });
    expect([running, pending, failed].sort(optByValue("phase").compare).map((p) => p.status?.phase)).toEqual(["Failed", "Pending", "Running"]);
  });

  test("sorts by age, collapsing missing/invalid timestamps to oldest", () => {
    const older = pod({ metadata: { name: "older", uid: "1", creationTimestamp: "2026-01-01T00:00:00Z" } });
    const newer = pod({ metadata: { name: "newer", uid: "2", creationTimestamp: "2026-06-01T00:00:00Z" } });
    const undated = pod({ metadata: { name: "undated", uid: "3", creationTimestamp: "not-a-date" } });
    expect([newer, older, undated].sort(optByValue("age").compare).map((p) => p.metadata.name)).toEqual(["undated", "older", "newer"]);
  });

  test("sorts by node", () => {
    const a = pod({ metadata: { name: "a", uid: "1" }, spec: { containers: [{ name: "web" }], nodeName: "node-b" } });
    const b = pod({ metadata: { name: "b", uid: "2" }, spec: { containers: [{ name: "web" }], nodeName: "node-a" } });
    expect([a, b].sort(optByValue("node").compare).map((p) => p.metadata.name)).toEqual(["b", "a"]);
  });

  test("sorts by cpu and mem ascending via the metric accessor", () => {
    const usage: Record<string, { cpu: number; mem: number }> = {
      a: { cpu: 30, mem: 10 },
      b: { cpu: 10, mem: 30 },
    };
    const metric = (p: Pod) => usage[p.metadata.name];
    const a = pod({ metadata: { name: "a", uid: "1" } });
    const b = pod({ metadata: { name: "b", uid: "2" } });
    expect([a, b].sort(optByValue("cpu", metric).compare).map((p) => p.metadata.name)).toEqual(["b", "a"]);
    expect([a, b].sort(optByValue("mem", metric).compare).map((p) => p.metadata.name)).toEqual(["a", "b"]);
  });
});

describe("matchesPhase", () => {
  test("all matches everything", () => {
    expect(matchesPhase(pod({}), "all")).toBe(true);
  });
  test("failed matches Failed phase", () => {
    expect(matchesPhase(pod({ status: { phase: "Failed" } }), "failed")).toBe(true);
    expect(matchesPhase(pod({}), "failed")).toBe(false);
  });
  test("notReady matches when a container is not ready", () => {
    const p = pod({ status: { phase: "Running", containerStatuses: [{ name: "c", ready: false, restartCount: 0 } as any] } });
    expect(matchesPhase(p, "notReady")).toBe(true);
  });
  test("running matches Running phase", () => {
    expect(matchesPhase(pod({ status: { phase: "Running" } }), "running")).toBe(true);
    expect(matchesPhase(pod({ status: { phase: "Pending" } }), "running")).toBe(false);
  });
  test("pending matches Pending phase", () => {
    expect(matchesPhase(pod({ status: { phase: "Pending" } }), "pending")).toBe(true);
    expect(matchesPhase(pod({ status: { phase: "Running" } }), "pending")).toBe(false);
  });
  test("crashloop matches error pods via podHasError", () => {
    const crashing = pod({ status: { containerStatuses: [{ name: "c", ready: false, restartCount: 9, state: { waiting: { reason: "CrashLoopBackOff" } } } as any] } });
    const failed = pod({ status: { phase: "Failed" } });
    const healthy = pod({ status: { phase: "Running", containerStatuses: [{ name: "c", ready: true, restartCount: 0 } as any] } });
    expect(matchesPhase(crashing, "crashloop")).toBe(true);
    expect(matchesPhase(failed, "crashloop")).toBe(true);
    expect(matchesPhase(healthy, "crashloop")).toBe(false);
  });
});
