import { describe, expect, test } from "vitest";
import { CORDONED_BY_ANNOTATION, CORDONED_BY_VALUE, READY_STABLE_MS, detectSelfCordonedNodes, selfUncordonAction } from "./selfCordon.js";

const NOW = Date.parse("2026-10-11T12:00:00Z");

function node(
  name: string,
  opts: { unschedulable?: boolean; ours?: boolean; ready?: "True" | "False" | "Unknown"; readySinceMs?: number },
): Record<string, unknown> {
  return {
    metadata: {
      name,
      annotations: opts.ours ? { [CORDONED_BY_ANNOTATION]: CORDONED_BY_VALUE } : {},
    },
    spec: opts.unschedulable ? { unschedulable: true } : {},
    status: {
      conditions: opts.ready
        ? [{ type: "Ready", status: opts.ready, lastTransitionTime: new Date(NOW - (opts.readySinceMs ?? 0)).toISOString() }]
        : [],
    },
  };
}

describe("detectSelfCordonedNodes", () => {
  test("uncordons a node we cordoned once it has been Ready for the stable window", () => {
    const r = detectSelfCordonedNodes([node("n1", { unschedulable: true, ours: true, ready: "True", readySinceMs: READY_STABLE_MS })], NOW);
    expect(r.incidents).toEqual([{ incidentKind: "cordonedNode", namespace: "", name: "n1", reason: "ReadyAgain", detail: "cordoned by the assistant, Ready for 5m" }]);
    expect(r.stale).toEqual([]);
  });

  test("waits while Ready is too recent to trust", () => {
    const r = detectSelfCordonedNodes([node("n1", { unschedulable: true, ours: true, ready: "True", readySinceMs: READY_STABLE_MS - 1 })], NOW);
    expect(r).toEqual({ incidents: [], stale: [] });
  });

  test("leaves a still-unhealthy node cordoned", () => {
    const r = detectSelfCordonedNodes(
      [
        node("n1", { unschedulable: true, ours: true, ready: "False", readySinceMs: READY_STABLE_MS * 10 }),
        node("n2", { unschedulable: true, ours: true, ready: "Unknown", readySinceMs: READY_STABLE_MS * 10 }),
        node("n3", { unschedulable: true, ours: true }),
      ],
      NOW,
    );
    expect(r).toEqual({ incidents: [], stale: [] });
  });

  test("never touches a node someone else cordoned", () => {
    const r = detectSelfCordonedNodes([node("n1", { unschedulable: true, ready: "True", readySinceMs: READY_STABLE_MS * 10 })], NOW);
    expect(r).toEqual({ incidents: [], stale: [] });
  });

  test("flags our marker as stale once the node was uncordoned by someone else", () => {
    const r = detectSelfCordonedNodes([node("n1", { ours: true, ready: "True", readySinceMs: READY_STABLE_MS * 10 })], NOW);
    expect(r).toEqual({ incidents: [], stale: ["n1"] });
  });
});

test("selfUncordonAction proposes an uncordon for the incident's node", () => {
  expect(selfUncordonAction("n1")).toEqual({ kind: "uncordon", node: "n1", label: "Uncordon n1 now that it's been healthy for 5 minutes" });
});
