import { describe, expect, test } from "vitest";
import {
  detectLogErrors,
  detectUnhealthyPods,
  detectDegradedDeployments,
  fingerprint,
  type Incident,
} from "./detector.js";

function podList(...items: unknown[]) {
  return { items };
}

function runningPod(name: string, namespace = "default") {
  return {
    metadata: { name, namespace },
    status: { phase: "Running", containerStatuses: [{ restartCount: 0, state: { running: {} } }] },
  };
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

describe("detectLogErrors", () => {
  const PANIC = "panic: runtime error: nil map write\ngoroutine 1 [running]:\nmain.go:10";

  test("flags a running pod whose recent logs show an error signature", async () => {
    const raw = podList(runningPod("memos-abc"));
    const incidents = await detectLogErrors(raw, new Set(), async () => PANIC);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      incidentKind: "loggedError",
      namespace: "default",
      name: "memos-abc",
    });
    // reason is the stable signature, so it fingerprints/dedupes across ticks
    expect(incidents[0]?.reason).toBeTruthy();
  });

  test("skips pods already flagged by the status checks (no double-report)", async () => {
    const raw = podList(runningPod("memos-abc"));
    const tail = async () => PANIC;
    const incidents = await detectLogErrors(raw, new Set(["default/memos-abc"]), tail);
    expect(incidents).toEqual([]);
  });

  test("does not scan non-Running pods", async () => {
    const raw = podList({
      metadata: { name: "pending-1", namespace: "default" },
      status: { phase: "Pending" },
    });
    let tailed = 0;
    await detectLogErrors(raw, new Set(), async () => {
      tailed++;
      return PANIC;
    });
    expect(tailed).toBe(0);
  });

  test("skips pods whose logs could not be read (tailer returned null)", async () => {
    const raw = podList(runningPod("memos-abc"));
    const incidents = await detectLogErrors(raw, new Set(), async () => null);
    expect(incidents).toEqual([]);
  });

  test("does not flag a running pod with healthy logs", async () => {
    const raw = podList(runningPod("ok"));
    const incidents = await detectLogErrors(raw, new Set(), async () => "INFO all good\nINFO serving");
    expect(incidents).toEqual([]);
  });

  test("fingerprint of a log-error incident is stable across the signature reason", async () => {
    const raw = podList(runningPod("memos-abc"));
    const incidents = await detectLogErrors(raw, new Set(), async () => PANIC);
    const fp = fingerprint(incidents[0]!);
    expect(fp.startsWith("loggedError|default|memos-abc|")).toBe(true);
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
