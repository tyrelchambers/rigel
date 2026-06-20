import { test, expect } from "vitest";
import {
  DEFAULT_INSTALL_CONFIG,
  SECRET_NAME,
  ISSUED_AT_ANNOTATION,
  namespaceYAML,
  secretYAML,
  manifestYAML,
  maskToken,
  tokenExpiryStatus,
  parseTokenExpiry,
  decodeClusterState,
  isEnabled,
  autonomyMode,
  quietWindow,
  silencedSet,
  podErrorReason,
  computeLiveIssues,
  mergedConfigMapJSON,
  clearedReportConfigMapJSON,
  type AssistantInstallConfig,
} from "./assistant";

function config(overrides: Partial<AssistantInstallConfig> = {}): AssistantInstallConfig {
  return {
    image: "ghcr.io/acme/rigel-assistant:latest",
    installNamespace: "default",
    namespaces: "",
    workerModel: "claude-sonnet-4-6",
    supervisorModel: "claude-opus-4-8",
    pollIntervalMs: 30000,
    maxPerResourcePerHour: 3,
    maxPerNight: 20,
    maxAttemptsPerIncident: 3,
    confirmPolls: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Manifest builders (parity with AssistantInstallerTests.swift)
// ---------------------------------------------------------------------------

test("manifest contains core objects", () => {
  const yaml = manifestYAML(config());
  expect(yaml).toContain("kind: ServiceAccount");
  expect(yaml).toContain("kind: ClusterRole");
  expect(yaml).toContain("kind: ClusterRoleBinding");
  expect(yaml).toContain("kind: Deployment");
  expect(yaml).toContain("kind: ConfigMap");
});

test("manifest substitutes image and knobs", () => {
  const yaml = manifestYAML(config());
  expect(yaml).toContain("ghcr.io/acme/rigel-assistant:latest");
  expect(yaml).toContain("claude-sonnet-4-6");
  expect(yaml).toContain("claude-opus-4-8");
});

test("kill switch starts enabled", () => {
  expect(manifestYAML(config())).toContain('enabled: "true"');
});

test("RBAC cage never grants secrets access", () => {
  expect(manifestYAML(config()).toLowerCase()).not.toContain("secrets");
});

test("install namespace applied to namespaced objects and subjects", () => {
  const yaml = manifestYAML(config({ installNamespace: "agents" }));
  expect(yaml).toContain("namespace: agents");
  expect(yaml).toContain("- kind: ServiceAccount\n    name: rigel-assistant\n    namespace: agents");
  expect(yaml).not.toContain("namespace: default");
});

test("agent Deployment writes its state to the install namespace, not default", () => {
  const yaml = manifestYAML(config({ installNamespace: "agents" }));
  // Without STATE_NAMESPACE the agent defaults to "default" and, when installed
  // elsewhere, can never write its state, leaving the panel stuck on setup.
  expect(yaml).toContain('- name: STATE_NAMESPACE\n              value: "agents"');
});

test("namespaceYAML builds a Namespace", () => {
  const y = namespaceYAML("agents");
  expect(y).toContain("kind: Namespace");
  expect(y).toContain("name: agents");
});

test("deployment specifies numeric non-root user", () => {
  const yaml = manifestYAML(config());
  expect(yaml).toContain("runAsNonRoot: true");
  expect(yaml).toContain("runAsUser: 1000");
});

test("secret carries the token but the manifest never does", () => {
  const secret = secretYAML("sk-test-123", "2026-01-01T00:00:00Z", "default");
  expect(secret).toContain("kind: Secret");
  expect(secret).toContain("sk-test-123");
  expect(secret).toContain(`${ISSUED_AT_ANNOTATION}: "2026-01-01T00:00:00Z"`);
  expect(manifestYAML(config())).not.toContain("sk-test-123");
});

test("secret escapes YAML-hostile characters in the token", () => {
  const secret = secretYAML('sk-"quoted"\\backslash', "", "default");
  expect(secret).toContain('token: "sk-\\"quoted\\"\\\\backslash"');
});

test("maskToken redacts the token line", () => {
  const masked = maskToken(secretYAML("sk-supersecret", "", "default"));
  expect(masked).not.toContain("sk-supersecret");
  expect(masked).toContain('token: "***SECRET***"');
});

test("default install config matches the catalog default image", () => {
  expect(DEFAULT_INSTALL_CONFIG.image).toBe("ghcr.io/tyrelchambers/rigel-assistant:latest");
  expect(SECRET_NAME).toBe("rigel-assistant-token");
});

// ---------------------------------------------------------------------------
// Token expiry (parity with TokenExpiryTests.swift)
// ---------------------------------------------------------------------------

test("token expiry: ok well before a year", () => {
  const issued = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-02-01T00:00:00Z");
  const s = tokenExpiryStatus(issued, now);
  expect(s.level).toBe("ok");
  expect(s.daysRemaining).toBeGreaterThan(30);
});

test("token expiry: warning within 30 days", () => {
  const issued = new Date("2026-01-01T00:00:00Z");
  const now = new Date(issued.getTime() + (365 - 10) * 86_400_000);
  const s = tokenExpiryStatus(issued, now);
  expect(s.level).toBe("warning");
  expect(s.daysRemaining).toBe(10);
});

test("token expiry: expired past a year", () => {
  const issued = new Date("2026-01-01T00:00:00Z");
  const now = new Date(issued.getTime() + 366 * 86_400_000);
  expect(tokenExpiryStatus(issued, now).level).toBe("expired");
});

test("parseTokenExpiry returns null for missing/bad annotation", () => {
  const now = new Date();
  expect(parseTokenExpiry(undefined, now)).toBeNull();
  expect(parseTokenExpiry("", now)).toBeNull();
  expect(parseTokenExpiry("not-a-date", now)).toBeNull();
});

// ---------------------------------------------------------------------------
// Cluster state decode
// ---------------------------------------------------------------------------

test("decodeClusterState defaults missing collections to empty", () => {
  const s = decodeClusterState("{}");
  expect(s).not.toBeNull();
  expect(s!.audit).toEqual([]);
  expect(s!.queue).toEqual([]);
  expect(s!.report).toBe("");
});

test("decodeClusterState parses audit/queue/report/status", () => {
  const raw = JSON.stringify({
    status: { heartbeatAt: "t", enabled: true, version: "1" },
    audit: [{ at: "t", fingerprint: "f", incident: "i", tier: "auto", outcome: "success", detail: "" }],
    queue: [{ at: "t", incident: "i", suggestion: "s", reason: "r" }],
    report: "all good",
  });
  const s = decodeClusterState(raw)!;
  expect(s.status!.enabled).toBe(true);
  expect(s.audit).toHaveLength(1);
  expect(s.queue).toHaveLength(1);
  expect(s.report).toBe("all good");
});

test("decodeClusterState returns null on bad input", () => {
  expect(decodeClusterState(null)).toBeNull();
  expect(decodeClusterState("not json")).toBeNull();
});

// ---------------------------------------------------------------------------
// Config surface parsing
// ---------------------------------------------------------------------------

test("isEnabled is true unless explicitly false", () => {
  expect(isEnabled({})).toBe(true);
  expect(isEnabled({ enabled: "true" })).toBe(true);
  expect(isEnabled({ enabled: "false" })).toBe(false);
});

test("autonomyMode defaults to auto", () => {
  expect(autonomyMode({})).toBe("auto");
  expect(autonomyMode({ mode: "advisory" })).toBe("advisory");
});

test("quietWindow reads the window key", () => {
  expect(quietWindow({})).toBe("");
  expect(quietWindow({ window: "22:00-07:00" })).toBe("22:00-07:00");
});

test("silencedSet splits on newlines and commas, trimming blanks", () => {
  const s = silencedSet({ silenced: "a\nb, c\n\n d " });
  expect([...s].sort()).toEqual(["a", "b", "c", "d"]);
});

// ---------------------------------------------------------------------------
// Live issues
// ---------------------------------------------------------------------------

test("podErrorReason flags Failed phase and known waiting reasons", () => {
  expect(podErrorReason({ status: { phase: "Failed" } })).toBe("Failed");
  expect(
    podErrorReason({
      status: { phase: "Pending", containerStatuses: [{ state: { waiting: { reason: "CrashLoopBackOff" } } }] },
    }),
  ).toBe("CrashLoopBackOff");
  expect(podErrorReason({ status: { phase: "Running" } })).toBeNull();
  expect(
    podErrorReason({ status: { containerStatuses: [{ state: { waiting: { reason: "ContainerCreating" } } }] } }),
  ).toBeNull();
});

test("computeLiveIssues emits agent-compatible fingerprints", () => {
  const issues = computeLiveIssues(
    [
      {
        metadata: { name: "web-1", namespace: "apps" },
        status: { phase: "Pending", containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } }] },
      },
      { metadata: { name: "ok", namespace: "apps" }, status: { phase: "Running" } },
    ],
    [
      { metadata: { name: "api", namespace: "apps" }, spec: { replicas: 3 }, status: { readyReplicas: 1 } },
      { metadata: { name: "healthy", namespace: "apps" }, spec: { replicas: 2 }, status: { readyReplicas: 2 } },
    ],
  );
  expect(issues).toHaveLength(2);
  expect(issues[0].fingerprint).toBe("unhealthyPod|apps|web-1|ImagePullBackOff");
  expect(issues[1].fingerprint).toBe("degradedDeployment|apps|api|Degraded");
  expect(issues[1].reason).toBe("Degraded 1/3");
});

