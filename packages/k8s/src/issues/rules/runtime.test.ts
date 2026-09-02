import { describe, it, expect } from "vitest";
import { runtimeRules } from "./runtime";

function pod(over: Record<string, any> = {}): Record<string, any> {
  return {
    metadata: { name: "api-0", namespace: "default" },
    status: { phase: "Running", containerStatuses: [], startTime: "2026-01-01T00:00:00Z" },
    ...over,
  };
}

function deployment(over: Record<string, any> = {}): Record<string, any> {
  return {
    metadata: { name: "api", namespace: "default" },
    spec: { replicas: 3 },
    status: { readyReplicas: 3, conditions: [] },
    ...over,
  };
}

describe("crashLoopBackOff", () => {
  it("fires on a waiting CrashLoopBackOff container", () => {
    const out = runtimeRules({
      pods: [
        pod({
          status: {
            phase: "Running",
            startTime: "2026-01-01T00:00:00Z",
            containerStatuses: [
              {
                name: "api",
                restartCount: 7,
                state: {
                  waiting: {
                    reason: "CrashLoopBackOff",
                    message: "back-off 5m0s restarting failed container",
                  },
                },
              },
            ],
          },
        }),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].rule).toBe("crashLoopBackOff");
    expect(out[0].severity).toBe("critical");
    expect(out[0].evidence).toBe("back-off 5m0s restarting failed container");
    expect(out[0].subject).toEqual({ kind: "Pod", namespace: "default", name: "api-0" });
    expect(out[0].onsetAt).toBe("2026-01-01T00:00:00Z");
    expect(out[0].fingerprint).toBe("");
    expect(out[0].fix).toBeUndefined();
  });

  it("does not fire on a healthy running pod", () => {
    const out = runtimeRules({
      pods: [
        pod({
          status: {
            phase: "Running",
            containerStatuses: [{ name: "api", restartCount: 0, state: { running: {} } }],
          },
        }),
      ],
    });
    expect(out).toEqual([]);
  });

  it("offers a rollout restart when the pod resolves to a Deployment", () => {
    const out = runtimeRules({
      pods: [
        pod({
          metadata: {
            name: "api-6d4b9c7f8-xk2ql",
            namespace: "default",
            ownerReferences: [{ kind: "ReplicaSet", name: "api-6d4b9c7f8" }],
          },
          status: {
            phase: "Running",
            containerStatuses: [
              { name: "api", restartCount: 3, state: { waiting: { reason: "CrashLoopBackOff" } } },
            ],
          },
        }),
      ],
      deployments: [deployment()],
    });
    expect(out[0].fix).toEqual({
      label: "Restart rollout",
      destructive: false,
      command: ["rollout", "restart", "deployment/api", "-n", "default"],
    });
  });

  it("offers no fix when no Deployment owns the pod", () => {
    const out = runtimeRules({
      pods: [
        pod({
          metadata: {
            name: "api-6d4b9c7f8-xk2ql",
            namespace: "default",
            ownerReferences: [{ kind: "ReplicaSet", name: "api-6d4b9c7f8" }],
          },
          status: {
            phase: "Running",
            containerStatuses: [
              { name: "api", restartCount: 3, state: { waiting: { reason: "CrashLoopBackOff" } } },
            ],
          },
        }),
      ],
      deployments: [],
    });
    expect(out[0].fix).toBeUndefined();
  });
});

describe("imagePullBackOff", () => {
  it("fires on ImagePullBackOff and on ErrImagePull", () => {
    for (const reason of ["ImagePullBackOff", "ErrImagePull"]) {
      const out = runtimeRules({
        pods: [
          pod({
            status: {
              phase: "Pending",
              startTime: "2026-01-01T00:00:00Z",
              containerStatuses: [
                {
                  name: "api",
                  restartCount: 0,
                  state: {
                    waiting: { reason, message: 'Back-off pulling image "ghcr.io/acme/api:v9"' },
                  },
                },
              ],
            },
          }),
        ],
      });
      expect(out.map((i) => i.rule)).toEqual(["imagePullBackOff"]);
      expect(out[0].severity).toBe("critical");
      expect(out[0].evidence).toBe('Back-off pulling image "ghcr.io/acme/api:v9"');
      expect(out[0].fix).toBeUndefined();
    }
  });

  it("does not fire while a container is still being created", () => {
    const out = runtimeRules({
      pods: [
        pod({
          status: {
            phase: "Pending",
            containerStatuses: [
              { name: "api", restartCount: 0, state: { waiting: { reason: "ContainerCreating" } } },
            ],
          },
        }),
      ],
    });
    expect(out).toEqual([]);
  });
});

describe("oomKilled", () => {
  it("fires on a last terminated state of OOMKilled", () => {
    const out = runtimeRules({
      pods: [
        pod({
          status: {
            phase: "Running",
            startTime: "2026-01-01T00:00:00Z",
            containerStatuses: [
              {
                name: "api",
                restartCount: 2,
                state: { running: {} },
                lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } },
              },
            ],
          },
        }),
      ],
    });
    expect(out.map((i) => i.rule)).toEqual(["oomKilled"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].evidence).toBe("OOMKilled");
    expect(out[0].onsetAt).toBe("2026-01-01T00:00:00Z");
  });

  it("does not fire on a container that terminated with an ordinary error", () => {
    const out = runtimeRules({
      pods: [
        pod({
          status: {
            phase: "Running",
            containerStatuses: [
              {
                name: "api",
                restartCount: 1,
                state: { running: {} },
                lastState: { terminated: { reason: "Error", exitCode: 1 } },
              },
            ],
          },
        }),
      ],
    });
    expect(out).toEqual([]);
  });
});

