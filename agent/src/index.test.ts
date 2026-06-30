import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Config } from "./config.js";
import type { AssistantState } from "./state.js";
import type { KubectlResult } from "./kubectl.js";

// Mock the IO boundaries so a single tick() can be driven end-to-end:
//  - kubectl: the only cluster IO (state read/write, detection, repo resolve).
//  - runWorker: the model call — proposes an `openFixPR` (or a kubectl action).
//  - runSupervisor: the fix-quality reviewer for an actionable openFixPR; defaults
//    to "approve" so the dispatch path is reached, overridden per-test for
//    reject/escalate. It must NEVER reach the kubectl executor for an openFixPR.
vi.mock("./kubectl.js", () => {
  const kubectl = vi.fn();
  return {
    kubectl,
    kubectlApply: (manifest: string) => kubectl(["apply", "-f", "-"], manifest),
    getManifestYaml: vi.fn(async () => null),
  };
});
vi.mock("./worker.js", () => ({ runWorker: vi.fn() }));
vi.mock("./supervisor.js", () => ({ runSupervisor: vi.fn() }));

import { kubectl } from "./kubectl.js";
import { runWorker } from "./worker.js";
import { runSupervisor } from "./supervisor.js";
import { tick, createLoopState } from "./index.js";
import { CircuitBreaker } from "./guardrails.js";

const res = (stdout: string, code = 0): KubectlResult => ({ stdout, stderr: code === 0 ? "" : "err", code });

// A crashing pod owned by ReplicaSet "memos-7d9f" → owning Deployment "memos"
// (the pod→ReplicaSet→Deployment walk), so autofix eligibility resolves the
// Deployment, not the pod name.
const CRASH_POD = {
  metadata: { name: "memos-7d9f-abc", namespace: "default", ownerReferences: [{ kind: "ReplicaSet", name: "memos-7d9f" }] },
  status: { phase: "Running", containerStatuses: [{ restartCount: 5, state: { waiting: { reason: "CrashLoopBackOff" } } }] },
};
const CRASH_FP = "unhealthyPod|default|memos-7d9f-abc|CrashLoopBackOff";

const OPEN_FIX_PR = {
  label: "Open fix PR",
  kind: "openFixPR",
  source: "memos",
  filePath: "apps/memos/deployment.yaml",
  content: "kind: Deployment\n...",
  title: "Bump memos image to a healthy tag",
  body: "The pinned tag CrashLoops.",
};

// A kubectl remediation (restart) for the same crashing workload — used to prove
// the kubectl executor path runs verdict-INDEPENDENTLY for a status incident.
const RESTART = { label: "Restart memos", kind: "restart", deployment: "memos", namespace: "default" };

// A healthy, RUNNING pod the status checks won't flag, owned by ReplicaSet
// "logger-7d9f" → Deployment "logger" (project id "default/logger"). With autofix
// on + that project in scope its logs are tailed, so a panic surfaces as a
// `loggedError` incident.
const LOG_POD = {
  metadata: { name: "logger-7d9f-abc", namespace: "default", ownerReferences: [{ kind: "ReplicaSet", name: "logger-7d9f" }] },
  status: { phase: "Running", containerStatuses: [{ restartCount: 0 }] },
};
const LOG_TEXT = "panic: runtime error: nil pointer dereference";
// autofix on + project "default/logger" in scope → LOG_POD's logs are scanned.
const LOG_SCAN_CONFIG = {
  enabled: "true", confirmPolls: "1", autofixEnabled: "true",
  autofixScope: JSON.stringify({ projects: ["default/logger"] }),
};

/** A supervisor output (fix-quality verdict), defaulting to approve. */
function sup(decision: "approve" | "reject" | "escalate", reason = "ok", confidence = 0.9) {
  return { verdict: { decision, confidence, reason }, costUsd: 0 } as never;
}

const GIT_SOURCES = [
  { name: "infra", repoURL: "https://github.com/me/infra", branch: "main", deployments: [{ name: "memos", path: "apps/memos" }] },
];

// The owning Deployment "memos", provenance-stamped so resolveWorkloadRepo matches.
const DEPLOYMENT_JSON = JSON.stringify({
  kind: "Deployment",
  metadata: { name: "memos", annotations: { "rigel.dev/source-repo": "memos", "rigel.dev/source-path": "apps/memos" } },
});

