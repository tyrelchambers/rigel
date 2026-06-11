import { test, expect } from "bun:test";
import { buildSuggestions, groupWarnings } from "./suggestions";

test("always includes the Investigate fallback last", () => {
  const out = buildSuggestions({ pods: [], deployments: [], nodes: [], events: [] });
  expect(out.length).toBe(1);
  expect(out[0]!.id).toBe("investigate");
});

test("surfaces unhealthy pods, ordered by restarts", () => {
  const pods = [
    { metadata: { name: "a", uid: "a" }, status: { containerStatuses: [{ restartCount: 2, state: { waiting: { reason: "CrashLoopBackOff" } } }] } },
    { metadata: { name: "b", uid: "b" }, status: { containerStatuses: [{ restartCount: 9, state: { waiting: { reason: "ImagePullBackOff" } } }] } },
    { metadata: { name: "ok", uid: "ok" }, status: { phase: "Running", containerStatuses: [{ restartCount: 0 }] } },
  ];
  const out = buildSuggestions({ pods, deployments: [], nodes: [], events: [] });
  expect(out.map((p) => p.id)).toEqual(["pod-b", "pod-a", "investigate"]);
  expect(out[0]!.label.toLowerCase()).toContain("imagepullbackoff");
});

test("degraded deployments + node pressure", () => {
  const out = buildSuggestions({
    pods: [],
    deployments: [{ metadata: { name: "web", uid: "w" }, spec: { replicas: 3 }, status: { readyReplicas: 1 } }],
    nodes: [{ metadata: { name: "n1", uid: "n1" }, status: { conditions: [{ type: "MemoryPressure", status: "True" }, { type: "Ready", status: "True" }] } }],
    events: [],
  });
  const ids = out.map((p) => p.id);
  expect(ids).toContain("dep-w");
  expect(out.find((p) => p.id === "node-n1")?.label).toBe("n1: node pressure");
});

test("groups warning events by reason|kind|namespace, summing counts", () => {
  const events = [
    { type: "Warning", reason: "BackOff", count: 5, involvedObject: { kind: "Pod", name: "p1", namespace: "default" }, message: "x" },
    { type: "Warning", reason: "BackOff", count: 4, involvedObject: { kind: "Pod", name: "p2", namespace: "default" }, message: "x" },
    { type: "Warning", reason: "FailedMount", count: 1, involvedObject: { kind: "Pod", name: "p3", namespace: "kube-system" }, message: "y" },
  ];
  const groups = groupWarnings(events);
  expect(groups[0]!.reason).toBe("BackOff");
  expect(groups[0]!.total).toBe(9);
  expect(groups[0]!.objectNames).toEqual(["p1", "p2"]);
});

test("warning chips only appear with a surge (>=3 events)", () => {
  const ev = { type: "Warning", reason: "BackOff", count: 1, involvedObject: { kind: "Pod", name: "p", namespace: "default" }, message: "x" };
  expect(buildSuggestions({ pods: [], deployments: [], nodes: [], events: [ev, ev] }).some((p) => p.kind === "warn")).toBe(false);
  expect(buildSuggestions({ pods: [], deployments: [], nodes: [], events: [ev, ev, ev] }).some((p) => p.kind === "warn")).toBe(true);
});
