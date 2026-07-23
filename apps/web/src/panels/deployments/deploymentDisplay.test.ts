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
  namespaceOptions,
  totalRestarts,
  deploymentRevision,
  deploymentEndpoints,
  deploymentSortOptions,
  matchesStatus,
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

describe("totalRestarts", () => {
  const d = dep({ spec: { replicas: 2, selector: { matchLabels: { app: "web" } } } });
  test("sums container restarts across child pods only", () => {
    const a = pod({ metadata: { name: "web-1", namespace: "default", uid: "1", labels: { app: "web" } }, status: { containerStatuses: [{ name: "c", ready: true, restartCount: 2 }] } });
    const b = pod({ metadata: { name: "web-2", namespace: "default", uid: "2", labels: { app: "web" } }, status: { containerStatuses: [{ name: "c", ready: true, restartCount: 3 }] } });
    const other = pod({ metadata: { name: "api-1", namespace: "default", uid: "3", labels: { app: "api" } }, status: { containerStatuses: [{ name: "c", ready: true, restartCount: 99 }] } });
    expect(totalRestarts(d, [a, b, other])).toBe(5);
  });
  test("zero with no matching pods", () => {
    expect(totalRestarts(d, [])).toBe(0);
  });
});

describe("deploymentRevision", () => {
  test("reads the rollout-revision annotation", () => {
    expect(deploymentRevision(dep({ metadata: { name: "web", uid: "u1", annotations: { "deployment.kubernetes.io/revision": "12" } } }))).toBe("12");
  });
  test("null when absent", () => {
    expect(deploymentRevision(dep())).toBeNull();
  });
});

describe("deploymentEndpoints", () => {
  const d = dep({
    metadata: { name: "big-o", namespace: "default", uid: "u1" },
    spec: { selector: { matchLabels: { app: "big-o" } }, template: { metadata: { labels: { app: "big-o" } }, spec: { containers: [] } } },
  });
  const svc = { "default/big-o": { metadata: { name: "big-o", namespace: "default" }, spec: { selector: { app: "big-o" } } } };

  test("https when ingress TLS covers the host", () => {
    const ing = { "default/big-o": { metadata: { name: "big-o", namespace: "default" }, spec: {
      tls: [{ hosts: ["big-o.tyrelchambers.com"] }],
      rules: [{ host: "big-o.tyrelchambers.com", http: { paths: [{ path: "/", backend: { service: { name: "big-o", port: { number: 80 } } } }] } }],
    } } };
    expect(deploymentEndpoints(d, svc, ing)).toEqual([{ host: "big-o.tyrelchambers.com", url: "https://big-o.tyrelchambers.com/" }]);
  });

  test("http when no TLS, and wildcard hosts are skipped", () => {
    const ing = { "default/big-o": { metadata: { name: "big-o", namespace: "default" }, spec: {
      rules: [
        { host: "big-o.local", http: { paths: [{ path: "/", backend: { service: { name: "big-o", port: { number: 80 } } } }] } },
        { http: { paths: [{ path: "/", backend: { service: { name: "big-o", port: { number: 80 } } } }] } },
      ],
    } } };
    expect(deploymentEndpoints(d, svc, ing)).toEqual([{ host: "big-o.local", url: "http://big-o.local/" }]);
  });

  test("empty when no service selects the deployment's pods", () => {
    const ing = { "default/x": { metadata: { name: "x", namespace: "default" }, spec: { rules: [{ host: "x.local", http: { paths: [{ path: "/", backend: { service: { name: "other", port: { number: 80 } } } }] } }] } } };
    expect(deploymentEndpoints(d, {}, ing)).toEqual([]);
  });
});