function makeConfig(): Config {
  return {
    workerModel: "claude-sonnet-4-6",
    supervisorModel: "claude-opus-4-8",
    pollIntervalMs: 30_000,
    maxPerResourcePerHour: 3,
    maxPerNight: 20,
    maxAttemptsPerIncident: 3,
    windowMs: 24 * 3_600_000,
    namespaces: [],
    confirmPolls: 1,
    maxConcurrentDiagnoses: 3,
    stateConfigMap: "assistant-state",
    configConfigMap: "assistant-config",
    backupsConfigMap: "assistant-backups",
    stateNamespace: "default",
    auditMaxEntries: 200,
    maxBackups: 50,
    queueTtlMs: 48 * 3_600_000,
    fixRunnerImage: "ghcr.io/me/rigel-assistant:abc123",
  };
}

/** Capture an applied state-ConfigMap, ignoring the fix-PR ConfigMap/Job applies
 *  (those carry no `state.json`). Returns the decoded state or undefined. */
function captureState(stdin: string | undefined): AssistantState | undefined {
  const parsed = JSON.parse(stdin ?? "{}") as { data?: Record<string, string> };
  const raw = parsed.data?.["state.json"];
  return raw ? (JSON.parse(raw) as AssistantState) : undefined;
}

/** Wire the kubectl mock to a fixed cluster snapshot, capturing the written state.
 *  `pods` defaults to the single crashing pod; `logText` (when set) is returned for
 *  `kubectl logs` so the log-error scan can surface a `loggedError` incident. */
function wireCluster(opts: {
  configData: Record<string, string>;
  deploymentJSON?: string;
  pods?: Record<string, unknown>[];
  logText?: string;
  /** Seed the persisted `assistant-state` (e.g. prior `pullRequests`); empty when unset. */
  stateSeed?: Record<string, unknown>;
  /** Items returned for `get jobs -l rigel.dev/fix=true` (the in-flight fix Jobs); [] when unset. */
  fixJobs?: unknown[];
  /** Force the `get jobs` list to FAIL: a non-zero exit, or a spawn-style throw. */
  failJobsList?: "nonzero" | "throw";
}): { captured: () => AssistantState | undefined } {
  const pods = opts.pods ?? [CRASH_POD];
  let captured: AssistantState | undefined;
  vi.mocked(kubectl).mockImplementation(async (args: string[], stdin?: string) => {
    const cm = args[0] === "get" && args[1] === "configmap" ? args[2] : null;
    if (cm === "assistant-state") {
      return opts.stateSeed
        ? res(JSON.stringify({ data: { "state.json": JSON.stringify(opts.stateSeed) } }))
        : res("{}"); // empty → fresh state
    }
    if (cm === "assistant-config") return res(JSON.stringify({ data: opts.configData }));
    if (cm === "rigel-git-sources") return res(JSON.stringify({ data: { "sources.json": JSON.stringify(GIT_SOURCES) } }));
    if (args[0] === "get" && args[1] === "pods") return res(JSON.stringify({ items: pods }));
    if (args[0] === "get" && args[1] === "deployments") return res(JSON.stringify({ items: [] }));
    if (args[0] === "get" && args[1] === "jobs") {
      if (opts.failJobsList === "throw") throw new Error("spawn kubectl ENOENT");
      if (opts.failJobsList === "nonzero") return res("", 1); // RBAC denial / 429 / timeout
      return res(JSON.stringify({ items: opts.fixJobs ?? [] }));
    }
    if (args[0] === "get" && args[1] === "deployment") return opts.deploymentJSON ? res(opts.deploymentJSON) : res("", 1);
    if (args[0] === "logs") return opts.logText !== undefined ? res(opts.logText) : res("", 1);
    if (args[0] === "rollout") return res("deployment.apps/memos restarted");
    if (args[0] === "apply") {
      captured = captureState(stdin) ?? captured;
      return res("");
    }
    return res("", 1);
  });
  return { captured: () => captured };
}

/** A recorded, opened PR for the budget tests. `at` defaults to now (in-window). */
function openPr(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    at: new Date().toISOString(), fingerprint: "old", filePath: "a.yaml", incident: "i",
    app: "memos", repo: "https://github.com/me/infra", title: "t", summary: "",
    status: "open", kind: "config", ...over,
  };
}