// ---------------------------------------------------------------------------
// Read-modify-write helpers
// ---------------------------------------------------------------------------

test("mergedConfigMapJSON merges over existing data without clobbering", () => {
  const json = mergedConfigMapJSON("default", { enabled: "true", mode: "auto" }, { mode: "advisory" });
  const obj = JSON.parse(json);
  expect(obj.kind).toBe("ConfigMap");
  expect(obj.metadata.name).toBe("assistant-config");
  expect(obj.metadata.namespace).toBe("default");
  expect(obj.data).toEqual({ enabled: "true", mode: "advisory" });
});

test("clearedReportConfigMapJSON zeroes only the report field", () => {
  const state = JSON.stringify({ report: "stale warning", audit: [{ at: "t" }], status: { enabled: true } });
  const json = clearedReportConfigMapJSON("default", state)!;
  const obj = JSON.parse(json);
  const inner = JSON.parse(obj.data["state.json"]);
  expect(inner.report).toBe("");
  expect(inner.audit).toHaveLength(1);
  expect(inner.status.enabled).toBe(true);
});

test("clearedReportConfigMapJSON returns null when there is no state", () => {
  expect(clearedReportConfigMapJSON("default", undefined)).toBeNull();
  expect(clearedReportConfigMapJSON("default", "garbage")).toBeNull();
});