describe("deploymentSortOptions", () => {
  const optByValue = (v: string) => deploymentSortOptions([]).find((o) => o.value === v)!;

  test("sorts by replicas ascending", () => {
    const a = dep({ metadata: { name: "a", uid: "1" }, spec: { replicas: 3 } });
    const b = dep({ metadata: { name: "b", uid: "2" }, spec: { replicas: 1 } });
    const sorted = [a, b].sort(optByValue("replicas").compare);
    expect(sorted.map((d) => d.metadata.name)).toEqual(["b", "a"]);
  });

  test("namespace option breaks ties by name", () => {
    const a = dep({ metadata: { name: "b", namespace: "ns", uid: "1" } });
    const b = dep({ metadata: { name: "a", namespace: "ns", uid: "2" } });
    const sorted = [a, b].sort(optByValue("namespace").compare);
    expect(sorted.map((d) => d.metadata.name)).toEqual(["a", "b"]);
  });

  test("sorts by name", () => {
    const a = dep({ metadata: { name: "b", uid: "1" } });
    const b = dep({ metadata: { name: "a", uid: "2" } });
    const sorted = [a, b].sort(optByValue("name").compare);
    expect(sorted.map((d) => d.metadata.name)).toEqual(["a", "b"]);
  });

  test("sorts by ready fraction, guarding divide-by-zero", () => {
    const zero = dep({ metadata: { name: "zero", uid: "1" }, spec: { replicas: 0 }, status: {} });
    const partial = dep({ metadata: { name: "partial", uid: "2" }, spec: { replicas: 4 }, status: { replicas: 4, readyReplicas: 1 } });
    const full = dep({ metadata: { name: "full", uid: "3" }, spec: { replicas: 2 }, status: { replicas: 2, readyReplicas: 2 } });
    const sorted = [full, zero, partial].sort(optByValue("ready").compare);
    expect(sorted.map((d) => d.metadata.name)).toEqual(["zero", "partial", "full"]);
  });

  test("sorts by restarts summed from child pods", () => {
    const a = dep({ metadata: { name: "a", uid: "1" }, spec: { replicas: 1, selector: { matchLabels: { app: "a" } } } });
    const b = dep({ metadata: { name: "b", uid: "2" }, spec: { replicas: 1, selector: { matchLabels: { app: "b" } } } });
    const podsForSort = [
      pod({ metadata: { name: "a-1", namespace: "default", uid: "p1", labels: { app: "a" } }, status: { containerStatuses: [{ name: "c", ready: true, restartCount: 5 }] } }),
      pod({ metadata: { name: "b-1", namespace: "default", uid: "p2", labels: { app: "b" } }, status: { containerStatuses: [{ name: "c", ready: true, restartCount: 1 }] } }),
    ];
    const sorted = [a, b].sort(deploymentSortOptions(podsForSort).find((o) => o.value === "restarts")!.compare);
    expect(sorted.map((d) => d.metadata.name)).toEqual(["b", "a"]);
  });

  test("sorts by age", () => {
    const older = dep({ metadata: { name: "older", uid: "1", creationTimestamp: "2026-01-01T00:00:00Z" } });
    const newer = dep({ metadata: { name: "newer", uid: "2", creationTimestamp: "2026-06-01T00:00:00Z" } });
    const sorted = [newer, older].sort(optByValue("age").compare);
    expect(sorted.map((d) => d.metadata.name)).toEqual(["older", "newer"]);
  });
});

describe("matchesStatus", () => {
  const pods: Pod[] = [];

  test("all matches everything", () => {
    expect(matchesStatus(dep(), pods, "all")).toBe(true);
  });

  test("unhealthy matches when not fully ready", () => {
    const unhealthy = dep({ status: { replicas: 2, readyReplicas: 1 } });
    const healthy = dep({ status: { replicas: 1, readyReplicas: 1 } });
    expect(matchesStatus(unhealthy, pods, "unhealthy")).toBe(true);
    expect(matchesStatus(healthy, pods, "unhealthy")).toBe(false);
  });

  test("paused matches spec.paused", () => {
    expect(matchesStatus(dep({ spec: { replicas: 1, paused: true } }), pods, "paused")).toBe(true);
    expect(matchesStatus(dep(), pods, "paused")).toBe(false);
  });

  test("zero matches scaled-to-zero", () => {
    expect(matchesStatus(dep({ spec: { replicas: 0 } }), pods, "zero")).toBe(true);
    expect(matchesStatus(dep(), pods, "zero")).toBe(false);
  });

  test("scaled-to-zero does not match unhealthy", () => {
    expect(matchesStatus(dep({ spec: { replicas: 0 } }), pods, "unhealthy")).toBe(false);
  });

  test("rollingOut matches an active rollout", () => {
    const sel = { matchLabels: { app: "web" } };
    const rolling = dep({ spec: { replicas: 3, selector: sel }, status: { replicas: 3, readyReplicas: 1, updatedReplicas: 2 } });
    const stable = dep({ spec: { replicas: 1 }, status: { replicas: 1, readyReplicas: 1, updatedReplicas: 1 } });
    expect(matchesStatus(rolling, [], "rollingOut")).toBe(true);
    expect(matchesStatus(stable, [], "rollingOut")).toBe(false);
  });
});