/** An autofix-on, in-scope config with a per-day fix-PR cap. */
function budgetConfig(maxPerDay: string): Record<string, string> {
  return {
    enabled: "true", confirmPolls: "1", autofixEnabled: "true",
    autofixScope: JSON.stringify({ projects: ["default/memos"] }),
    autofixMaxPerDay: maxPerDay,
  };
}

/** Whether any applied manifest was a `rigel-fix-*` resource (a dispatched fix). */
function dispatchedAFix(): boolean {
  return vi.mocked(kubectl).mock.calls
    .filter((c) => c[0]?.[0] === "apply")
    .map((c) => JSON.parse(c[1] as string) as { metadata?: { name?: string } })
    .some((m) => (m.metadata?.name ?? "").startsWith("rigel-fix-"));
}

function newCb(): CircuitBreaker {
  return new CircuitBreaker({ maxPerResourcePerHour: 3, maxPerNight: 20, maxAttemptsPerIncident: 3, windowMs: 24 * 3_600_000 });
}

/** A worker output with the triage contract, defaulting to actionable+openFixPR. */
function workerOut(over: Partial<{ actions: unknown[]; analysis: string; verdict: string; verdictReason: string; failed: boolean }> = {}) {
  return {
    actions: [OPEN_FIX_PR], analysis: "the image tag is wrong", costUsd: 0,
    verdict: "actionable", verdictReason: "bad image tag", failed: false,
    ...over,
  } as never;
}

beforeEach(() => {
  vi.mocked(runWorker).mockResolvedValue(workerOut());
  // An actionable, dispatchable openFixPR now clears the fix-quality supervisor
  // before dispatch — default it to approve; reject/escalate tests override.
  vi.mocked(runSupervisor).mockResolvedValue(sup("approve"));
});
afterEach(() => vi.clearAllMocks());

describe("tick() — openFixPR routing (I1 landmine)", () => {
  test("a stray openFixPR (autofix disabled) is recorded and never throws out of tick()", async () => {
    const { captured } = wireCluster({ configData: { enabled: "true", confirmPolls: "1" } });

    await expect(tick(makeConfig(), newCb(), createLoopState())).resolves.toBeUndefined();

    const state = captured();
    expect(state).toBeDefined();
    expect(state!.audit[0]).toMatchObject({ proposal: "Open fix PR", outcome: "skipped" });
    expect(state!.audit[0]?.detail).toMatch(/autofix is disabled or this workload is outside/);
    // Out of scope ⇒ undispatchable ⇒ no fix-quality review is spent, and it never
    // reached the kubectl preview/executor path.
    expect(state!.queue).toHaveLength(0);
    expect(vi.mocked(runSupervisor)).not.toHaveBeenCalled();
  });

  test("an in-scope, GitOps-tracked openFixPR is queued pending the fix-runner (no throw)", async () => {
    const { captured } = wireCluster({
      configData: {
        enabled: "true",
        confirmPolls: "1",
        autofixEnabled: "true",
        autofixScope: JSON.stringify({ projects: ["default/memos"] }),
      },
      deploymentJSON: DEPLOYMENT_JSON,
    });

    await expect(tick(makeConfig(), newCb(), createLoopState())).resolves.toBeUndefined();

    const state = captured();
    expect(state).toBeDefined();
    // The fix-quality supervisor cleared the change before it was dispatched.
    expect(vi.mocked(runSupervisor)).toHaveBeenCalledTimes(1);
    expect(state!.audit[0]).toMatchObject({ proposal: OPEN_FIX_PR.title, outcome: "queued", tier: "medium" });
    expect(state!.audit[0]?.detail).toContain("fix-runner");
    expect(state!.queue[0]).toMatchObject({ suggestion: OPEN_FIX_PR.title, action: { kind: "openFixPR" } });
  });

  test("an in-scope openFixPR for a pod incident resolves via the pod→Deployment walk (2b)", async () => {
    // The proposal carries NO deployment field; eligibility must walk the pod to
    // Deployment "memos" (not treat the pod name as the Deployment) to find the source.
    const { captured } = wireCluster({
      configData: {
        enabled: "true", confirmPolls: "1", autofixEnabled: "true",
        autofixScope: JSON.stringify({ projects: ["default/memos"] }),
      },
      deploymentJSON: DEPLOYMENT_JSON,
    });

    await tick(makeConfig(), newCb(), createLoopState());

    const state = captured();
    expect(state!.audit[0]).toMatchObject({ outcome: "queued", tier: "medium" });
    expect(state!.audit[0]?.detail).toContain("github.com/me/infra@main");
  });
});

