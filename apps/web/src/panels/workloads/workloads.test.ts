import { describe, expect, test } from "vitest";
import type { Job, CronJob } from "./types";
import {
  jobPhase,
  jobDuration,
  jobCompletionsLabel,
  lastScheduleAgo,
  cronJobActiveCount,
  isCronJobSuspended,
  generateTriggerJobName,
  matchesSearch,
  readyFraction,
  readyColorClass,
  statefulSetReady,
  statefulSetDesired,
  daemonSetReady,
  daemonSetDesired,
  compareWorkloads,
  sortWorkloads,
  jobPhaseVariant,
} from "./workloadsDisplay";
import {
  formatSelector,
  workloadUpdateStrategy,
  workloadContainers,
  volumeClaimTemplateSummaries,
  jobConditionSummaries,
  cronJobActiveNames,
  workloadSpecFields,
} from "./workloadsDisplay";
import type { StatefulSet, DaemonSet } from "./types";

const NOW = 1_686_789_123_000; // fixed Date.now() in ms

function job(overrides: Partial<Job> = {}): Job {
  return {
    metadata: { name: "j", namespace: "default", ...overrides.metadata },
    spec: overrides.spec,
    status: overrides.status,
  };
}

function cron(overrides: Partial<CronJob> = {}): CronJob {
  return {
    metadata: { name: "c", namespace: "default", ...overrides.metadata },
    spec: overrides.spec,
    status: overrides.status,
  };
}

describe("jobPhaseVariant", () => {
  test("Complete and Running map to healthy", () => {
    expect(jobPhaseVariant("Complete")).toBe("healthy");
    expect(jobPhaseVariant("Running")).toBe("healthy");
  });
  test("Failed maps to error", () => {
    expect(jobPhaseVariant("Failed")).toBe("error");
  });
  test("other phases map to pending", () => {
    expect(jobPhaseVariant("Pending")).toBe("pending");
    expect(jobPhaseVariant("Suspended")).toBe("pending");
  });
});

describe("jobPhase", () => {
  test("Suspended when spec.suspend === true (wins over everything)", () => {
    expect(jobPhase(job({ spec: { suspend: true }, status: { active: 5 } }))).toBe("Suspended");
  });
  test("Failed when a Failed=True condition is present", () => {
    expect(
      jobPhase(job({ status: { conditions: [{ type: "Failed", status: "True" }] } })),
    ).toBe("Failed");
  });
  test("Complete when a Complete=True condition is present", () => {
    expect(
      jobPhase(job({ status: { conditions: [{ type: "Complete", status: "True" }] } })),
    ).toBe("Complete");
  });
  test("Failed takes precedence over Complete", () => {
    expect(
      jobPhase(
        job({
          status: {
            conditions: [
              { type: "Complete", status: "True" },
              { type: "Failed", status: "True" },
            ],
          },
        }),
      ),
    ).toBe("Failed");
  });
  test("Running when active > 0 and no terminal conditions", () => {
    expect(jobPhase(job({ status: { active: 2 } }))).toBe("Running");
  });
  test("Pending otherwise", () => {
    expect(jobPhase(job({ status: {} }))).toBe("Pending");
    expect(jobPhase(job())).toBe("Pending");
  });
  test("condition with status !== True is ignored", () => {
    expect(
      jobPhase(job({ status: { conditions: [{ type: "Failed", status: "False" }] } })),
    ).toBe("Pending");
  });
});

describe("jobDuration", () => {
  test("null when no startTime", () => {
    expect(jobDuration(job(), NOW)).toBeNull();
  });
  test("seconds when under a minute", () => {
    const start = new Date(NOW - 42_000).toISOString();
    const end = new Date(NOW).toISOString();
    expect(jobDuration(job({ status: { startTime: start, completionTime: end } }), NOW)).toBe("42s");
  });
  test("minutes between 1m and 1h", () => {
    const start = new Date(NOW - 5 * 60_000).toISOString();
    const end = new Date(NOW).toISOString();
    expect(jobDuration(job({ status: { startTime: start, completionTime: end } }), NOW)).toBe("5m");
  });
  test("hours when an hour or more", () => {
    const start = new Date(NOW - 2 * 3_600_000).toISOString();
    const end = new Date(NOW).toISOString();
    expect(jobDuration(job({ status: { startTime: start, completionTime: end } }), NOW)).toBe("2h");
  });
  test("uses now as the end when not completed", () => {
    const start = new Date(NOW - 30_000).toISOString();
    expect(jobDuration(job({ status: { startTime: start } }), NOW)).toBe("30s");
  });
});

describe("jobCompletionsLabel", () => {
  test("succeeded over spec.completions", () => {
    expect(jobCompletionsLabel(job({ spec: { completions: 3 }, status: { succeeded: 3 } }))).toBe(
      "3/3",
    );
  });
  test("defaults: succeeded 0, completions 1", () => {
    expect(jobCompletionsLabel(job())).toBe("0/1");
  });
});

