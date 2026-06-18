import { describe, expect, test } from "vitest";
import type { Deployment } from "./types";
import type { Pod } from "../pods/types";
import {
  relativeAge,
  readyText,
  isReady,
  readyColorClass,
  desiredReplicas,
  totalReplicas,
  podHasError,
  childPods,
  hasErrorPods,
  isRedeploying,
  statusColor,
  rolloutProgress,
  imageRepo,
  imageTag,
  firstImage,
  containerSummaries,
  strategyDescription,
  selectorString,
  matchesSearch,
  sortDeployments,
  namespaceOptions,
} from "./deploymentDisplay";

function dep(overrides: Partial<Deployment> = {}): Deployment {
  return {
    metadata: {
      name: "web",
      namespace: "default",
      uid: "u1",
      ...overrides.metadata,
    },
    spec: { replicas: 1, ...overrides.spec },
    status: overrides.status,
  };
}

function pod(overrides: Partial<Pod> = {}): Pod {
  return {
    metadata: { name: "web-abc", namespace: "default", uid: "p1", ...overrides.metadata },
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
  test("now is 0s; future clamps; missing/invalid yields dash", () => {
    expect(relativeAge("2026-06-09T12:00:00Z", now)).toBe("0s");
    expect(relativeAge("2026-06-09T12:00:30Z", now)).toBe("0s");
    expect(relativeAge(undefined, now)).toBe("—");
    expect(relativeAge("not-a-date", now)).toBe("—");
  });
});

describe("replica counts", () => {
  test("desired defaults to 1 when spec.replicas missing", () => {
    expect(desiredReplicas({ metadata: { name: "x" } })).toBe(1);
    expect(desiredReplicas(dep({ spec: { replicas: 3 } }))).toBe(3);
    expect(desiredReplicas(dep({ spec: { replicas: 0 } }))).toBe(0);
  });
  test("total = status.replicas ?? spec.replicas ?? 0", () => {
    expect(totalReplicas(dep({ spec: { replicas: 3 }, status: { replicas: 2 } }))).toBe(2);
    expect(totalReplicas(dep({ spec: { replicas: 3 } }))).toBe(3);
    expect(totalReplicas({ metadata: { name: "x" } })).toBe(0);
  });
});