describe("tick() — triage verdict handling", () => {
  // The verdict's silence/queue SUPPRESSION applies ONLY to loggedError incidents.
  test("loggedError acceptable → recorded skipped and the fingerprint is auto-silenced (no action)", async () => {
    vi.mocked(runWorker).mockResolvedValue(workerOut({ actions: [], verdict: "acceptable", verdictReason: "handled error, benign" }));
    const { captured } = wireCluster({ configData: LOG_SCAN_CONFIG, pods: [LOG_POD], logText: LOG_TEXT });

    await tick(makeConfig(), newCb(), createLoopState());

    const state = captured();
    expect(state!.audit[0]).toMatchObject({ incident: expect.stringContaining("logger-7d9f-abc"), outcome: "skipped" });
    expect(state!.audit[0]?.detail).toMatch(/acceptable — auto-silenced/);
    expect(state!.autoSilenced).toHaveLength(1);
    expect(state!.autoSilenced![0]).toMatch(/^loggedError\|default\|logger-7d9f-abc\|/);
    expect(state!.queue).toHaveLength(0);
  });

  test("loggedError uncertain → queues a low-noise note, no action, no openFixPR dispatch", async () => {
    vi.mocked(runWorker).mockResolvedValue(workerOut({ actions: [OPEN_FIX_PR], verdict: "uncertain", verdictReason: "cannot tell if real" }));
    const { captured } = wireCluster({ configData: LOG_SCAN_CONFIG, pods: [LOG_POD], logText: LOG_TEXT });

    await tick(makeConfig(), newCb(), createLoopState());

    const state = captured();
    expect(state!.audit[0]).toMatchObject({ outcome: "queued", tier: "low" });
    expect(state!.audit[0]?.detail).toMatch(/uncertain/);
    expect(state!.queue[0]).toMatchObject({ suggestion: "cannot tell if real" });
    // It must NOT have been routed to the fix-runner queue (no openFixPR action carried).
    expect(state!.queue[0]?.action).toBeUndefined();
    expect(vi.mocked(runSupervisor)).not.toHaveBeenCalled();
  });

  // A STATUS incident is NEVER silenced/queued by the verdict: its kubectl action
  // executes regardless (pre-triage behavior restored).
  test.each(["acceptable", "uncertain", undefined])(
    "a status incident with a kubectl action executes regardless of verdict=%s (pre-triage restored)",
    async (verdict) => {
      vi.mocked(runWorker).mockResolvedValue(workerOut({ actions: [RESTART], verdict, verdictReason: "x" }));
      const { captured } = wireCluster({ configData: { enabled: "true", confirmPolls: "1" } });

      await tick(makeConfig(), newCb(), createLoopState());

      const calls = vi.mocked(kubectl).mock.calls.map((c) => c[0]);
      expect(calls).toContainEqual(["rollout", "restart", "deployment/memos", "-n", "default"]);
      const state = captured();
      // Not silenced (acceptable) and not queued (uncertain) by the verdict.
      expect(state!.autoSilenced ?? []).toHaveLength(0);
      expect(state!.queue).toHaveLength(0);
      expect(state!.audit[0]).toMatchObject({ proposal: "Restart memos", outcome: "success" });
    },
  );

  test("a previously auto-silenced incident is dropped before detection confirms (doesn't re-fire)", async () => {
    vi.mocked(runWorker).mockResolvedValue(workerOut({ actions: [], verdict: "actionable" }));
    let captured: AssistantState | undefined;
    vi.mocked(kubectl).mockImplementation(async (args: string[], stdin?: string) => {
      const cm = args[0] === "get" && args[1] === "configmap" ? args[2] : null;
      // assistant-state already carries the auto-silenced fingerprint from a prior tick.
      if (cm === "assistant-state") return res(JSON.stringify({ data: { "state.json": JSON.stringify({ updatedAt: "", audit: [], queue: [], report: "", autoSilenced: [CRASH_FP] }) } }));
      if (cm === "assistant-config") return res(JSON.stringify({ data: { enabled: "true", confirmPolls: "1" } }));
      if (args[0] === "get" && args[1] === "pods") return res(JSON.stringify({ items: [CRASH_POD] }));
      if (args[0] === "get" && args[1] === "deployments") return res(JSON.stringify({ items: [] }));
      if (args[0] === "apply") {
        captured = captureState(stdin) ?? captured;
        return res("");
      }
      return res("", 1);
    });

    await tick(makeConfig(), newCb(), createLoopState());

    // The silenced incident never reached the worker → no new audit entry for it.
    expect(vi.mocked(runWorker)).not.toHaveBeenCalled();
    expect(captured!.audit).toHaveLength(0);
  });
});

