import { test, it, expect } from "vitest";
import {
  DEFAULT_INSTALL_CONFIG,
  SECRET_NAME,
  isAssistantManaged,
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
  roleConfigUpdates,
  limitsConfigUpdates,
  type AssistantInstallConfig,
  type RoleSelectionInput,
  type LimitsInput,
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

test("maskToken redacts the token line but leaves the credential annotation intact", () => {
  const masked = maskToken(secretYAML("sk-supersecret", "", "default"));
  expect(masked).not.toContain("sk-supersecret");
  expect(masked).toContain('token: "***SECRET***"');
  // The correlation annotation's value must survive (it's metadata, not a secret).
  expect(masked).toContain('rigel.assistant/credential.claudeToken: "token"');
});

test("default install config matches the catalog default image", () => {
  expect(DEFAULT_INSTALL_CONFIG.image).toBe("ghcr.io/tyrelchambers/rigel-assistant:latest");
  expect(SECRET_NAME).toBe("rigel-assistant-token");
});

test("isAssistantManaged recognizes our managed-by label, rejects foreign/absent", () => {
  expect(isAssistantManaged({ "app.kubernetes.io/managed-by": "rigel-assistant" })).toBe(true);
  expect(isAssistantManaged({ "app.kubernetes.io/managed-by": "someone-else" })).toBe(false);
  expect(isAssistantManaged({})).toBe(false);
  expect(isAssistantManaged(undefined)).toBe(false);
});

test("our Deployment carries the managed-by label (so discovery can tell it apart)", () => {
  expect(deployment(config())).toContain("app.kubernetes.io/managed-by: rigel-assistant");
});

test("RBAC lets the agent orchestrate fix Jobs (create Jobs + per-fix ConfigMaps)", () => {
  const yaml = manifestYAML(config());
  expect(yaml).toContain("resources: [jobs]");
  // configmaps create/delete for the per-fix spec ConfigMaps (separate rule from
  // the resourceName-scoped get/update/patch on the three state ConfigMaps).
  expect(yaml).toMatch(/resources: \[configmaps\]\n\s+verbs: \[create, delete\]/);
});

test("RBAC adds the zero-access rigel-fix-runner ServiceAccount (no binding, no token)", () => {
  const yaml = manifestYAML(config({ installNamespace: "agents" }));
  expect(yaml).toContain("name: rigel-fix-runner\n  namespace: agents");
  expect(yaml).toContain("automountServiceAccountToken: false");
  // It must NOT be a subject of any binding — it needs zero cluster access.
  expect(yaml).not.toMatch(/name: rigel-fix-runner\n\s+namespace: agents\n[\s\S]*?roleRef/);
});

test("the fix-runner Job image tracks the agent image (same immutable tag)", () => {
  const yaml = deployment(config({ image: "ghcr.io/acme/rigel-assistant:sha-abc" }));
  expect(yaml).toContain('- name: RIGEL_FIX_RUNNER_IMAGE\n              value: "ghcr.io/acme/rigel-assistant:sha-abc"');
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
  expect(s!.pullRequests).toEqual([]);
});

test("decodeClusterState parses the agent's fix-PR history", () => {
  const raw = JSON.stringify({
    pullRequests: [
      {
        at: "t",
        fingerprint: "f",
        filePath: "k8s/deploy.yaml",
        incident: "OOMKilled",
        app: "default/api",
        repo: "https://github.com/tyrel/api",
        branch: "rigel/fix-oom-7f3",
        prUrl: "https://github.com/tyrel/api/pull/1",
        title: "Raise memory limit",
        summary: "opened",
        status: "open",
        kind: "config",
      },
    ],
  });
  const s = decodeClusterState(raw)!;
  expect(s.pullRequests).toHaveLength(1);
  expect(s.pullRequests[0]!.status).toBe("open");
  expect(s.pullRequests[0]!.prUrl).toContain("/pull/1");
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

import { describe } from "vitest";
import {
  CREDENTIALS_SECRET_NAME,
  credentialsSecretYAML,
  type AssistantCredentials,
} from "./assistant";

describe("credentialsSecretYAML", () => {
  test("emits only the keys whose value is non-empty", () => {
    const yaml = credentialsSecretYAML(
      { geminiApiKey: "g-123", codexApiKey: "" },
      "default",
    );
    expect(yaml).toContain(`name: ${CREDENTIALS_SECRET_NAME}`);
    expect(yaml).toContain("namespace: default");
    expect(yaml).toContain("kind: Secret");
    expect(yaml).toContain("type: Opaque");
    expect(yaml).toContain('geminiApiKey: "g-123"');
    expect(yaml).not.toContain("codexApiKey");
    expect(yaml).not.toContain("claudeToken");
  });

  test("escapes quotes/backslashes in a credential value", () => {
    const yaml = credentialsSecretYAML({ opencodeAuthContent: 'a"b\\c' }, "agents");
    expect(yaml).toContain('opencodeAuthContent: "a\\"b\\\\c"');
    expect(yaml).toContain("namespace: agents");
  });

  test("writes all possible keys when all are provided", () => {
    const yaml = credentialsSecretYAML(
      {
        claudeToken: "t",
        anthropicApiKey: "a",
        codexApiKey: "c",
        codexAuthContent: "cblob",
        geminiApiKey: "g",
        opencodeApiKey: "o",
        opencodeAuthContent: "blob",
      },
      "default",
    );
    for (const k of ["claudeToken", "anthropicApiKey", "codexApiKey", "codexAuthContent", "geminiApiKey", "opencodeApiKey", "opencodeAuthContent"]) {
      expect(yaml).toContain(`${k}: "`);
    }
  });

  test("an all-empty credentials map still produces a valid (empty-data) Secret", () => {
    const yaml = credentialsSecretYAML({}, "default");
    expect(yaml).toContain(`name: ${CREDENTIALS_SECRET_NAME}`);
    expect(yaml).toContain("stringData:");
  });
});

import { deployment, CREDENTIALS_SECRET_NAME as CREDS } from "./assistant";

describe("deployment provider credential env", () => {
  const yaml = deployment(config());

  test("legacy CLAUDE_CODE_OAUTH_TOKEN ref is kept but now optional", () => {
    expect(yaml).toContain("name: CLAUDE_CODE_OAUTH_TOKEN");
    expect(yaml).toContain(`name: ${SECRET_NAME}`);
    expect(yaml).toContain("key: token");
    // The legacy ref must be optional so a fresh install with no legacy Secret starts.
    expect(yaml).toMatch(/key: token\s+optional: true/);
  });

  test("injects ANTHROPIC_API_KEY / CODEX_API_KEY / GEMINI_API_KEY from the credentials Secret, optional", () => {
    for (const [env, key] of [
      ["ANTHROPIC_API_KEY", "anthropicApiKey"],
      ["CODEX_API_KEY", "codexApiKey"],
      ["GEMINI_API_KEY", "geminiApiKey"],
    ] as const) {
      expect(yaml).toContain(`name: ${env}`);
      expect(yaml).toContain(`key: ${key}`);
    }
    // Every credentials ref points at the credentials Secret and is optional.
    expect(yaml).toContain(`name: ${CREDS}`);
    expect(yaml.match(/optional: true/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
  });

  test("injects both Codex env vars from the credentials Secret", () => {
    expect(yaml).toContain("name: CODEX_API_KEY");
    expect(yaml).toContain("key: codexApiKey");
    expect(yaml).toContain("name: CODEX_AUTH_CONTENT");
    expect(yaml).toContain("key: codexAuthContent");
  });

  test("injects both OpenCode env vars from the credentials Secret", () => {
    expect(yaml).toContain("name: OPENCODE_API_KEY");
    expect(yaml).toContain("key: opencodeApiKey");
    expect(yaml).toContain("name: OPENCODE_AUTH_CONTENT");
    expect(yaml).toContain("key: opencodeAuthContent");
  });

  test("RBAC cage still never grants secrets access", () => {
    expect(manifestYAML(config()).toLowerCase()).not.toContain("resources: [secrets]");
  });
});

describe("roleConfigUpdates", () => {
  test("emits the exact runtimeConfig keys for both roles", () => {
    const updates = roleConfigUpdates(
      { provider: "gemini", model: "gemini-2.5-pro" },
      { provider: "claude", model: "claude-opus-4-8", effort: "high" },
    );
    expect(updates).toEqual({
      workerProvider: "gemini",
      workerModel: "gemini-2.5-pro",
      supervisorProvider: "claude",
      supervisorModel: "claude-opus-4-8",
      supervisorEffort: "high",
    });
  });

  test("omits effort keys when effort is absent (so a switch-away clears nothing it shouldn't)", () => {
    const updates = roleConfigUpdates(
      { provider: "claude", model: "claude-sonnet-4-6" },
      { provider: "claude", model: "claude-opus-4-8" },
    );
    expect(updates.workerEffort).toBeUndefined();
    expect(updates.supervisorEffort).toBeUndefined();
    expect(Object.keys(updates).sort()).toEqual([
      "supervisorModel", "supervisorProvider", "workerModel", "workerProvider",
    ]);
  });

  test("only the worker role when supervisor is omitted", () => {
    const updates = roleConfigUpdates({ provider: "codex", model: "gpt-5-codex" }, undefined);
    expect(updates).toEqual({ workerProvider: "codex", workerModel: "gpt-5-codex" });
  });
});

describe("limitsConfigUpdates", () => {
  test("emits only the provided limit keys, all stringified", () => {
    const updates = limitsConfigUpdates({ pollIntervalMs: 15000, confirmPolls: 3 });
    expect(updates).toEqual({ pollIntervalMs: "15000", confirmPolls: "3" });
  });

  test("namespaces array is joined newline-separated", () => {
    const updates = limitsConfigUpdates({ namespaces: ["default", "kube-system"] });
    expect(updates).toEqual({ namespaces: "default\nkube-system" });
  });

  test("empty namespaces array clears the key to empty string (all namespaces)", () => {
    expect(limitsConfigUpdates({ namespaces: [] })).toEqual({ namespaces: "" });
  });

  test("an empty input produces no updates", () => {
    expect(limitsConfigUpdates({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// install-time ConfigMap seeding (Task 4)
// ---------------------------------------------------------------------------

test("install ConfigMap seeds the role keys from the selections", () => {
  const yaml = manifestYAML(config({
    worker: { provider: "gemini", model: "gemini-2.5-pro" },
    supervisor: { provider: "claude", model: "claude-opus-4-8", effort: "high" },
  }));
  expect(yaml).toContain("workerProvider: gemini");
  expect(yaml).toContain("workerModel: gemini-2.5-pro");
  expect(yaml).toContain("supervisorProvider: claude");
  expect(yaml).toContain("supervisorModel: claude-opus-4-8");
  expect(yaml).toContain("supervisorEffort: high");
});

test("install ConfigMap seeds the operational limit keys", () => {
  const yaml = manifestYAML(config({ pollIntervalMs: 45000, confirmPolls: 4, namespaces: "default,kube-system" }));
  expect(yaml).toContain('pollIntervalMs: "45000"');
  expect(yaml).toContain('confirmPolls: "4"');
  expect(yaml).toContain("namespaces:");
});

test("install ConfigMap defaults role keys to claude worker/supervisor when no selection given", () => {
  const yaml = manifestYAML(config());
  expect(yaml).toContain("workerProvider: claude");
  expect(yaml).toContain("workerModel: claude-sonnet-4-6");
  expect(yaml).toContain("supervisorProvider: claude");
  expect(yaml).toContain("supervisorModel: claude-opus-4-8");
});

test("kill switch still starts enabled", () => {
  expect(manifestYAML(config())).toContain('enabled: "true"');
});

// ---------------------------------------------------------------------------
// Canonical credential → env table (BYO credential Secrets, Phase 1)
// ---------------------------------------------------------------------------

import {
  CREDENTIAL_ENV,
  CREDENTIAL_STORE_LABEL,
  CREDENTIAL_ANNOTATION_PREFIX,
} from "./assistant";

describe("CREDENTIAL_ENV", () => {
  const ids = [
    "claudeToken",
    "anthropicApiKey",
    "codexApiKey",
    "codexAuthContent",
    "geminiApiKey",
    "opencodeApiKey",
    "opencodeAuthContent",
  ];

  test("has all 7 credential ids in the canonical order", () => {
    expect(CREDENTIAL_ENV.map((e) => e.id)).toEqual(ids);
  });

  test("each env var name matches the existing Deployment env", () => {
    const yaml = deployment(config());
    for (const entry of CREDENTIAL_ENV) {
      expect(yaml).toContain(`name: ${entry.env}`);
    }
  });

  test("claudeToken is the only entry sourced from SECRET_NAME (rest from CREDENTIALS_SECRET_NAME)", () => {
    for (const entry of CREDENTIAL_ENV) {
      if (entry.id === "claudeToken") {
        expect(entry.defaultSecret).toBe(SECRET_NAME);
        expect(entry.defaultKey).toBe("token");
      } else {
        expect(entry.defaultSecret).toBe(CREDENTIALS_SECRET_NAME);
        expect(entry.defaultKey).toBe(entry.id);
      }
    }
  });

  test("exports the discovery label + annotation prefix conventions", () => {
    expect(CREDENTIAL_STORE_LABEL).toBe("rigel.assistant/credential-store");
    expect(CREDENTIAL_ANNOTATION_PREFIX).toBe("rigel.assistant/credential.");
  });
});

// ---------------------------------------------------------------------------
// resolveCredentialSources (BYO credential Secrets, Phase 1)
// ---------------------------------------------------------------------------

import { resolveCredentialSources, type SecretLike } from "./assistant";
import { CREDENTIALS_SECRET_NAME as CSN, SECRET_NAME as SN } from "./assistant";

describe("resolveCredentialSources", () => {
  test("resolves a credential-store Secret via its annotation + non-empty data", () => {
    const secrets: SecretLike[] = [
      {
        metadata: {
          name: "my-anthropic",
          labels: { "rigel.assistant/credential-store": "true" },
          annotations: { "rigel.assistant/credential.anthropicApiKey": "api-key" },
        },
        data: { "api-key": "x" },
      },
    ];
    const r = resolveCredentialSources(secrets);
    expect(r.sources.anthropicApiKey).toEqual({
      secretName: "my-anthropic",
      dataKey: "api-key",
      hasValue: true,
    });
    expect(r.conflicts).toEqual([]);
  });

  test("an empty data value resolves with hasValue: false", () => {
    const secrets: SecretLike[] = [
      {
        metadata: {
          name: "my-anthropic",
          labels: { "rigel.assistant/credential-store": "true" },
          annotations: { "rigel.assistant/credential.anthropicApiKey": "api-key" },
        },
        data: { "api-key": "" },
      },
    ];
    expect(resolveCredentialSources(secrets).sources.anthropicApiKey).toEqual({
      secretName: "my-anthropic",
      dataKey: "api-key",
      hasValue: false,
    });
  });

  test("legacy fallback: un-annotated managed Secrets resolve via the default keys", () => {
    const secrets: SecretLike[] = [
      { metadata: { name: CSN }, data: { codexApiKey: "c" } },
      { metadata: { name: SN }, data: { token: "t" } },
    ];
    const r = resolveCredentialSources(secrets);
    expect(r.sources.codexApiKey).toEqual({ secretName: CSN, dataKey: "codexApiKey", hasValue: true });
    expect(r.sources.claudeToken).toEqual({ secretName: SN, dataKey: "token", hasValue: true });
  });

  test("annotation wins over legacy when both could resolve the same id", () => {
    const secrets: SecretLike[] = [
      // legacy credentials Secret carries anthropicApiKey by default key
      { metadata: { name: CSN }, data: { anthropicApiKey: "legacy" } },
      // an annotated BYO source claims anthropicApiKey too
      {
        metadata: {
          name: "byo",
          labels: { "rigel.assistant/credential-store": "true" },
          annotations: { "rigel.assistant/credential.anthropicApiKey": "api-key" },
        },
        data: { "api-key": "x" },
      },
    ];
    const r = resolveCredentialSources(secrets);
    expect(r.sources.anthropicApiKey).toEqual({
      secretName: "byo",
      dataKey: "api-key",
      hasValue: true,
    });
  });

  test("two credential-store Secrets claiming one id: alphabetically-first wins, id in conflicts", () => {
    const secrets: SecretLike[] = [
      {
        metadata: {
          name: "zebra",
          labels: { "rigel.assistant/credential-store": "true" },
          annotations: { "rigel.assistant/credential.geminiApiKey": "k" },
        },
        data: { k: "z" },
      },
      {
        metadata: {
          name: "alpha",
          labels: { "rigel.assistant/credential-store": "true" },
          annotations: { "rigel.assistant/credential.geminiApiKey": "k" },
        },
        data: { k: "a" },
      },
    ];
    const r = resolveCredentialSources(secrets);
    expect(r.sources.geminiApiKey?.secretName).toBe("alpha");
    expect(r.conflicts).toContain("geminiApiKey");
  });

  test("unknown rigel.assistant/credential.<garbage> annotation is ignored", () => {
    const secrets: SecretLike[] = [
      {
        metadata: {
          name: "s",
          labels: { "rigel.assistant/credential-store": "true" },
          annotations: { "rigel.assistant/credential.bogusId": "k" },
        },
        data: { k: "v" },
      },
    ];
    const r = resolveCredentialSources(secrets);
    expect(Object.keys(r.sources)).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// credentialSourceCommands / clearCredentialSourceCommands (BYO, Phase 2)
// ---------------------------------------------------------------------------

import {
  credentialSourceCommands,
  clearCredentialSourceCommands,
} from "./assistant";

const STORE = "rigel.assistant/credential-store";

describe("credentialSourceCommands", () => {
  test("labels + annotates the chosen Secret (no siblings)", () => {
    const cmds = credentialSourceCommands(
      { credentialId: "anthropicApiKey", secretName: "my-sec", dataKey: "api-key" },
      [],
      "default",
    );
    expect(cmds).toEqual([
      ["label", "secret", "my-sec", `${STORE}=true`, "--overwrite", "-n", "default"],
      ["annotate", "secret", "my-sec", "rigel.assistant/credential.anthropicApiKey=api-key", "--overwrite", "-n", "default"],
    ]);
  });

  test("removes the id annotation from every OTHER credential-store claimant (single-owner)", () => {
    const current: SecretLike[] = [
      {
        metadata: {
          name: "old-source",
          labels: { [STORE]: "true" },
          annotations: { "rigel.assistant/credential.anthropicApiKey": "key" },
        },
        data: { key: "x" },
      },
      {
        metadata: {
          name: "another-claimant",
          labels: { [STORE]: "true" },
          annotations: { "rigel.assistant/credential.anthropicApiKey": "k2" },
        },
        data: { k2: "y" },
      },
    ];
    const cmds = credentialSourceCommands(
      { credentialId: "anthropicApiKey", secretName: "new-sec", dataKey: "api-key" },
      current,
      "agents",
    );
    expect(cmds[0]).toEqual(["label", "secret", "new-sec", `${STORE}=true`, "--overwrite", "-n", "agents"]);
    expect(cmds[1]).toEqual(["annotate", "secret", "new-sec", "rigel.assistant/credential.anthropicApiKey=api-key", "--overwrite", "-n", "agents"]);
    // Sibling removals (alphabetical), id annotation stripped with the `-` suffix.
    expect(cmds.slice(2)).toEqual([
      ["annotate", "secret", "another-claimant", "rigel.assistant/credential.anthropicApiKey-", "-n", "agents"],
      ["annotate", "secret", "old-source", "rigel.assistant/credential.anthropicApiKey-", "-n", "agents"],
    ]);
  });

  test("does not emit a self-removal when the chosen Secret already claims the id", () => {
    const current: SecretLike[] = [
      {
        metadata: {
          name: "my-sec",
          labels: { [STORE]: "true" },
          annotations: { "rigel.assistant/credential.geminiApiKey": "old-key" },
        },
        data: { "old-key": "x" },
      },
    ];
    const cmds = credentialSourceCommands(
      { credentialId: "geminiApiKey", secretName: "my-sec", dataKey: "new-key" },
      current,
      "default",
    );
    // Only label + annotate the chosen Secret; no `-` removal against itself.
    expect(cmds).toHaveLength(2);
    expect(cmds.some((c) => c.includes("rigel.assistant/credential.geminiApiKey-"))).toBe(false);
  });
});

describe("clearCredentialSourceCommands", () => {
  test("removes the id annotation from every claimant except the managed default", () => {
    const current: SecretLike[] = [
      // BYO source (should be cleared)
      {
        metadata: {
          name: "byo-source",
          labels: { [STORE]: "true" },
          annotations: { "rigel.assistant/credential.anthropicApiKey": "api-key" },
        },
        data: { "api-key": "x" },
      },
      // the managed default credentials Secret (should be KEPT so the fallback works)
      {
        metadata: {
          name: CREDENTIALS_SECRET_NAME,
          labels: { [STORE]: "true" },
          annotations: { "rigel.assistant/credential.anthropicApiKey": "anthropicApiKey" },
        },
        data: { anthropicApiKey: "y" },
      },
    ];
    const cmds = clearCredentialSourceCommands("anthropicApiKey", current, "default");
    expect(cmds).toEqual([
      ["annotate", "secret", "byo-source", "rigel.assistant/credential.anthropicApiKey-", "-n", "default"],
    ]);
  });

  test("no claimants → no commands", () => {
    expect(clearCredentialSourceCommands("geminiApiKey", [], "default")).toEqual([]);
  });

  test("the managed legacy token Secret is preserved when clearing claudeToken", () => {
    const current: SecretLike[] = [
      {
        metadata: {
          name: SECRET_NAME,
          labels: { [STORE]: "true" },
          annotations: { "rigel.assistant/credential.claudeToken": "token" },
        },
        data: { token: "t" },
      },
      {
        metadata: {
          name: "byo-token",
          labels: { [STORE]: "true" },
          annotations: { "rigel.assistant/credential.claudeToken": "tok" },
        },
        data: { tok: "x" },
      },
    ];
    const cmds = clearCredentialSourceCommands("claudeToken", current, "default");
    expect(cmds).toEqual([
      ["annotate", "secret", "byo-token", "rigel.assistant/credential.claudeToken-", "-n", "default"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// deployment() templates credential env from a resolution (BYO, Phase 2)
// ---------------------------------------------------------------------------

import { credentialEnvYAML, type ResolvedSource } from "./assistant";

describe("deployment credential env templating", () => {
  test("no sources arg is byte-identical to today's managed-Secret output", () => {
    // The default ({}) render must keep referencing the managed Secrets exactly:
    // the legacy token from SECRET_NAME/token and the six provider keys from
    // CREDENTIALS_SECRET_NAME by their default key.
    const yaml = deployment(config());
    expect(yaml).toContain(`                  name: ${SECRET_NAME}
                  key: token
                  optional: true`);
    for (const entry of CREDENTIAL_ENV) {
      if (entry.id === "claudeToken") continue;
      expect(yaml).toContain(`                  name: ${CREDENTIALS_SECRET_NAME}
                  key: ${entry.defaultKey}
                  optional: true`);
    }
    // An explicit empty-sources render equals the no-arg render.
    expect(deployment(config(), {})).toBe(deployment(config()));
  });

  test("a repointed credential renders its secretKeyRef at the chosen Secret + key", () => {
    const sources: Partial<Record<keyof AssistantCredentials, ResolvedSource>> = {
      anthropicApiKey: { secretName: "my-sec", dataKey: "api-key", hasValue: true },
    };
    const yaml = deployment(config(), sources);
    expect(yaml).toContain(`            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: my-sec
                  key: api-key
                  optional: true`);
    // The other six stay at their CREDENTIAL_ENV defaults.
    expect(yaml).toContain(`            - name: CLAUDE_CODE_OAUTH_TOKEN
              valueFrom:
                secretKeyRef:
                  name: ${SECRET_NAME}
                  key: token
                  optional: true`);
    expect(yaml).toContain(`            - name: GEMINI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ${CREDENTIALS_SECRET_NAME}
                  key: geminiApiKey
                  optional: true`);
  });

  test("credentialEnvYAML emits 7 optional refs in CREDENTIAL_ENV order", () => {
    const block = credentialEnvYAML();
    const envOrder = [...block.matchAll(/- name: (\w+)/g)].map((m) => m[1]);
    expect(envOrder).toEqual(CREDENTIAL_ENV.map((e) => e.env));
    expect(block.match(/optional: true/g)).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Managed Secrets carry the credential-store label + per-credential annotations
// ---------------------------------------------------------------------------

describe("managed Secret YAML stamps label + annotations", () => {
  test("secretYAML carries the credential-store label + claudeToken annotation", () => {
    const yaml = secretYAML("sk-test", "2026-01-01T00:00:00Z", "default");
    expect(yaml).toContain('rigel.assistant/credential-store: "true"');
    expect(yaml).toContain('rigel.assistant/credential.claudeToken: "token"');
    // existing metadata is preserved
    expect(yaml).toContain("app.kubernetes.io/managed-by: rigel-assistant");
    expect(yaml).toContain(`${ISSUED_AT_ANNOTATION}: "2026-01-01T00:00:00Z"`);
  });

  test("credentialsSecretYAML annotates only the keys actually written", () => {
    const yaml = credentialsSecretYAML({ geminiApiKey: "g", codexApiKey: "" }, "default");
    expect(yaml).toContain('rigel.assistant/credential-store: "true"');
    expect(yaml).toContain('rigel.assistant/credential.geminiApiKey: "geminiApiKey"');
    // codexApiKey was empty → not written → not annotated
    expect(yaml).not.toContain("rigel.assistant/credential.codexApiKey");
    expect(yaml).toContain("app.kubernetes.io/managed-by: rigel-assistant");
  });

  test("credentialsSecretYAML with all keys annotates each one", () => {
    const yaml = credentialsSecretYAML(
      {
        claudeToken: "t",
        anthropicApiKey: "a",
        codexApiKey: "c",
        codexAuthContent: "cblob",
        geminiApiKey: "g",
        opencodeApiKey: "o",
        opencodeAuthContent: "blob",
      },
      "default",
    );
    for (const k of [
      "claudeToken",
      "anthropicApiKey",
      "codexApiKey",
      "codexAuthContent",
      "geminiApiKey",
      "opencodeApiKey",
      "opencodeAuthContent",
    ]) {
      expect(yaml).toContain(`rigel.assistant/credential.${k}: "${k}"`);
    }
  });

  test("an empty creds map still produces a valid Secret carrying the label", () => {
    const yaml = credentialsSecretYAML({}, "default");
    expect(yaml).toContain('rigel.assistant/credential-store: "true"');
    expect(yaml).toContain(`name: ${CREDENTIALS_SECRET_NAME}`);
    expect(yaml).toContain("kind: Secret");
  });
});

// ---------------------------------------------------------------------------
// reconcileCommands / needsReconcile (legacy-install repair, Phase 3 / Task A1)
// ---------------------------------------------------------------------------

import { reconcileCommands, needsReconcile } from "./assistant";

describe("reconcileCommands", () => {
  test("stamps label + annotation on a legacy default Secret resolved by fallback", () => {
    // A legacy install: the default credentials Secret holds codexApiKey by its
    // default key but carries NO credential-store label/annotations → resolution
    // falls back. Reconcile makes that fallback explicit.
    const secrets: SecretLike[] = [
      { metadata: { name: CREDENTIALS_SECRET_NAME }, data: { codexApiKey: "c" } },
    ];
    const cmds = reconcileCommands(secrets, "default");
    expect(cmds).toEqual([
      ["label", "secret", CREDENTIALS_SECRET_NAME, `${STORE}=true`, "--overwrite", "-n", "default"],
      ["annotate", "secret", CREDENTIALS_SECRET_NAME, "rigel.assistant/credential.codexApiKey=codexApiKey", "--overwrite", "-n", "default"],
    ]);
  });

  test("stamps the legacy token Secret (claudeToken via token key)", () => {
    const secrets: SecretLike[] = [{ metadata: { name: SECRET_NAME }, data: { token: "t" } }];
    const cmds = reconcileCommands(secrets, "agents");
    expect(cmds).toEqual([
      ["label", "secret", SECRET_NAME, `${STORE}=true`, "--overwrite", "-n", "agents"],
      ["annotate", "secret", SECRET_NAME, "rigel.assistant/credential.claudeToken=token", "--overwrite", "-n", "agents"],
    ]);
  });

  test("two fallback ids on the SAME default Secret share a single label command", () => {
    const secrets: SecretLike[] = [
      { metadata: { name: CREDENTIALS_SECRET_NAME }, data: { codexApiKey: "c", geminiApiKey: "g" } },
    ];
    const cmds = reconcileCommands(secrets, "default");
    const labels = cmds.filter((c) => c[0] === "label");
    expect(labels).toHaveLength(1);
    expect(labels[0]).toEqual(["label", "secret", CREDENTIALS_SECRET_NAME, `${STORE}=true`, "--overwrite", "-n", "default"]);
    // One annotate per fallback id (ordered by CREDENTIAL_ENV).
    expect(cmds.filter((c) => c[0] === "annotate")).toEqual([
      ["annotate", "secret", CREDENTIALS_SECRET_NAME, "rigel.assistant/credential.codexApiKey=codexApiKey", "--overwrite", "-n", "default"],
      ["annotate", "secret", CREDENTIALS_SECRET_NAME, "rigel.assistant/credential.geminiApiKey=geminiApiKey", "--overwrite", "-n", "default"],
    ]);
  });

  test("idempotent: an already-annotated (claimed) id produces NO commands", () => {
    const secrets: SecretLike[] = [
      {
        metadata: {
          name: CREDENTIALS_SECRET_NAME,
          labels: { [STORE]: "true" },
          annotations: { "rigel.assistant/credential.codexApiKey": "codexApiKey" },
        },
        data: { codexApiKey: "c" },
      },
    ];
    expect(reconcileCommands(secrets, "default")).toEqual([]);
  });

  test("conflict-safe: never stamps an id already claimed by ANY credential-store Secret", () => {
    // A BYO Secret already claims anthropicApiKey by annotation. The default
    // credentials Secret also carries the default anthropicApiKey key, but
    // reconcile must NOT stamp it (that would create a second claimant = conflict).
    const secrets: SecretLike[] = [
      {
        metadata: {
          name: "byo-anthropic",
          labels: { [STORE]: "true" },
          annotations: { "rigel.assistant/credential.anthropicApiKey": "api-key" },
        },
        data: { "api-key": "x" },
      },
      { metadata: { name: CREDENTIALS_SECRET_NAME }, data: { anthropicApiKey: "legacy" } },
    ];
    const cmds = reconcileCommands(secrets, "default");
    expect(cmds.some((c) => c.join(" ").includes("anthropicApiKey"))).toBe(false);
    expect(cmds).toEqual([]);
  });

  test("absent Secret / missing default key produces NO commands", () => {
    // No default Secret at all.
    expect(reconcileCommands([], "default")).toEqual([]);
    // Default Secret present but missing the default key for the id.
    const secrets: SecretLike[] = [
      { metadata: { name: CREDENTIALS_SECRET_NAME }, data: { somethingElse: "x" } },
    ];
    expect(reconcileCommands(secrets, "default")).toEqual([]);
  });

  test("a default Secret with an empty default value is still stamped (presence, not value)", () => {
    // The key EXISTS (empty string), so the legacy fallback resolves it; reconcile
    // makes that explicit regardless of the value (readiness is a separate concern).
    const secrets: SecretLike[] = [
      { metadata: { name: CREDENTIALS_SECRET_NAME }, data: { geminiApiKey: "" } },
    ];
    const cmds = reconcileCommands(secrets, "default");
    expect(cmds).toEqual([
      ["label", "secret", CREDENTIALS_SECRET_NAME, `${STORE}=true`, "--overwrite", "-n", "default"],
      ["annotate", "secret", CREDENTIALS_SECRET_NAME, "rigel.assistant/credential.geminiApiKey=geminiApiKey", "--overwrite", "-n", "default"],
    ]);
  });

  test("never emits an apply, rollout, restart, or patch (metadata-only)", () => {
    const secrets: SecretLike[] = [
      { metadata: { name: CREDENTIALS_SECRET_NAME }, data: { codexApiKey: "c" } },
      { metadata: { name: SECRET_NAME }, data: { token: "t" } },
    ];
    const verbs = new Set(reconcileCommands(secrets, "default").map((c) => c[0]));
    for (const forbidden of ["apply", "rollout", "restart", "patch", "delete"]) {
      expect(verbs.has(forbidden)).toBe(false);
    }
    expect([...verbs].sort()).toEqual(["annotate", "label"]);
  });
});

describe("needsReconcile", () => {
  test("true when a legacy default Secret needs stamping", () => {
    const secrets: SecretLike[] = [
      { metadata: { name: CREDENTIALS_SECRET_NAME }, data: { codexApiKey: "c" } },
    ];
    expect(needsReconcile(secrets)).toBe(true);
  });

  test("false when everything is already annotated", () => {
    const secrets: SecretLike[] = [
      {
        metadata: {
          name: CREDENTIALS_SECRET_NAME,
          labels: { [STORE]: "true" },
          annotations: { "rigel.assistant/credential.codexApiKey": "codexApiKey" },
        },
        data: { codexApiKey: "c" },
      },
    ];
    expect(needsReconcile(secrets)).toBe(false);
  });

  test("false for no managed Secrets", () => {
    expect(needsReconcile([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Matrix access token env injection (Task 8)
// ---------------------------------------------------------------------------

test("the agent Deployment injects the Matrix access token from its Secret, optional", () => {
  const yaml = manifestYAML(DEFAULT_INSTALL_CONFIG);
  expect(yaml).toContain("- name: MATRIX_ACCESS_TOKEN");
  expect(yaml).toContain("name: rigel-matrix-token");
  expect(yaml).toContain("key: accessToken");
  // optional: true so installs without Matrix configured still start.
  expect(yaml).toMatch(/MATRIX_ACCESS_TOKEN[\s\S]*?optional: true/);
});

// ---------------------------------------------------------------------------
// autofixConfigUpdates — agent-opened fix PR control surface (Phase 5)
//
// HIGHEST-RISK contract: what this writes to assistant-config MUST be exactly
// what the in-cluster agent reads. The three parse functions below are verbatim
// mirrors of agent/src/runtimeConfig.ts (parseAutofixConfig / parseAutofixScope /
// parseAutofixMaxPerDay) — kept local so the test has no cross-package dep. The
// round-trip assertions decode our updates with the agent's exact logic and
// confirm we get the intended config back. If the agent reader ever changes,
// update these mirrors in lockstep.
// ---------------------------------------------------------------------------

import { autofixConfigUpdates } from "./assistant";

const DEFAULT_AUTOFIX_MAX_PER_DAY = 5;
// --- verbatim mirror of agent/src/runtimeConfig.ts ---
function agentParseAutofixMaxPerDay(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  if (!v) return DEFAULT_AUTOFIX_MAX_PER_DAY;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_AUTOFIX_MAX_PER_DAY;
}
function agentParseAutofixScope(raw: string | undefined): { projects: string[] } {
  if (!raw || !raw.trim()) return { projects: [] };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { projects: [] };
  }
  const o = obj as { projects?: unknown };
  const strings = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim())
      : [];
  return { projects: strings(o?.projects) };
}
function agentParseAutofixConfig(data: Record<string, string>) {
  return {
    enabled: data["autofixEnabled"] === "true",
    scope: agentParseAutofixScope(data["autofixScope"]),
    maxPerDay: agentParseAutofixMaxPerDay(data["autofixMaxPerDay"]),
  };
}

describe("autofixConfigUpdates", () => {
  test("emits the EXACT keys the agent reads, with the agent's encodings", () => {
    const updates = autofixConfigUpdates({
      enabled: true,
      maxPerDay: 8,
      scope: { projects: ["prod/web", "default/api"] },
    });
    expect(updates).toEqual({
      autofixEnabled: "true",
      autofixMaxPerDay: "8",
      autofixScope: JSON.stringify({ projects: ["prod/web", "default/api"] }),
    });
  });

  test("round-trips through the agent's parser to the intended config", () => {
    const updates = autofixConfigUpdates({
      enabled: true,
      maxPerDay: 3,
      scope: { projects: ["staging/api", "staging/worker"] },
    });
    const parsed = agentParseAutofixConfig(updates);
    expect(parsed).toEqual({
      enabled: true,
      maxPerDay: 3,
      scope: { projects: ["staging/api", "staging/worker"] },
    });
  });

  test("disabled + empty scope round-trips to the agent's disabled state", () => {
    const updates = autofixConfigUpdates({ enabled: false, maxPerDay: 0, scope: { projects: [] } });
    expect(updates.autofixEnabled).toBe("false");
    const parsed = agentParseAutofixConfig(updates);
    expect(parsed.enabled).toBe(false);
    expect(parsed.maxPerDay).toBe(0); // 0 disables fix PRs but is honored, not the default
    expect(parsed.scope).toEqual({ projects: [] });
  });

  test("clamps + floors maxPerDay to a non-negative integer", () => {
    expect(autofixConfigUpdates({ maxPerDay: 5.9 }).autofixMaxPerDay).toBe("5");
    expect(autofixConfigUpdates({ maxPerDay: -4 }).autofixMaxPerDay).toBe("0");
  });

  test("drops a non-finite maxPerDay (agent fails safe to its default)", () => {
    const updates = autofixConfigUpdates({ maxPerDay: Number.NaN });
    expect(updates.autofixMaxPerDay).toBeUndefined();
    expect(agentParseAutofixMaxPerDay(updates.autofixMaxPerDay)).toBe(DEFAULT_AUTOFIX_MAX_PER_DAY);
  });

  test("trims, drops empties, and dedupes scope entries", () => {
    const updates = autofixConfigUpdates({
      scope: { projects: [" prod/web ", "prod/web", "", "prod/api"] },
    });
    expect(JSON.parse(updates.autofixScope)).toEqual({
      projects: ["prod/web", "prod/api"],
    });
  });

  test("emits only the provided fields (partial update never clobbers the others)", () => {
    expect(autofixConfigUpdates({ enabled: true })).toEqual({ autofixEnabled: "true" });
    expect(autofixConfigUpdates({})).toEqual({});
    // A scope-only update leaves enabled/maxPerDay untouched.
    expect(Object.keys(autofixConfigUpdates({ scope: { projects: ["x/y"] } }))).toEqual(["autofixScope"]);
  });
});

// ---------------------------------------------------------------------------
// digestState decode (Task 3 — scheduled digests)
// ---------------------------------------------------------------------------

it("decodes digestState (lastSentAt + lastPreview)", () => {
  const raw = JSON.stringify({
    updatedAt: "2026-06-30T07:00:00.000Z", audit: [], queue: [], report: "",
    digestState: {
      lastSentAt: { a: "2026-06-30T07:00:00.000Z" },
      lastPreview: { id: "a", at: "2026-06-30T06:59:00.000Z", text: "All clear." },
    },
  });
  const s = decodeClusterState(raw);
  expect(s?.digestState?.lastSentAt.a).toBe("2026-06-30T07:00:00.000Z");
  expect(s?.digestState?.lastPreview?.text).toBe("All clear.");
});
