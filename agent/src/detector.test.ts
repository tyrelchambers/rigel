import { describe, expect, test } from "vitest";
import {
  detectUnhealthyPods,
  detectDegradedDeployments,
  fingerprint,
  type Incident,
} from "./detector.js";

function podList(...items: unknown[]) {
  return { items };
}

describe("detectUnhealthyPods", () => {
  test("flags a CrashLoopBackOff pod with its restart count", () => {
    const raw = podList({
      metadata: { name: "memos-abc", namespace: "default" },
      status: {
        phase: "Running",
        containerStatuses: [
          { restartCount: 7, state: { waiting: { reason: "CrashLoopBackOff" } } },
        ],
      },
    });
    const incidents = detectUnhealthyPods(raw);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      incidentKind: "unhealthyPod",
      namespace: "default",
      name: "memos-abc",
      reason: "CrashLoopBackOff",
      restarts: 7,
    });
  });

  test("flags an OOMKilled container from its last terminated state", () => {
    const raw = podList({
      metadata: { name: "api-1", namespace: "prod" },
      status: {
        phase: "Running",
        containerStatuses: [
          { restartCount: 2, state: { running: {} }, lastState: { terminated: { reason: "OOMKilled" } } },
        ],
      },
    });
    const incidents = detectUnhealthyPods(raw);
    expect(incidents[0]).toMatchObject({ name: "api-1", reason: "OOMKilled" });
  });

  test("flags ImagePullBackOff", () => {
    const raw = podList({
      metadata: { name: "broken", namespace: "default" },
      status: { phase: "Pending", containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } }] },
    });
    expect(detectUnhealthyPods(raw)[0]?.reason).toBe("ImagePullBackOff");
  });

  test("flags a pod in phase Failed", () => {
    const raw = podList({ metadata: { name: "f", namespace: "default" }, status: { phase: "Failed" } });
    expect(detectUnhealthyPods(raw)[0]?.reason).toBe("Failed");
  });

  test("ignores a healthy Running pod", () => {
    const raw = podList({
      metadata: { name: "ok", namespace: "default" },
      status: { phase: "Running", containerStatuses: [{ restartCount: 0, state: { running: {} } }] },
    });
    expect(detectUnhealthyPods(raw)).toEqual([]);
  });
});

describe("detectDegradedDeployments", () => {
  test("flags a deployment with ready < desired", () => {
    const raw = {
      items: [
        { metadata: { name: "api", namespace: "prod" }, spec: { replicas: 3 }, status: { readyReplicas: 1 } },
      ],
    };
    const incidents = detectDegradedDeployments(raw);
    expect(incidents[0]).toMatchObject({
      incidentKind: "degradedDeployment",
      namespace: "prod",
      name: "api",
      reason: "Degraded",
      detail: "1/3 ready",
    });
  });

  test("ignores a fully-ready deployment", () => {
    const raw = {
      items: [{ metadata: { name: "ok", namespace: "default" }, spec: { replicas: 2 }, status: { readyReplicas: 2 } }],
    };
    expect(detectDegradedDeployments(raw)).toEqual([]);
  });

  test("ignores a deployment scaled to zero (desired 0)", () => {
    const raw = {
      items: [{ metadata: { name: "z", namespace: "default" }, spec: { replicas: 0 }, status: {} }],
    };
    expect(detectDegradedDeployments(raw)).toEqual([]);
  });
});

describe("fingerprint", () => {
  const base: Incident = {
    incidentKind: "unhealthyPod",
    namespace: "default",
    name: "memos-abc",
    reason: "CrashLoopBackOff",
    detail: "",
  };

  test("is stable regardless of restart count (so we dedup across polls)", () => {
    expect(fingerprint({ ...base, restarts: 7 })).toBe(fingerprint({ ...base, restarts: 99 }));
  });

  test("differs when the reason changes", () => {
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, reason: "OOMKilled" }));
  });

  test("differs across resources", () => {
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, name: "other" }));
  });
});