describe("tick() — openFixPR fix-quality supervisor", () => {
  // An in-scope, GitOps-tracked, actionable openFixPR (CRASH_POD → Deployment memos).
  const tracked = () =>
    wireCluster({
      configData: {
        enabled: "true", confirmPolls: "1", autofixEnabled: "true",
        autofixScope: JSON.stringify({ projects: ["default/memos"] }),
      },
      deploymentJSON: DEPLOYMENT_JSON,
    });

  test("approve → dispatched (queued pending the fix-runner)", async () => {
    vi.mocked(runSupervisor).mockResolvedValue(sup("approve", "minimal and correct"));
    const { captured } = tracked();

    await tick(makeConfig(), newCb(), createLoopState());

    const state = captured();
    expect(vi.mocked(runSupervisor)).toHaveBeenCalledTimes(1);
    // The supervisor judged FIX QUALITY (empty command, not a kubectl preview).
    expect(vi.mocked(runSupervisor).mock.calls[0]![4]).toBe("");
    expect(state!.audit[0]).toMatchObject({ outcome: "queued", tier: "medium" });
    expect(state!.queue[0]).toMatchObject({ action: { kind: "openFixPR" } });
    // The dispatch actually created the per-fix ConfigMap + one-shot Job.
    const applied = vi.mocked(kubectl).mock.calls
      .filter((c) => c[0]?.[0] === "apply")
      .map((c) => JSON.parse(c[1] as string) as { kind: string; metadata: { name: string } });
    expect(applied.some((m) => m.kind === "ConfigMap" && m.metadata.name.startsWith("rigel-fix-"))).toBe(true);
    expect(applied.some((m) => m.kind === "Job" && m.metadata.name.startsWith("rigel-fix-"))).toBe(true);
  });

  test("reject → recorded skipped, NOT dispatched (no fix-runner queue entry)", async () => {
    vi.mocked(runSupervisor).mockResolvedValue(sup("reject", "wrong file"));
    const { captured } = tracked();

    await tick(makeConfig(), newCb(), createLoopState());

    const state = captured();
    expect(state!.audit[0]).toMatchObject({ outcome: "skipped", verdict: "rejected", tier: "medium" });
    expect(state!.audit[0]?.detail).toMatch(/Opus rejected the fix/);
    expect(state!.queue).toHaveLength(0);
  });

  test("escalate → queued for a human (no dispatch)", async () => {
    vi.mocked(runSupervisor).mockResolvedValue(sup("escalate", "not confident"));
    const { captured } = tracked();

    await tick(makeConfig(), newCb(), createLoopState());

    const state = captured();
    expect(state!.audit[0]).toMatchObject({ outcome: "queued", verdict: "escalated", tier: "medium" });
    expect(state!.audit[0]?.detail).toMatch(/Opus escalated the fix/);
    expect(state!.queue[0]).toMatchObject({ action: { kind: "openFixPR" } });
    expect(state!.queue[0]?.reason).toMatch(/Opus escalated/);
  });

  test("supervisor THROW → fail-closed, queued for a human (never opens a PR)", async () => {
    vi.mocked(runSupervisor).mockRejectedValue(new Error("supervisor unreachable"));
    const { captured } = tracked();

    await expect(tick(makeConfig(), newCb(), createLoopState())).resolves.toBeUndefined();

    const state = captured();
    expect(state!.audit[0]).toMatchObject({ outcome: "queued", verdict: "escalated", tier: "medium" });
    expect(state!.audit[0]?.detail).toMatch(/fail-closed/);
  });

  test("a non-actionable verdict for an in-scope openFixPR → no PR, no supervisor call", async () => {
    vi.mocked(runWorker).mockResolvedValue(workerOut({ actions: [OPEN_FIX_PR], verdict: "acceptable", verdictReason: "benign" }));
    const { captured } = tracked();

    await tick(makeConfig(), newCb(), createLoopState());

    const state = captured();
    // CRASH_POD is a STATUS incident, so an acceptable verdict does NOT silence it;
    // the openFixPR is simply skipped for being non-actionable.
    expect(vi.mocked(runSupervisor)).not.toHaveBeenCalled();
    expect(state!.audit[0]).toMatchObject({ proposal: OPEN_FIX_PR.label, outcome: "skipped", tier: "medium" });
    expect(state!.audit[0]?.detail).toMatch(/not actionable/);
    expect(state!.queue).toHaveLength(0);
    expect(state!.autoSilenced ?? []).toHaveLength(0);
  });

  test("an approved openFixPR NEVER reaches the kubectl executor (no mutating kubectl)", async () => {
    vi.mocked(runSupervisor).mockResolvedValue(sup("approve"));
    tracked();

    await tick(makeConfig(), newCb(), createLoopState());

    // No mutating verbs ran — only reads (get) and the state write (apply). In
    // particular toKubectlInvocations(openFixPR) THROWS, so any leak to the executor
    // would have aborted the tick.
    const verbs = vi.mocked(kubectl).mock.calls.map((c) => c[0]?.[0]);
    for (const v of ["rollout", "scale", "set", "delete", "cordon", "uncordon"]) {
      expect(verbs).not.toContain(v);
    }
  });
});