describe("lastScheduleAgo", () => {
  test("null when never scheduled", () => {
    expect(lastScheduleAgo(cron(), NOW)).toBeNull();
  });
  test("seconds", () => {
    const t = new Date(NOW - 42_000).toISOString();
    expect(lastScheduleAgo(cron({ status: { lastScheduleTime: t } }), NOW)).toBe("42s ago");
  });
  test("minutes", () => {
    const t = new Date(NOW - 3 * 60_000).toISOString();
    expect(lastScheduleAgo(cron({ status: { lastScheduleTime: t } }), NOW)).toBe("3m ago");
  });
  test("hours", () => {
    const t = new Date(NOW - 4 * 3_600_000).toISOString();
    expect(lastScheduleAgo(cron({ status: { lastScheduleTime: t } }), NOW)).toBe("4h ago");
  });
  test("days", () => {
    const t = new Date(NOW - 3 * 86_400_000).toISOString();
    expect(lastScheduleAgo(cron({ status: { lastScheduleTime: t } }), NOW)).toBe("3d ago");
  });
});

describe("cronJobActiveCount", () => {
  test("0 when none active", () => {
    expect(cronJobActiveCount(cron())).toBe(0);
  });
  test("counts active job references", () => {
    expect(cronJobActiveCount(cron({ status: { active: [{}, {}] } }))).toBe(2);
  });
});

describe("isCronJobSuspended", () => {
  test("true when spec.suspend === true", () => {
    expect(isCronJobSuspended(cron({ spec: { suspend: true } }))).toBe(true);
  });
  test("false when suspend false or missing", () => {
    expect(isCronJobSuspended(cron({ spec: { suspend: false } }))).toBe(false);
    expect(isCronJobSuspended(cron())).toBe(false);
  });
});

describe("generateTriggerJobName", () => {
  test("deterministic with a fixed timestamp (spec example)", () => {
    // 1686789123 % 100000 = 89123
    expect(generateTriggerJobName("backup-db", NOW)).toBe("backup-db-manual-89123");
  });
  test("truncates base names longer than 40 chars", () => {
    const longName = "a".repeat(60);
    const result = generateTriggerJobName(longName, NOW);
    expect(result).toBe(`${"a".repeat(40)}-manual-89123`);
  });
});

describe("matchesSearch", () => {
  test("empty search matches everything", () => {
    expect(matchesSearch("web", "default", [], "")).toBe(true);
    expect(matchesSearch("web", "default", [], "   ")).toBe(true);
  });
  test("case-insensitive name match", () => {
    expect(matchesSearch("MyJob", "default", [], "myjob")).toBe(true);
  });
  test("matches namespace", () => {
    expect(matchesSearch("web", "kube-system", [], "system")).toBe(true);
  });
  test("matches extra fields (e.g. schedule / phase)", () => {
    expect(matchesSearch("c", "default", ["0 2 * * *"], "2 *")).toBe(true);
    expect(matchesSearch("j", "default", ["Running"], "running")).toBe(true);
  });
  test("no match returns false", () => {
    expect(matchesSearch("web", "default", ["0 2 * * *"], "zzz")).toBe(false);
  });
});

describe("readyFraction / readyColorClass", () => {
  test("X/Y format", () => {
    expect(readyFraction(2, 3)).toBe("2/3");
  });
  test("green when ready === desired, red otherwise", () => {
    expect(readyColorClass(3, 3)).toContain("green");
    expect(readyColorClass(2, 3)).toContain("red");
  });
});

describe("ready accessors", () => {
  test("statefulset ready/desired with fallbacks", () => {
    expect(statefulSetReady({ metadata: { name: "s" }, status: { readyReplicas: 2 } })).toBe(2);
    expect(statefulSetDesired({ metadata: { name: "s" }, spec: { replicas: 3 } })).toBe(3);
    expect(statefulSetDesired({ metadata: { name: "s" }, status: { replicas: 4 } })).toBe(4);
    expect(statefulSetDesired({ metadata: { name: "s" } })).toBe(0);
  });
  test("daemonset ready/desired", () => {
    expect(
      daemonSetReady({ metadata: { name: "d" }, status: { numberReady: 5 } }),
    ).toBe(5);
    expect(
      daemonSetDesired({ metadata: { name: "d" }, status: { desiredNumberScheduled: 6 } }),
    ).toBe(6);
  });
});

describe("compareWorkloads / sortWorkloads", () => {
  test("namespace ascending then name ascending", () => {
    const a = { metadata: { name: "b", namespace: "ns1" } };
    const b = { metadata: { name: "a", namespace: "ns2" } };
    const c = { metadata: { name: "a", namespace: "ns1" } };
    const sorted = sortWorkloads([a, b, c]);
    expect(sorted.map((w) => `${w.metadata.namespace}/${w.metadata.name}`)).toEqual([
      "ns1/a",
      "ns1/b",
      "ns2/a",
    ]);
  });
  test("compareWorkloads handles missing namespace", () => {
    const a = { metadata: { name: "x" } };
    const b = { metadata: { name: "y", namespace: "z" } };
    expect(compareWorkloads(a, b)).toBeLessThan(0);
  });
});