describe("podUnschedulable", () => {
  it("fires on an Unschedulable PodScheduled condition", () => {
    const out = runtimeRules({
      pods: [
        pod({
          status: {
            phase: "Pending",
            startTime: "2026-01-01T00:00:00Z",
            containerStatuses: [],
            conditions: [
              {
                type: "PodScheduled",
                status: "False",
                reason: "Unschedulable",
                message: "0/3 nodes are available: 3 Insufficient cpu.",
                lastTransitionTime: "2026-02-02T03:04:05Z",
              },
            ],
          },
        }),
      ],
    });
    expect(out.map((i) => i.rule)).toEqual(["podUnschedulable"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].evidence).toBe("0/3 nodes are available: 3 Insufficient cpu.");
    expect(out[0].onsetAt).toBe("2026-02-02T03:04:05Z");
  });

  it("does not fire on a pod that has been scheduled", () => {
    const out = runtimeRules({
      pods: [
        pod({
          status: {
            phase: "Pending",
            containerStatuses: [],
            conditions: [
              {
                type: "PodScheduled",
                status: "True",
                lastTransitionTime: "2026-02-02T03:04:05Z",
              },
            ],
          },
        }),
      ],
    });
    expect(out).toEqual([]);
  });
});

describe("podEvicted", () => {
  it("fires on a Failed pod with an Evicted reason", () => {
    const out = runtimeRules({
      pods: [
        pod({
          status: {
            phase: "Failed",
            reason: "Evicted",
            message: "The node was low on resource: ephemeral-storage.",
            startTime: "2026-01-01T00:00:00Z",
          },
        }),
      ],
    });
    expect(out.map((i) => i.rule)).toEqual(["podEvicted"]);
    expect(out[0].severity).toBe("warning");
    expect(out[0].evidence).toBe("The node was low on resource: ephemeral-storage.");
    expect(out[0].fix).toEqual({
      label: "Delete pod",
      destructive: true,
      command: ["delete", "pod", "api-0", "-n", "default"],
    });
  });

  it("does not fire on a Failed pod that was not evicted", () => {
    const out = runtimeRules({
      pods: [pod({ status: { phase: "Failed", reason: "Error", startTime: "2026-01-01T00:00:00Z" } })],
    });
    expect(out.map((i) => i.rule)).toEqual(["podFailed"]);
  });
});