describe("tick() — fix-Job reconcile (Phase 4 loop close)", () => {
  // A finished fix Job, stamped with the provenance annotations the reconcile reads.
  const FIX_JOB_NAME = "rigel-fix-memos-abc123";
  const fixJob = {
    metadata: {
      name: FIX_JOB_NAME,
      annotations: {
        "rigel.dev/fingerprint": CRASH_FP,
        "rigel.dev/file-path": "apps/memos/deployment.yaml",
        "rigel.dev/incident": "default/memos-7d9f-abc: CrashLoopBackOff",
        "rigel.dev/repo-url": "https://github.com/me/infra",
        "rigel.dev/branch": "main",
        "rigel.dev/source": "memos",
        "rigel.dev/title": "Bump memos image",
      },
    },
    status: { succeeded: 1 },
  };
  const TERM = JSON.stringify({ ok: true, prUrl: "https://github.com/me/infra/pull/7", branch: "rigel/fix-memos" });

  test("records the opened PR, then GCs the Job + ConfigMap AFTER the durable state write", async () => {
    let captured: AssistantState | undefined;
    // Track call order to prove GC runs AFTER the state write (apply) — losing an
    // opened PR by deleting before persisting would be the bug.
    const order: string[] = [];
    vi.mocked(kubectl).mockImplementation(async (args: string[], stdin?: string) => {
      const cm = args[0] === "get" && args[1] === "configmap" ? args[2] : null;
      if (cm === "assistant-state") return res("{}");
      if (cm === "assistant-config") return res(JSON.stringify({ data: { enabled: "true", confirmPolls: "1" } }));
      if (args[0] === "get" && args[1] === "pods") return res(JSON.stringify({ items: [] }));
      if (args[0] === "get" && args[1] === "deployments") return res(JSON.stringify({ items: [] }));
      if (args[0] === "get" && args[1] === "jobs") return res(JSON.stringify({ items: [fixJob] }));
      if (args[0] === "get" && args[1] === "pod") return res(TERM); // jsonpath term message
      if (args[0] === "apply") { order.push("apply"); captured = captureState(stdin) ?? captured; return res(""); }
      if (args[0] === "delete") { order.push(`delete ${args[1]}`); return res(""); }
      return res("", 1);
    });

    await expect(tick(makeConfig(), newCb(), createLoopState())).resolves.toBeUndefined();

    expect(captured!.pullRequests).toHaveLength(1);
    expect(captured!.pullRequests![0]).toMatchObject({
      status: "open", prUrl: "https://github.com/me/infra/pull/7", app: "memos", kind: "config",
    });
    // The Job + its same-named ConfigMap were both GC'd, and only AFTER the state write.
    expect(order).toEqual(["apply", "delete job", "delete configmap"]);
  });
});