describe("formatSelector", () => {
  test("joins sorted matchLabels", () => {
    expect(formatSelector({ tier: "web", app: "x" })).toBe("app=x,tier=web");
  });
  test("returns a dash when empty or undefined", () => {
    expect(formatSelector({})).toBe("—");
    expect(formatSelector(undefined)).toBe("—");
  });
});

describe("workloadUpdateStrategy", () => {
  test("reads spec.updateStrategy.type, defaulting to RollingUpdate", () => {
    expect(workloadUpdateStrategy({ metadata: { name: "s" }, spec: { updateStrategy: { type: "OnDelete" } } } as StatefulSet)).toBe("OnDelete");
    expect(workloadUpdateStrategy({ metadata: { name: "s" } } as StatefulSet)).toBe("RollingUpdate");
  });
});

describe("workloadContainers", () => {
  test("reads spec.template for sts/ds/job", () => {
    const j = job({ spec: { template: { spec: { containers: [{ name: "c", image: "busybox" }] } } } });
    expect(workloadContainers(j, "jobs")).toEqual([{ name: "c", image: "busybox" }]);
  });
  test("reads spec.jobTemplate.spec.template for cronjobs", () => {
    const c = cron({ spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "cj", image: "alpine" }] } } } } } });
    expect(workloadContainers(c, "cronjobs")).toEqual([{ name: "cj", image: "alpine" }]);
  });
  test("returns an empty array when there is no template", () => {
    expect(workloadContainers(job(), "jobs")).toEqual([]);
  });
});

describe("volumeClaimTemplateSummaries", () => {
  test("summarizes name / storage / storageClass", () => {
    const sts = { metadata: { name: "db" }, spec: { volumeClaimTemplates: [
      { metadata: { name: "data" }, spec: { storageClassName: "fast", resources: { requests: { storage: "10Gi" } } } },
    ] } } as StatefulSet;
    expect(volumeClaimTemplateSummaries(sts)).toEqual([{ name: "data", storage: "10Gi", storageClass: "fast" }]);
  });
  test("returns an empty array when absent", () => {
    expect(volumeClaimTemplateSummaries({ metadata: { name: "db" } } as StatefulSet)).toEqual([]);
  });
});

describe("jobConditionSummaries", () => {
  test("maps conditions with reason/message", () => {
    const j = job({ status: { conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "too many retries" }] } });
    expect(jobConditionSummaries(j)).toEqual([{ type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "too many retries" }]);
  });
  test("returns an empty array when there are no conditions", () => {
    expect(jobConditionSummaries(job())).toEqual([]);
  });
});

describe("cronJobActiveNames", () => {
  test("extracts names of active job refs", () => {
    const c = cron({ status: { active: [{ name: "run-1" }, { name: "run-2" }, {}] } });
    expect(cronJobActiveNames(c)).toEqual(["run-1", "run-2"]);
  });
});

describe("workloadSpecFields", () => {
  test("statefulset fields", () => {
    const sts = { metadata: { name: "db", namespace: "prod", creationTimestamp: undefined }, spec: { replicas: 3, serviceName: "db-svc", selector: { matchLabels: { app: "db" } } }, status: { readyReplicas: 2 } } as StatefulSet;
    const f = workloadSpecFields(sts, "statefulsets", NOW);
    expect(f.find((x) => x.label === "Replicas")?.value).toBe("3");
    expect(f.find((x) => x.label === "Ready")?.value).toBe("2/3");
    expect(f.find((x) => x.label === "Service")?.value).toBe("db-svc");
    expect(f.find((x) => x.label === "Selector")?.value).toBe("app=db");
  });
  test("daemonset fields", () => {
    const ds = { metadata: { name: "cni", namespace: "kube-system" }, status: { numberReady: 4, desiredNumberScheduled: 5, numberAvailable: 4, updatedNumberScheduled: 5 } } as DaemonSet;
    const f = workloadSpecFields(ds, "daemonsets", NOW);
    expect(f.find((x) => x.label === "Desired")?.value).toBe("5");
    expect(f.find((x) => x.label === "Available")?.value).toBe("4");
  });
  test("job fields include status, completions and duration", () => {
    const j = job({ status: { succeeded: 1, startTime: new Date(NOW - 60_000).toISOString(), completionTime: new Date(NOW).toISOString(), conditions: [{ type: "Complete", status: "True" }] }, spec: { completions: 1 } });
    const f = workloadSpecFields(j, "jobs", NOW);
    expect(f.find((x) => x.label === "Status")?.value).toBe("Complete");
    expect(f.find((x) => x.label === "Completions")?.value).toBe("1/1");
    expect(f.find((x) => x.label === "Duration")?.value).toBe("1m");
  });
  test("cronjob fields include schedule and concurrency", () => {
    const c = cron({ spec: { schedule: "*/5 * * * *", concurrencyPolicy: "Forbid" } });
    const f = workloadSpecFields(c, "cronjobs", NOW);
    expect(f.find((x) => x.label === "Schedule")?.value).toBe("*/5 * * * *");
    expect(f.find((x) => x.label === "Concurrency")?.value).toBe("Forbid");
    expect(f.find((x) => x.label === "Last schedule")?.value).toBe("Never");
  });
});