describe("readyText / readiness", () => {
  test("readyText is ready/total", () => {
    expect(readyText(dep({ spec: { replicas: 3 }, status: { replicas: 3, readyReplicas: 2 } }))).toBe("2/3");
    expect(readyText(dep({ spec: { replicas: 1 } }))).toBe("0/1");
  });
  test("isReady true only when readyReplicas == total and total > 0", () => {
    expect(isReady(dep({ spec: { replicas: 2 }, status: { replicas: 2, readyReplicas: 2 } }))).toBe(true);
    expect(isReady(dep({ spec: { replicas: 2 }, status: { replicas: 2, readyReplicas: 1 } }))).toBe(false);
    expect(isReady(dep({ spec: { replicas: 0 }, status: { replicas: 0, readyReplicas: 0 } }))).toBe(false);
  });
  test("readyColorClass green when ready else red", () => {
    expect(readyColorClass(dep({ spec: { replicas: 1 }, status: { replicas: 1, readyReplicas: 1 } }))).toContain("green");
    expect(readyColorClass(dep({ spec: { replicas: 1 }, status: { replicas: 1, readyReplicas: 0 } }))).toContain("red");
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

describe("childPods", () => {
  const d = dep({ spec: { replicas: 2, selector: { matchLabels: { app: "web" } } } });
  test("matches pods in same ns whose labels superset the selector", () => {
    const match = pod({ metadata: { name: "web-1", namespace: "default", uid: "1", labels: { app: "web", pod: "x" } } });
    const wrongNs = pod({ metadata: { name: "web-2", namespace: "other", uid: "2", labels: { app: "web" } } });
    const wrongLabel = pod({ metadata: { name: "api-1", namespace: "default", uid: "3", labels: { app: "api" } } });
    expect(childPods(d, [match, wrongNs, wrongLabel])).toEqual([match]);
  });
  test("empty selector matches nothing", () => {
    expect(childPods(dep(), [pod()])).toEqual([]);
  });
});

describe("isRedeploying", () => {
  test("true when desired>0, no errors, updated/ready != desired", () => {
    const d = dep({ spec: { replicas: 3 }, status: { replicas: 3, readyReplicas: 1, updatedReplicas: 2 } });
    expect(isRedeploying(d, [])).toBe(true);
  });
  test("false when stable", () => {
    const d = dep({ spec: { replicas: 3 }, status: { replicas: 3, readyReplicas: 3, updatedReplicas: 3 } });
    expect(isRedeploying(d, [])).toBe(false);
  });
  test("false when scaled to zero", () => {
    expect(isRedeploying(dep({ spec: { replicas: 0 }, status: {} }), [])).toBe(false);
  });
  test("false when error pods present", () => {
    const d = dep({ spec: { replicas: 3, selector: { matchLabels: { app: "web" } } }, status: { replicas: 3, readyReplicas: 1, updatedReplicas: 2 } });
    const errPod = pod({ metadata: { name: "web-1", namespace: "default", uid: "1", labels: { app: "web" } }, status: { containerStatuses: [{ name: "c", ready: false, restartCount: 9, state: { waiting: { reason: "CrashLoopBackOff" } } }] } });
    expect(isRedeploying(d, [errPod])).toBe(false);
  });
});

describe("statusColor", () => {
  const sel = { matchLabels: { app: "web" } };
  test("red when error pods", () => {
    const d = dep({ spec: { replicas: 2, selector: sel }, status: { replicas: 2, readyReplicas: 1 } });
    const errPod = pod({ metadata: { name: "web-1", namespace: "default", uid: "1", labels: { app: "web" } }, status: { phase: "Failed" } });
    expect(statusColor(d, [errPod])).toContain("red");
  });
  test("yellow when scaled to zero", () => {
    expect(statusColor(dep({ spec: { replicas: 0 }, status: {} }), [])).toContain("yellow");
  });
  test("green when redeploying", () => {
    const d = dep({ spec: { replicas: 3 }, status: { replicas: 3, readyReplicas: 1, updatedReplicas: 2 } });
    expect(statusColor(d, [])).toContain("green");
  });
  test("default foreground when stable", () => {
    const d = dep({ spec: { replicas: 2 }, status: { replicas: 2, readyReplicas: 2, updatedReplicas: 2 } });
    expect(statusColor(d, [])).toBe("text-foreground");
  });
});

describe("rolloutProgress", () => {
  test("updated / desired clamped to 0..1", () => {
    expect(rolloutProgress(dep({ spec: { replicas: 4 }, status: { updatedReplicas: 2 } }))).toBe(0.5);
    expect(rolloutProgress(dep({ spec: { replicas: 0 }, status: { updatedReplicas: 0 } }))).toBe(0);
    expect(rolloutProgress(dep({ spec: { replicas: 2 }, status: { updatedReplicas: 5 } }))).toBe(1);
  });
});

describe("image parsing", () => {
  test("imageRepo strips tag and digest", () => {
    expect(imageRepo("ghcr.io/foo/bar:v1.2.3")).toBe("ghcr.io/foo/bar");
    expect(imageRepo("ghcr.io/foo/bar@sha256:abc123def")).toBe("ghcr.io/foo/bar");
    expect(imageRepo("nginx")).toBe("nginx");
    expect(imageRepo("localhost:5000/app:dev")).toBe("localhost:5000/app");
    expect(imageRepo(undefined)).toBe("—");
  });
  test("imageTag extracts tag, short digest, or latest", () => {
    expect(imageTag("ghcr.io/foo/bar:v1.2.3")).toBe("v1.2.3");
    expect(imageTag("nginx")).toBe("latest");
    expect(imageTag("localhost:5000/app:dev")).toBe("dev");
    expect(imageTag("ghcr.io/foo/bar@sha256:abc123def456")).toBe("@abc123d");
    expect(imageTag("foo@deadbeefcafef00d")).toBe("@deadbee");
    expect(imageTag(undefined)).toBe("latest");
  });
  test("firstImage reads first container image", () => {
    expect(firstImage(dep({ spec: { template: { spec: { containers: [{ name: "web", image: "nginx:1" }] } } } }))).toBe("nginx:1");
    expect(firstImage(dep())).toBeUndefined();
  });
});

describe("containerSummaries", () => {
  test("maps name/image/ports/resources", () => {
    const d = dep({
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "web",
                image: "nginx:1",
                ports: [{ containerPort: 8080 }, { containerPort: 8443 }],
                resources: { requests: { cpu: "250m", memory: "256Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
              },
            ],
          },
        },
      },
    });
    expect(containerSummaries(d)).toEqual([
      { name: "web", image: "nginx:1", ports: [8080, 8443], cpuReq: "250m", cpuLim: "500m", memReq: "256Mi", memLim: "512Mi" },
    ]);
  });
  test("empty when no containers", () => {
    expect(containerSummaries(dep())).toEqual([]);
  });
});

describe("strategyDescription", () => {
  test("RollingUpdate with surge/unavailable", () => {
    const d = dep({ spec: { strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } } } });
    expect(strategyDescription(d)).toBe("RollingUpdate · maxSurge 25% · maxUnavailable 25%");
  });
  test("Recreate has no rolling params", () => {
    expect(strategyDescription(dep({ spec: { strategy: { type: "Recreate" } } }))).toBe("Recreate");
  });
  test("defaults to RollingUpdate when missing", () => {
    expect(strategyDescription(dep())).toBe("RollingUpdate");
  });
});