describe("tick() — eligibility hardening", () => {
  test("a kubectl spawn-reject during eligibility resolution does NOT abort the tick", async () => {
    // CRASH_POD is in autofix scope, so eligibility calls resolveRepo → kubectl
    // `get deployment` — make THAT call REJECT (a spawn error, not a non-zero exit).
    // The tick must still complete and remediate the proposed kubectl action.
    vi.mocked(runWorker).mockResolvedValue(workerOut({ actions: [RESTART], verdict: "actionable" }));
    let captured: AssistantState | undefined;
    vi.mocked(kubectl).mockImplementation(async (args: string[], stdin?: string) => {
      const cm = args[0] === "get" && args[1] === "configmap" ? args[2] : null;
      if (cm === "assistant-state") return res("{}");
      if (cm === "assistant-config") {
        return res(JSON.stringify({ data: { enabled: "true", confirmPolls: "1", autofixEnabled: "true", autofixScope: JSON.stringify({ projects: ["default/memos"] }) } }));
      }
      if (args[0] === "get" && args[1] === "pods") return res(JSON.stringify({ items: [CRASH_POD] }));
      if (args[0] === "get" && args[1] === "deployments") return res(JSON.stringify({ items: [] }));
      if (args[0] === "get" && args[1] === "deployment") throw new Error("spawn kubectl ENOENT");
      if (args[0] === "rollout") return res("restarted");
      if (args[0] === "apply") {
        captured = captureState(stdin) ?? captured;
        return res("");
      }
      return res("", 1);
    });

    await expect(tick(makeConfig(), newCb(), createLoopState())).resolves.toBeUndefined();

    // The proposed kubectl remediation still ran (eligibility downgraded to not-eligible).
    const calls = vi.mocked(kubectl).mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual(["rollout", "restart", "deployment/memos", "-n", "default"]);
    expect(captured!.audit[0]).toMatchObject({ proposal: "Restart memos", outcome: "success" });
  });
});