describe("podFailed", () => {
  it("fires on a pod in the Failed phase", () => {
    const out = runtimeRules({
      pods: [
        pod({
          status: {
            phase: "Failed",
            message: "Pod was terminated in response to imminent node shutdown.",
            startTime: "2026-01-01T00:00:00Z",
          },
        }),
      ],
    });
    expect(out.map((i) => i.rule)).toEqual(["podFailed"]);
    expect(out[0].severity).toBe("warning");
    expect(out[0].evidence).toBe("Pod was terminated in response to imminent node shutdown.");
    expect(out[0].onsetAt).toBe("2026-01-01T00:00:00Z");
    expect(out[0].fix).toEqual({
      label: "Delete pod",
      destructive: true,
      command: ["delete", "pod", "api-0", "-n", "default"],
    });
  });

  it("does not fire on a completed job pod", () => {
    const out = runtimeRules({
      pods: [
        pod({
          status: {
            phase: "Succeeded",
            startTime: "2026-01-01T00:00:00Z",
            containerStatuses: [
              {
                name: "api",
                restartCount: 0,
                state: { terminated: { reason: "Completed", exitCode: 0 } },
              },
            ],
          },
        }),
      ],
    });
    expect(out).toEqual([]);
  });
});

describe("restartStorm", () => {
  it("fires above the threshold on an otherwise running pod", () => {
    const out = runtimeRules({
      pods: [
        pod({
          status: {
            phase: "Running",
            startTime: "2026-01-01T00:00:00Z",
            containerStatuses: [{ name: "api", restartCount: 25, state: { running: {} } }],
          },
        }),
      ],
    });
    expect(out.map((i) => i.rule)).toEqual(["restartStorm"]);
    expect(out[0].severity).toBe("warning");
    expect(out[0].evidence).toBeUndefined();
    expect(out[0].onsetAt).toBe("2026-01-01T00:00:00Z");
  });

  it("does not fire at exactly the threshold", () => {
    const out = runtimeRules({
      pods: [
        pod({
          status: {
            phase: "Running",
            containerStatuses: [
              { name: "api", restartCount: 6, state: { running: {} } },
              { name: "sidecar", restartCount: 4, state: { running: {} } },
            ],
          },
        }),
      ],
    });
    expect(out).toEqual([]);
  });

  it("does not double-report a pod already in crash loop", () => {
    const out = runtimeRules({
      pods: [
        pod({
          status: {
            phase: "Running",
            containerStatuses: [
              { name: "api", restartCount: 25, state: { waiting: { reason: "CrashLoopBackOff" } } },
            ],
          },
        }),
      ],
    });
    expect(out.map((i) => i.rule)).toEqual(["crashLoopBackOff"]);
  });
});

describe("degradedDeployment", () => {
  it("fires when fewer replicas are ready than desired", () => {
    const out = runtimeRules({
      deployments: [
        deployment({
          spec: { replicas: 3 },
          status: {
            readyReplicas: 1,
            conditions: [
              {
                type: "Available",
                status: "False",
                message: "Deployment does not have minimum availability.",
                lastTransitionTime: "2026-03-03T00:00:00Z",
              },
            ],
          },
        }),
      ],
    });
    expect(out.map((i) => i.rule)).toEqual(["degradedDeployment"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].subject).toEqual({ kind: "Deployment", namespace: "default", name: "api" });
    expect(out[0].evidence).toBe("Deployment does not have minimum availability.");
    expect(out[0].onsetAt).toBe("2026-03-03T00:00:00Z");
    expect(out[0].fix).toEqual({
      label: "Restart rollout",
      destructive: false,
      command: ["rollout", "restart", "deployment/api", "-n", "default"],
    });
  });

  it("does not fire on a fully ready deployment", () => {
    const out = runtimeRules({ deployments: [deployment()] });
    expect(out).toEqual([]);
  });
});