describe("selectorString", () => {
  test("sorted key=value pairs", () => {
    expect(selectorString(dep({ spec: { selector: { matchLabels: { tier: "frontend", app: "web" } } } }))).toBe("app=web,tier=frontend");
  });
  test("dash when empty", () => {
    expect(selectorString(dep())).toBe("—");
  });
});

describe("matchesSearch", () => {
  const d = dep({
    metadata: { name: "memos", namespace: "apps", uid: "u1" },
    spec: { replicas: 1, template: { spec: { containers: [{ name: "memos", image: "ghcr.io/usememos/memos:0.22" }] } } },
  });
  test("empty query matches everything", () => {
    expect(matchesSearch(d, "")).toBe(true);
    expect(matchesSearch(d, "   ")).toBe(true);
  });
  test("case-insensitive match on name, namespace, image repo", () => {
    expect(matchesSearch(d, "MEMOS")).toBe(true);
    expect(matchesSearch(d, "apps")).toBe(true);
    expect(matchesSearch(d, "usememos")).toBe(true);
  });
  test("does not match against tag", () => {
    expect(matchesSearch(d, "0.22")).toBe(false);
  });
  test("no match returns false", () => {
    expect(matchesSearch(d, "nginx")).toBe(false);
  });
});

describe("sortDeployments", () => {
  test("sorts by namespace then name", () => {
    const a = dep({ metadata: { name: "z", namespace: "a", uid: "1" } });
    const b = dep({ metadata: { name: "a", namespace: "b", uid: "2" } });
    const c = dep({ metadata: { name: "a", namespace: "a", uid: "3" } });
    const sorted = sortDeployments([a, b, c]).map((d) => `${d.metadata.namespace}/${d.metadata.name}`);
    expect(sorted).toEqual(["a/a", "a/z", "b/a"]);
  });
});

describe("hasErrorPods", () => {
  test("true when a child pod is failing", () => {
    const d = dep({ spec: { replicas: 1, selector: { matchLabels: { app: "web" } } } });
    const p = pod({ metadata: { name: "web-1", namespace: "default", uid: "1", labels: { app: "web" } }, status: { phase: "Failed" } });
    expect(hasErrorPods(d, [p])).toBe(true);
  });
  test("false with no matching pods", () => {
    expect(hasErrorPods(dep({ spec: { selector: { matchLabels: { app: "web" } } } }), [])).toBe(false);
  });
});

describe("namespaceOptions", () => {
  test("merges, dedupes and sorts deployment + store namespaces", () => {
    const a = dep({ metadata: { name: "x", namespace: "prod", uid: "1" } });
    const b = dep({ metadata: { name: "y", namespace: "dev", uid: "2" } });
    expect(namespaceOptions([a, b], { staging: {}, prod: {} })).toEqual(["dev", "prod", "staging"]);
  });
});