describe("tick() — per-day fix-PR budget", () => {
  test("at the budget (recorded open PRs) → skipped before the supervisor, no Job created", async () => {
    // cap 2, with 2 recorded OPEN PRs inside the 24h window ⇒ budget exhausted.
    const seed = {
      updatedAt: "", audit: [], queue: [], report: "",
      pullRequests: [openPr({ fingerprint: "p1", filePath: "a.yaml" }), openPr({ fingerprint: "p2", filePath: "b.yaml" })],
    };
    const { captured } = wireCluster({ configData: budgetConfig("2"), deploymentJSON: DEPLOYMENT_JSON, stateSeed: seed });

    await tick(makeConfig(), newCb(), createLoopState());

    const state = captured();
    // Skipped BEFORE spending an Opus fix-quality review, and no fix Job was created.
    expect(vi.mocked(runSupervisor)).not.toHaveBeenCalled();
    expect(state!.audit[0]).toMatchObject({ proposal: OPEN_FIX_PR.label, outcome: "skipped", tier: "medium" });
    expect(state!.audit[0]?.detail).toMatch(/daily fix-PR budget reached \(2\/2\)/);
    expect(dispatchedAFix()).toBe(false);
  });

  test("under the budget → the fix is dispatched (Job created)", async () => {
    // cap 2, only 1 recorded open PR ⇒ a slot remains.
    const seed = { updatedAt: "", audit: [], queue: [], report: "", pullRequests: [openPr({ fingerprint: "p1" })] };
    const { captured } = wireCluster({ configData: budgetConfig("2"), deploymentJSON: DEPLOYMENT_JSON, stateSeed: seed });

    await tick(makeConfig(), newCb(), createLoopState());

    const state = captured();
    expect(vi.mocked(runSupervisor)).toHaveBeenCalledTimes(1);
    expect(state!.audit[0]).toMatchObject({ outcome: "queued", tier: "medium" });
    expect(dispatchedAFix()).toBe(true);
  });

  test("an IN-FLIGHT fix Job counts toward the budget (recorded 1 + in-flight 1 = cap 2 → skip)", async () => {
    const seed = { updatedAt: "", audit: [], queue: [], report: "", pullRequests: [openPr({ fingerprint: "p1" })] };
    // A still-RUNNING fix Job (no succeeded/failed/conditions) — counts as in-flight,
    // and the reconcile leaves it untouched (not complete) so it stays a pure count.
    const inflight = { metadata: { name: "rigel-fix-inflight", annotations: {} }, status: {} };
    const { captured } = wireCluster({
      configData: budgetConfig("2"), deploymentJSON: DEPLOYMENT_JSON, stateSeed: seed, fixJobs: [inflight],
    });

    await tick(makeConfig(), newCb(), createLoopState());

    const state = captured();
    expect(vi.mocked(runSupervisor)).not.toHaveBeenCalled();
    expect(state!.audit[0]?.detail).toMatch(/daily fix-PR budget reached \(2\/2\)/);
    expect(dispatchedAFix()).toBe(false);
  });

  test("a recorded PR aged past 24h frees its slot (dispatch proceeds)", async () => {
    // cap 1, with the only recorded PR opened 25h ago ⇒ out of window ⇒ 0 counts.
    const oldIso = new Date(Date.now() - 25 * 3_600_000).toISOString();
    const seed = { updatedAt: "", audit: [], queue: [], report: "", pullRequests: [openPr({ fingerprint: "p1", at: oldIso })] };
    const { captured } = wireCluster({ configData: budgetConfig("1"), deploymentJSON: DEPLOYMENT_JSON, stateSeed: seed });

    await tick(makeConfig(), newCb(), createLoopState());

    const state = captured();
    expect(vi.mocked(runSupervisor)).toHaveBeenCalledTimes(1);
    expect(state!.audit[0]).toMatchObject({ outcome: "queued", tier: "medium" });
    expect(dispatchedAFix()).toBe(true);
  });

  test("a fresh recorded PR at cap 1 → skip (proves the 24h-window edge is live, not always-free)", async () => {
    const seed = { updatedAt: "", audit: [], queue: [], report: "", pullRequests: [openPr({ fingerprint: "p1" })] };
    const { captured } = wireCluster({ configData: budgetConfig("1"), deploymentJSON: DEPLOYMENT_JSON, stateSeed: seed });

    await tick(makeConfig(), newCb(), createLoopState());

    expect(dispatchedAFix()).toBe(false);
    expect(captured()!.audit[0]?.detail).toMatch(/daily fix-PR budget reached \(1\/1\)/);
  });

  // I1 fail-closed: an UNREADABLE in-flight Job list must NOT read as 0 in-flight
  // (which would let up to ~2x-cap PRs open in one tick). Both failure modes — a
  // non-zero `get jobs` exit (RBAC / 429 / timeout) AND a spawn throw — must defer
  // ALL fix-PR dispatch this tick. cap is generous (5) and there are 0 recorded
  // PRs, so ONLY a fail-closed budget can explain the skip.
  test.each(["nonzero", "throw"] as const)(
    "an unreadable in-flight Job list (%s) defers ALL fix-PR dispatch (cap unbreachable)",
    async (mode) => {
      const { captured } = wireCluster({
        configData: budgetConfig("5"), deploymentJSON: DEPLOYMENT_JSON, failJobsList: mode,
      });

      await expect(tick(makeConfig(), newCb(), createLoopState())).resolves.toBeUndefined();

      const state = captured();
      // No fix Job/ConfigMap applied, and the Opus fix-quality review was never spent.
      expect(dispatchedAFix()).toBe(false);
      expect(vi.mocked(runSupervisor)).not.toHaveBeenCalled();
      expect(state!.audit[0]).toMatchObject({ proposal: OPEN_FIX_PR.label, outcome: "skipped", tier: "medium" });
      expect(state!.audit[0]?.detail).toMatch(/budget unverifiable .*unreadable/);
    },
  );
});

describe("tick() — auto-silence report visibility", () => {
  test("a benign auto-silenced issue is surfaced in state.report", async () => {
    vi.mocked(runWorker).mockResolvedValue(workerOut({ actions: [], verdict: "acceptable", verdictReason: "handled error, benign" }));
    const { captured } = wireCluster({ configData: LOG_SCAN_CONFIG, pods: [LOG_POD], logText: LOG_TEXT });

    await tick(makeConfig(), newCb(), createLoopState());

    const state = captured();
    expect(state!.autoSilenced).toHaveLength(1);
    expect(state!.report).toMatch(/Auto-silenced 1 benign issue\(s\): default\/logger-7d9f-abc/);
  });
});