describe("degradedStatefulSet", () => {
  it("fires when fewer replicas are ready than desired", () => {
    const out = runtimeRules({
      statefulsets: [
        {
          metadata: { name: "pg", namespace: "data" },
          spec: { replicas: 3 },
          status: { readyReplicas: 2 },
        },
      ],
    });
    expect(out.map((i) => i.rule)).toEqual(["degradedStatefulSet"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].subject).toEqual({ kind: "StatefulSet", namespace: "data", name: "pg" });
    expect(out[0].onsetAt).toBeUndefined();
    expect(out[0].fix).toEqual({
      label: "Restart rollout",
      destructive: false,
      command: ["rollout", "restart", "statefulset/pg", "-n", "data"],
    });
  });

  it("does not fire on a fully ready statefulset", () => {
    const out = runtimeRules({
      statefulsets: [
        {
          metadata: { name: "pg", namespace: "data" },
          spec: { replicas: 3 },
          status: { readyReplicas: 3 },
        },
      ],
    });
    expect(out).toEqual([]);
  });
});

describe("degradedDaemonSet", () => {
  it("fires when pods are unavailable", () => {
    const out = runtimeRules({
      daemonsets: [
        {
          metadata: { name: "node-exporter", namespace: "kube-system" },
          status: { numberUnavailable: 2, desiredNumberScheduled: 5 },
        },
      ],
    });
    expect(out.map((i) => i.rule)).toEqual(["degradedDaemonSet"]);
    expect(out[0].severity).toBe("warning");
    expect(out[0].fix).toEqual({
      label: "Restart rollout",
      destructive: false,
      command: ["rollout", "restart", "daemonset/node-exporter", "-n", "kube-system"],
    });
  });

  it("does not fire when every pod is available", () => {
    const out = runtimeRules({
      daemonsets: [
        {
          metadata: { name: "node-exporter", namespace: "kube-system" },
          status: { numberReady: 5, desiredNumberScheduled: 5 },
        },
      ],
    });
    expect(out).toEqual([]);
  });
});

describe("zeroReplicas", () => {
  it("fires on a deployment scaled to zero", () => {
    const out = runtimeRules({
      deployments: [deployment({ spec: { replicas: 0 }, status: {} })],
    });
    expect(out.map((i) => i.rule)).toEqual(["zeroReplicas"]);
    expect(out[0].severity).toBe("warning");
    expect(out[0].fix).toEqual({
      label: "Scale to 1",
      destructive: false,
      command: ["scale", "deployment/api", "--replicas=1", "-n", "default"],
    });
  });

  it("does not fire on a deployment with replicas", () => {
    const out = runtimeRules({
      deployments: [deployment({ spec: { replicas: 2 }, status: { readyReplicas: 2 } })],
    });
    expect(out).toEqual([]);
  });
});

describe("jobBackoffLimitExceeded", () => {
  it("fires on a Failed condition with reason BackoffLimitExceeded", () => {
    const out = runtimeRules({
      jobs: [
        {
          metadata: { name: "backup", namespace: "default" },
          status: {
            conditions: [
              {
                type: "Failed",
                status: "True",
                reason: "BackoffLimitExceeded",
                message: "Job has reached the specified backoff limit",
                lastTransitionTime: "2026-04-04T00:00:00Z",
              },
            ],
          },
        },
      ],
    });
    expect(out.map((i) => i.rule)).toEqual(["jobBackoffLimitExceeded"]);
    expect(out[0].severity).toBe("warning");
    expect(out[0].subject).toEqual({ kind: "Job", namespace: "default", name: "backup" });
    expect(out[0].evidence).toBe("Job has reached the specified backoff limit");
    expect(out[0].onsetAt).toBe("2026-04-04T00:00:00Z");
    expect(out[0].fix).toEqual({
      label: "Delete job",
      destructive: true,
      command: ["delete", "job", "backup", "-n", "default"],
    });
  });

  it("does not fire on a completed job", () => {
    const out = runtimeRules({
      jobs: [
        {
          metadata: { name: "backup", namespace: "default" },
          status: {
            succeeded: 1,
            conditions: [
              { type: "Complete", status: "True", lastTransitionTime: "2026-04-04T00:00:00Z" },
            ],
          },
        },
      ],
    });
    expect(out).toEqual([]);
  });

  it("does not fire on a job failed for another reason", () => {
    const out = runtimeRules({
      jobs: [
        {
          metadata: { name: "backup", namespace: "default" },
          status: {
            conditions: [
              {
                type: "Failed",
                status: "True",
                reason: "DeadlineExceeded",
                lastTransitionTime: "2026-04-04T00:00:00Z",
              },
            ],
          },
        },
      ],
    });
    expect(out).toEqual([]);
  });
});

describe("nodeNotReady", () => {
  it("fires when the Ready condition is not True", () => {
    const out = runtimeRules({
      nodes: [
        {
          metadata: { name: "worker-2" },
          status: {
            conditions: [
              {
                type: "Ready",
                status: "Unknown",
                message: "Kubelet stopped posting node status.",
                lastTransitionTime: "2026-05-05T00:00:00Z",
              },
            ],
          },
        },
      ],
    });
    expect(out.map((i) => i.rule)).toEqual(["nodeNotReady"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].subject).toEqual({ kind: "Node", namespace: "", name: "worker-2" });
    expect(out[0].evidence).toBe("Kubelet stopped posting node status.");
    expect(out[0].onsetAt).toBe("2026-05-05T00:00:00Z");
  });

  it("does not fire on a ready node", () => {
    const out = runtimeRules({
      nodes: [
        {
          metadata: { name: "worker-2" },
          status: {
            conditions: [
              { type: "Ready", status: "True", lastTransitionTime: "2026-05-05T00:00:00Z" },
              { type: "MemoryPressure", status: "False" },
            ],
          },
        },
      ],
    });
    expect(out).toEqual([]);
  });
});

describe("nodePressure", () => {
  it("fires on a pressure condition that is True", () => {
    const out = runtimeRules({
      nodes: [
        {
          metadata: { name: "worker-2" },
          status: {
            conditions: [
              { type: "Ready", status: "True" },
              {
                type: "MemoryPressure",
                status: "True",
                message: "kubelet has insufficient memory available",
                lastTransitionTime: "2026-06-06T00:00:00Z",
              },
              { type: "DiskPressure", status: "False" },
              { type: "PIDPressure", status: "False" },
            ],
          },
        },
      ],
    });
    expect(out.map((i) => i.rule)).toEqual(["nodePressure"]);
    expect(out[0].severity).toBe("warning");
    expect(out[0].evidence).toBe("kubelet has insufficient memory available");
    expect(out[0].onsetAt).toBe("2026-06-06T00:00:00Z");
  });

  it("does not fire when no pressure condition is True", () => {
    const out = runtimeRules({
      nodes: [
        {
          metadata: { name: "worker-2" },
          status: {
            conditions: [
              { type: "Ready", status: "True" },
              { type: "MemoryPressure", status: "False" },
              { type: "DiskPressure", status: "False" },
              { type: "PIDPressure", status: "False" },
            ],
          },
        },
      ],
    });
    expect(out).toEqual([]);
  });
});

describe("copy discipline", () => {
  it("uses no em-dash in any generated copy", () => {
    const out = runtimeRules({
      pods: [
        pod({
          status: {
            phase: "Running",
            containerStatuses: [
              { name: "api", restartCount: 3, state: { waiting: { reason: "CrashLoopBackOff" } } },
            ],
          },
        }),
      ],
      deployments: [deployment({ spec: { replicas: 3 }, status: { readyReplicas: 0 } })],
      daemonsets: [{ metadata: { name: "ds", namespace: "default" }, status: { numberUnavailable: 1 } }],
      nodes: [
        { metadata: { name: "n1" }, status: { conditions: [{ type: "Ready", status: "False" }] } },
      ],
    });
    expect(out.length).toBeGreaterThan(3);
    for (const i of out) {
      for (const text of [i.title, i.cause, i.whatsWrong, i.nextStep]) {
        expect(text).not.toContain("—");
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });
});
