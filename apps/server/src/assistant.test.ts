import { test, expect, describe, vi, afterEach } from "vitest";
import { validateInstall } from "./assistant";

// Install validation (mirrors Swift AssistantViewModel.install() guards). The
// happy path and each rejection are deterministic and run without a cluster.

test("validateInstall accepts a lowercase namespace + image + token", () => {
  expect(() =>
    validateInstall("default", "sk-token", "ghcr.io/acme/rigel-assistant:latest"),
  ).not.toThrow();
});

test("validateInstall rejects an empty token", () => {
  expect(() => validateInstall("default", "   ", "ghcr.io/acme/x:latest")).toThrow(/setup-token/);
});

test("validateInstall rejects an empty image", () => {
  expect(() => validateInstall("default", "sk", "  ")).toThrow(/container image/);
});

test("validateInstall rejects an uppercase image repository", () => {
  expect(() => validateInstall("default", "sk", "ghcr.io/Acme/x:latest")).toThrow(/lowercase/);
});

test("validateInstall ignores the tag when checking image case", () => {
  // Uppercase only in the TAG is allowed (k8s only rejects uppercase repos).
  expect(() => validateInstall("default", "sk", "ghcr.io/acme/x:LATEST")).not.toThrow();
});

test("validateInstall rejects an empty namespace", () => {
  expect(() => validateInstall("  ", "sk", "ghcr.io/acme/x:latest")).toThrow(/install namespace/);
});

test("validateInstall rejects an uppercase namespace", () => {
  expect(() => validateInstall("Default", "sk", "ghcr.io/acme/x:latest")).toThrow(/lowercase/);
});

import { parseCredentials, type AssistantRequest } from "./assistant";

test("parseCredentials picks up every provided credential, trimming empties", () => {
  const req: AssistantRequest = {
    action: "setCredentials",
    credentials: {
      geminiApiKey: "g-1",
      codexApiKey: "   ",
      opencodeAuthContent: "blob",
      anthropicApiKey: "",
    },
  };
  expect(parseCredentials(req)).toEqual({ geminiApiKey: "g-1", opencodeAuthContent: "blob" });
});

test("parseCredentials maps a legacy top-level token onto claudeToken", () => {
  const req: AssistantRequest = { action: "setCredentials", token: "tok-legacy" };
  expect(parseCredentials(req)).toEqual({ claudeToken: "tok-legacy" });
});

test("parseCredentials returns an empty object when nothing is provided", () => {
  expect(parseCredentials({ action: "setCredentials" })).toEqual({});
});

import { buildInstallConfig } from "./assistant";

test("buildInstallConfig carries the role selections + limits onto the install config", () => {
  const cfg = buildInstallConfig({
    action: "install",
    namespace: "agents",
    image: "ghcr.io/acme/rigel-assistant:v1",
    worker: { provider: "gemini", model: "gemini-2.5-pro" },
    supervisor: { provider: "claude", model: "claude-opus-4-8", effort: "high" },
    limits: { pollIntervalMs: 45000, confirmPolls: 4, namespaces: ["default", "kube-system"] },
  });
  expect(cfg.installNamespace).toBe("agents");
  expect(cfg.image).toBe("ghcr.io/acme/rigel-assistant:v1");
  expect(cfg.worker).toEqual({ provider: "gemini", model: "gemini-2.5-pro" });
  expect(cfg.supervisor).toEqual({ provider: "claude", model: "claude-opus-4-8", effort: "high" });
  expect(cfg.pollIntervalMs).toBe(45000);
  expect(cfg.confirmPolls).toBe(4);
  expect(cfg.namespaces).toBe("default,kube-system");
});

test("buildInstallConfig falls back to legacy model knobs + defaults when no selection/limits given", () => {
  const cfg = buildInstallConfig({ action: "install" });
  expect(cfg.installNamespace).toBe("default");
  expect(cfg.workerModel).toBe("claude-sonnet-4-6");
  expect(cfg.supervisorModel).toBe("claude-opus-4-8");
  expect(cfg.pollIntervalMs).toBe(30000);
  expect(cfg.worker).toBeUndefined();
  expect(cfg.supervisor).toBeUndefined();
});

import { setModelsUpdates, setCredentialsSecrets, setModeUpdates } from "./assistant";

test("setModeUpdates writes only mode + trimmed window when no webhook is supplied", () => {
  const updates = setModeUpdates({ action: "setMode", mode: "window", window: " 22:00-07:00 " });
  expect(updates).toEqual({ mode: "window", window: "22:00-07:00" });
  // Leaving the webhook out must not touch (and so never clear) the stored URL.
  expect("webhookUrl" in updates).toBe(false);
});

test("setModeUpdates persists a trimmed webhookUrl alongside the mode when supplied", () => {
  const updates = setModeUpdates({
    action: "setMode",
    mode: "auto",
    webhook: "  https://hooks.example/x  ",
  });
  expect(updates).toEqual({ mode: "auto", window: "", webhookUrl: "https://hooks.example/x" });
});

test("setModeUpdates writes an empty webhookUrl to clear it (explicit empty string)", () => {
  const updates = setModeUpdates({ action: "setMode", mode: "auto", webhook: "" });
  expect(updates.webhookUrl).toBe("");
});

test("setModelsUpdates produces the assistant-config role keys for a worker-only switch", () => {
  const updates = setModelsUpdates({
    action: "setModels",
    worker: { provider: "codex", model: "gpt-5-codex" },
  });
  expect(updates).toEqual({ workerProvider: "codex", workerModel: "gpt-5-codex" });
});

test("setModelsUpdates includes both roles + effort when supplied", () => {
  const updates = setModelsUpdates({
    action: "setModels",
    worker: { provider: "claude", model: "claude-sonnet-4-6", effort: "medium" },
    supervisor: { provider: "gemini", model: "gemini-2.5-pro" },
  });
  expect(updates).toEqual({
    workerProvider: "claude", workerModel: "claude-sonnet-4-6", workerEffort: "medium",
    supervisorProvider: "gemini", supervisorModel: "gemini-2.5-pro",
  });
});

test("setCredentialsSecrets builds the credentials Secret YAML (+ legacy token YAML when claudeToken present)", () => {
  const out = setCredentialsSecrets(
    { action: "setCredentials", credentials: { geminiApiKey: "g-1", claudeToken: "tok" } },
    "agents",
    new Date("2026-06-23T00:00:00Z"),
  );
  expect(out.credentialsYaml).toContain("name: rigel-assistant-credentials");
  expect(out.credentialsYaml).toContain('geminiApiKey: "g-1"');
  expect(out.credentialsYaml).toContain('claudeToken: "tok"');
  // Legacy token Secret is also re-stamped (so existing CLAUDE_CODE_OAUTH_TOKEN refs refresh).
  expect(out.legacyTokenYaml).not.toBeNull();
  expect(out.legacyTokenYaml).toContain("name: rigel-assistant-token");
  expect(out.legacyTokenYaml).toContain('token: "tok"');
});

test("setCredentialsSecrets emits no legacy token YAML when no claudeToken", () => {
  const out = setCredentialsSecrets(
    { action: "setCredentials", credentials: { codexApiKey: "c-1" } },
    "default",
    new Date(),
  );
  expect(out.legacyTokenYaml).toBeNull();
  expect(out.credentialsYaml).toContain('codexApiKey: "c-1"');
});

import { setLimitsUpdates } from "./assistant";

test("setLimitsUpdates produces only the provided limit keys, stringified", () => {
  const updates = setLimitsUpdates({
    action: "setLimits",
    limits: { pollIntervalMs: 60000, maxPerNight: 10, namespaces: ["default"] },
  });
  expect(updates).toEqual({ pollIntervalMs: "60000", maxPerNight: "10", namespaces: "default" });
});

test("setLimitsUpdates throws-worthy empty input is detectable (no keys)", () => {
  expect(setLimitsUpdates({ action: "setLimits" })).toEqual({});
});

import { setAutofixUpdates } from "./assistant";

test("setAutofixUpdates writes the EXACT autofix keys/encodings the agent reads", () => {
  const updates = setAutofixUpdates({
    action: "setAutofix",
    autofixEnabled: true,
    autofixMaxPerDay: 7,
    autofixScope: { projects: ["prod/web", "prod/api"] },
  });
  expect(updates).toEqual({
    autofixEnabled: "true",
    autofixMaxPerDay: "7",
    autofixScope: JSON.stringify({ projects: ["prod/web", "prod/api"] }),
  });
});

test("setAutofixUpdates emits only the provided fields (empty input → no keys)", () => {
  expect(setAutofixUpdates({ action: "setAutofix", autofixEnabled: false })).toEqual({ autofixEnabled: "false" });
  expect(setAutofixUpdates({ action: "setAutofix" })).toEqual({});
});

import { credentialStatus } from "./assistant";
import type { RunResult } from "@rigel/k8s/src/run";

// Drive credentialStatus with a fake kubectl that returns a label-selected Secret
// list. Asserts the existing `{ credentialKeys: string[] }` shape is preserved
// (web unchanged) and that NO secret values appear in the output. b64 helper so
// `data` values mirror a real `kubectl get -o json` (base64-encoded).
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
function fakeKubectl(items: unknown[]): (ctx: string | null, args: string[]) => Promise<RunResult> {
  return async () => ({ code: 0, stdout: JSON.stringify({ items }), stderr: "" });
}

describe("credentialStatus", () => {
  test("resolves readiness via annotated + legacy + token paths, no values leak", async () => {
    const items = [
      // annotated BYO source
      {
        metadata: {
          name: "byo-anthropic",
          labels: { "rigel.assistant/credential-store": "true" },
          annotations: { "rigel.assistant/credential.anthropicApiKey": "api-key" },
        },
        data: { "api-key": b64("secret-value-should-never-leak") },
      },
      // legacy un-annotated credentials Secret (fallback resolves codexApiKey)
      {
        metadata: { name: "rigel-assistant-credentials" },
        data: { codexApiKey: b64("codex-secret") },
      },
      // legacy token Secret (token → claudeToken)
      {
        metadata: { name: "rigel-assistant-token" },
        data: { token: b64("oauth-token") },
      },
    ];
    const res = await credentialStatus(null, "default", fakeKubectl(items));
    const parsed = JSON.parse(res.stdout) as {
      credentials: Record<string, { ready: boolean; secretName: string }>;
    };
    expect(Object.keys(parsed.credentials).sort()).toEqual(["anthropicApiKey", "claudeToken", "codexApiKey"]);
    expect(parsed.credentials.anthropicApiKey).toEqual({ ready: true, secretName: "byo-anthropic" });
    expect(parsed.credentials.codexApiKey).toEqual({ ready: true, secretName: "rigel-assistant-credentials" });
    expect(parsed.credentials.claudeToken).toEqual({ ready: true, secretName: "rigel-assistant-token" });
    // No secret VALUES (or their base64) may appear anywhere in the output.
    expect(res.stdout).not.toContain("secret-value-should-never-leak");
    expect(res.stdout).not.toContain(b64("secret-value-should-never-leak"));
    expect(res.stdout).not.toContain(b64("oauth-token"));
  });

  test("issues a single label-selected list, never per-name gets", async () => {
    const calls: string[][] = [];
    const spy: (ctx: string | null, args: string[]) => Promise<RunResult> = async (_ctx, args) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    };
    await credentialStatus(null, "agents", spy);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("secrets");
    expect(calls[0]).toContain("-l");
    expect(calls[0]).toContain("app.kubernetes.io/managed-by=rigel-assistant");
    expect(calls[0]).toContain("-n");
    expect(calls[0]).toContain("agents");
  });
});

// ---------------------------------------------------------------------------
// credentialStatus new shape — { credentials: { <id>: { ready, secretName } } }
// (BYO credential Secrets, Phase 2 / Task A4)
// ---------------------------------------------------------------------------

describe("credentialStatus per-credential shape", () => {
  test("returns { ready, secretName } per resolved id, no values leak", async () => {
    const items = [
      {
        metadata: {
          name: "byo-anthropic",
          labels: { "rigel.assistant/credential-store": "true" },
          annotations: { "rigel.assistant/credential.anthropicApiKey": "api-key" },
        },
        data: { "api-key": b64("secret-value-should-never-leak") },
      },
      // empty value → ready:false but still resolved (so the UI shows its source)
      {
        metadata: {
          name: "byo-gemini",
          labels: { "rigel.assistant/credential-store": "true" },
          annotations: { "rigel.assistant/credential.geminiApiKey": "k" },
        },
        data: { k: "" },
      },
    ];
    const res = await credentialStatus(null, "default", fakeKubectl(items));
    const parsed = JSON.parse(res.stdout) as {
      credentials: Record<string, { ready: boolean; secretName: string }>;
    };
    expect(parsed.credentials.anthropicApiKey).toEqual({ ready: true, secretName: "byo-anthropic" });
    expect(parsed.credentials.geminiApiKey).toEqual({ ready: false, secretName: "byo-gemini" });
    // No secret VALUES (or their base64) anywhere; the old shape is gone.
    expect(res.stdout).not.toContain("secret-value-should-never-leak");
    expect(res.stdout).not.toContain(b64("secret-value-should-never-leak"));
    expect(res.stdout).not.toContain("credentialKeys");
  });

  test("no managed Secrets → empty credentials map", async () => {
    const res = await credentialStatus(null, "default", fakeKubectl([]));
    expect((JSON.parse(res.stdout) as { credentials: Record<string, unknown> }).credentials).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// credentialStatus conflicts + needsReconcile (Phase 3 / Task A2)
// ---------------------------------------------------------------------------

describe("credentialStatus conflicts + needsReconcile", () => {
  test("reports conflicts (>1 claimant) and needsReconcile, ids + names only", async () => {
    const items = [
      // two credential-store Secrets claim geminiApiKey → conflict
      {
        metadata: {
          name: "alpha",
          labels: { "rigel.assistant/credential-store": "true" },
          annotations: { "rigel.assistant/credential.geminiApiKey": "k" },
        },
        data: { k: b64("gemini-conflict-value") },
      },
      {
        metadata: {
          name: "zebra",
          labels: { "rigel.assistant/credential-store": "true" },
          annotations: { "rigel.assistant/credential.geminiApiKey": "k" },
        },
        data: { k: b64("other-gemini-value") },
      },
      // a legacy un-annotated default Secret → needsReconcile
      {
        metadata: { name: "rigel-assistant-credentials" },
        data: { codexApiKey: b64("codex-value") },
      },
    ];
    const res = await credentialStatus(null, "default", fakeKubectl(items));
    const parsed = JSON.parse(res.stdout) as {
      credentials: Record<string, { ready: boolean; secretName: string }>;
      conflicts: string[];
      needsReconcile: boolean;
    };
    expect(parsed.conflicts).toEqual(["geminiApiKey"]);
    expect(parsed.needsReconcile).toBe(true);
    // No secret VALUES (or their base64) anywhere.
    for (const leak of ["gemini-conflict-value", "other-gemini-value", "codex-value"]) {
      expect(res.stdout).not.toContain(leak);
      expect(res.stdout).not.toContain(b64(leak));
    }
  });

  test("a fully-annotated install reports no conflicts and needsReconcile: false", async () => {
    const items = [
      {
        metadata: {
          name: "rigel-assistant-credentials",
          labels: { "rigel.assistant/credential-store": "true" },
          annotations: { "rigel.assistant/credential.codexApiKey": "codexApiKey" },
        },
        data: { codexApiKey: b64("v") },
      },
    ];
    const res = await credentialStatus(null, "default", fakeKubectl(items));
    const parsed = JSON.parse(res.stdout) as { conflicts: string[]; needsReconcile: boolean };
    expect(parsed.conflicts).toEqual([]);
    expect(parsed.needsReconcile).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconcileCredentialAnnotations (Phase 3 / Task A2)
// ---------------------------------------------------------------------------

import { reconcileCredentialAnnotations } from "./assistant";

describe("reconcileCredentialAnnotations", () => {
  test("lists managed Secrets, stamps fallback ids (metadata only), returns { stamped }", async () => {
    // A legacy install: default credentials Secret with two fallback ids, plus the
    // legacy token Secret — none annotated yet.
    const managed = [
      {
        metadata: { name: "rigel-assistant-credentials" },
        data: { codexApiKey: b64("codex-DO-NOT-LEAK"), geminiApiKey: b64("gemini-DO-NOT-LEAK") },
      },
      { metadata: { name: "rigel-assistant-token" }, data: { token: b64("token-DO-NOT-LEAK") } },
    ];
    const { run, calls } = scriptedKubectl([
      { match: (a) => a[0] === "get" && a[1] === "secrets" && a.includes("-l"), result: okJSON({ items: managed }) },
      { match: (a) => a[0] === "label", result: ok() },
      { match: (a) => a[0] === "annotate", result: ok() },
    ]);
    const res = await reconcileCredentialAnnotations(null, "default", run);
    const parsed = JSON.parse(res.stdout) as { stamped: number };
    // 3 ids stamped (codexApiKey + geminiApiKey + claudeToken).
    expect(parsed.stamped).toBe(3);

    const verbs = new Set(calls.map((c) => c[0]));
    // Metadata ONLY: never an apply / rollout / restart / patch / delete.
    for (const forbidden of ["apply", "rollout", "restart", "patch", "delete"]) {
      expect(verbs.has(forbidden)).toBe(false);
    }
    expect(verbs.has("label")).toBe(true);
    expect(verbs.has("annotate")).toBe(true);

    // No secret VALUE (or its base64) anywhere in the calls or output.
    const haystack = JSON.stringify(calls) + res.stdout + res.stderr;
    for (const leak of ["codex-DO-NOT-LEAK", "gemini-DO-NOT-LEAK", "token-DO-NOT-LEAK"]) {
      expect(haystack).not.toContain(leak);
      expect(haystack).not.toContain(b64(leak));
    }
  });

  test("idempotent: an already-annotated install runs no mutations and reports { stamped: 0 }", async () => {
    const managed = [
      {
        metadata: {
          name: "rigel-assistant-credentials",
          labels: { "rigel.assistant/credential-store": "true" },
          annotations: { "rigel.assistant/credential.codexApiKey": "codexApiKey" },
        },
        data: { codexApiKey: b64("v") },
      },
    ];
    const { run, calls } = scriptedKubectl([
      { match: (a) => a[0] === "get" && a[1] === "secrets" && a.includes("-l"), result: okJSON({ items: managed }) },
    ]);
    const res = await reconcileCredentialAnnotations(null, "default", run);
    expect((JSON.parse(res.stdout) as { stamped: number }).stamped).toBe(0);
    // Only the list call ran; no label/annotate.
    expect(calls.every((c) => c[0] === "get")).toBe(true);
  });

  test("conflict-safe: an annotation-claimed id is never re-stamped from the legacy default", async () => {
    const managed = [
      {
        metadata: {
          name: "byo-anthropic",
          labels: { "rigel.assistant/credential-store": "true" },
          annotations: { "rigel.assistant/credential.anthropicApiKey": "api-key" },
        },
        data: { "api-key": b64("v") },
      },
      // legacy default also carries anthropicApiKey by default key — must NOT be stamped.
      { metadata: { name: "rigel-assistant-credentials" }, data: { anthropicApiKey: b64("legacy") } },
    ];
    const { run, calls } = scriptedKubectl([
      { match: (a) => a[0] === "get" && a[1] === "secrets" && a.includes("-l"), result: okJSON({ items: managed }) },
    ]);
    const res = await reconcileCredentialAnnotations(null, "default", run);
    expect((JSON.parse(res.stdout) as { stamped: number }).stamped).toBe(0);
    expect(calls.some((c) => c[0] === "label" || c[0] === "annotate")).toBe(false);
  });

  test("propagates a kubectl failure (ensureOk) instead of silently succeeding", async () => {
    const managed = [{ metadata: { name: "rigel-assistant-credentials" }, data: { codexApiKey: b64("v") } }];
    const { run } = scriptedKubectl([
      { match: (a) => a[0] === "get" && a[1] === "secrets" && a.includes("-l"), result: okJSON({ items: managed }) },
      { match: (a) => a[0] === "label", result: { code: 1, stdout: "", stderr: "forbidden" } },
    ]);
    await expect(reconcileCredentialAnnotations(null, "default", run)).rejects.toThrow(/forbidden|reconcile/i);
  });
});

// ---------------------------------------------------------------------------
// listCredentialSecrets — names + key NAMES only, noise Secrets filtered (A4)
// ---------------------------------------------------------------------------

import { listCredentialSecrets } from "./assistant";

describe("listCredentialSecrets", () => {
  test("returns name/type/key-names only, filtering SA-token + helm release Secrets", async () => {
    const items = [
      {
        metadata: { name: "my-anthropic" },
        type: "Opaque",
        data: { "api-key": b64("super-secret"), other: b64("also-secret") },
      },
      { metadata: { name: "default-token-abc" }, type: "kubernetes.io/service-account-token", data: { token: b64("t") } },
      { metadata: { name: "sh.helm.release.v1.foo.v1" }, type: "helm.sh/release.v1", data: { release: b64("r") } },
    ];
    const res = await listCredentialSecrets(null, "default", fakeKubectl(items));
    const parsed = JSON.parse(res.stdout) as {
      secrets: { name: string; type: string; keys: string[] }[];
    };
    expect(parsed.secrets).toEqual([
      { name: "my-anthropic", type: "Opaque", keys: ["api-key", "other"] },
    ]);
    // Names of filtered Secrets and ALL values are absent.
    expect(res.stdout).not.toContain("default-token-abc");
    expect(res.stdout).not.toContain("sh.helm.release");
    expect(res.stdout).not.toContain("super-secret");
    expect(res.stdout).not.toContain(b64("super-secret"));
    expect(res.stdout).not.toContain(b64("also-secret"));
  });

  test("gets secrets in the requested namespace (no label selector)", async () => {
    const calls: string[][] = [];
    const spy: (ctx: string | null, args: string[]) => Promise<RunResult> = async (_ctx, args) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    };
    await listCredentialSecrets(null, "agents", spy);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["get", "secrets", "-n", "agents", "-o", "json"]);
  });
});

// ---------------------------------------------------------------------------
// setCredentialSource / clearCredentialSource (BYO, Phase 2 / Task A3)
// ---------------------------------------------------------------------------

import { setCredentialSource, clearCredentialSource, assertNoForeignDeployment, type AssistantRequest as Req } from "./assistant";

/** A scripted fake kubectl: matches each call by a substring of the joined argv
 *  and returns the queued response, recording every call for sequence asserts. */
function scriptedKubectl(
  responses: Array<{ match: (args: string[]) => boolean; result: RunResult }>,
): { run: (ctx: string | null, args: string[]) => Promise<RunResult>; calls: string[][] } {
  const calls: string[][] = [];
  const run = async (_ctx: string | null, args: string[]): Promise<RunResult> => {
    calls.push(args);
    const hit = responses.find((r) => r.match(args));
    if (!hit) return { code: 1, stdout: "", stderr: `no scripted response for ${args.join(" ")}` };
    return hit.result;
  };
  return { run, calls };
}

const okJSON = (obj: unknown): RunResult => ({ code: 0, stdout: JSON.stringify(obj), stderr: "" });
const ok = (): RunResult => ({ code: 0, stdout: "", stderr: "" });

describe("setCredentialSource", () => {
  const VALUE_THAT_MUST_NOT_LEAK = "operator-anthropic-key-DO-NOT-LEAK";

  test("validates (keys only), runs label/annotate, then patches ONLY the credential env var", async () => {
    // Validation read sees the raw operator Secret (no rigel labels yet).
    const chosenSecret = {
      metadata: { name: "ops-anthropic" },
      type: "Opaque",
      data: { "api-key": b64(VALUE_THAT_MUST_NOT_LEAK) },
    };
    const { run, calls } = scriptedKubectl([
      // 1. validation read: get secret ops-anthropic
      { match: (a) => a[0] === "get" && a[1] === "secret" && a[2] === "ops-anthropic", result: okJSON(chosenSecret) },
      // 2. list managed secrets (sibling computation) — no other claimant here
      {
        match: (a) => a[0] === "get" && a[1] === "secrets" && a.includes("-l"),
        result: okJSON({ items: [{ metadata: { name: "rigel-assistant-credentials" }, data: {} }] }),
      },
      // 3. label + annotate the chosen secret
      { match: (a) => a[0] === "label", result: ok() },
      { match: (a) => a[0] === "annotate", result: ok() },
      // 4. patch ONLY this credential's env var
      { match: (a) => a[0] === "patch", result: ok() },
    ]);

    const req: Req = {
      action: "setCredentialSource",
      namespace: "default",
      credentialId: "anthropicApiKey",
      secretName: "ops-anthropic",
      dataKey: "api-key",
    };
    const res = await setCredentialSource(null, "default", req, run);
    expect(res.code).toBe(0);

    // Call sequence: validate get → list → label → annotate → patch (last).
    const verbs = calls.map((c) => `${c[0]} ${c[1] ?? ""}`.trim());
    expect(verbs[0]).toBe("get secret");
    expect(verbs).toContain("label secret");
    expect(verbs).toContain("annotate secret");
    expect(verbs[verbs.length - 1]).toBe("patch deployment");

    // The patch repoints ONLY ANTHROPIC_API_KEY (env merges by name) at the chosen
    // Secret/key — it carries no image/model fields, so a repoint never resets config.
    const patchCall = calls.find((c) => c[0] === "patch")!;
    const patchJson = patchCall[patchCall.indexOf("-p") + 1];
    const patch = JSON.parse(patchJson);
    expect(patch.spec.template.spec.containers[0].name).toBe("agent");
    expect(patch.spec.template.spec.containers[0].env).toEqual([
      { name: "ANTHROPIC_API_KEY", valueFrom: { secretKeyRef: { name: "ops-anthropic", key: "api-key", optional: true } } },
    ]);
    expect(patchJson).not.toContain("image");
    expect(patchJson).not.toContain("WORKER_MODEL");

    // No secret VALUE (or its base64) appears anywhere.
    for (const out of [patchJson, res.stdout, res.stderr]) {
      expect(out).not.toContain(VALUE_THAT_MUST_NOT_LEAK);
      expect(out).not.toContain(b64(VALUE_THAT_MUST_NOT_LEAK));
    }
  });

  test("removes a sibling Secret's claim before repointing (single owner)", async () => {
    // Another credential-store Secret already claims anthropicApiKey → it must be
    // un-annotated so exactly one Secret owns the credential.
    const sibling = {
      metadata: {
        name: "old-claimant",
        labels: { "rigel.assistant/credential-store": "true" },
        annotations: { "rigel.assistant/credential.anthropicApiKey": "key" },
      },
      data: { key: b64("x") },
    };
    const chosen = { metadata: { name: "ops-anthropic" }, type: "Opaque", data: { "api-key": b64("y") } };
    const { run, calls } = scriptedKubectl([
      { match: (a) => a[0] === "get" && a[1] === "secret" && a[2] === "ops-anthropic", result: okJSON(chosen) },
      { match: (a) => a[0] === "get" && a[1] === "secrets" && a.includes("-l"), result: okJSON({ items: [sibling] }) },
      { match: (a) => a[0] === "label", result: ok() },
      { match: (a) => a[0] === "annotate", result: ok() },
      { match: (a) => a[0] === "patch", result: ok() },
    ]);
    const req: Req = {
      action: "setCredentialSource",
      namespace: "default",
      credentialId: "anthropicApiKey",
      secretName: "ops-anthropic",
      dataKey: "api-key",
    };
    await setCredentialSource(null, "default", req, run);
    // A removal annotate (trailing '-') targets the sibling, not the chosen Secret.
    const removals = calls.filter(
      (c) => c[0] === "annotate" && c.includes("rigel.assistant/credential.anthropicApiKey-"),
    );
    expect(removals.some((c) => c.includes("old-claimant"))).toBe(true);
  });

  test("a missing Secret fails with no mutation, no patch", async () => {
    const { run, calls } = scriptedKubectl([
      { match: (a) => a[0] === "get" && a[1] === "secret", result: { code: 1, stdout: "", stderr: "NotFound" } },
    ]);
    const req: Req = {
      action: "setCredentialSource",
      namespace: "default",
      credentialId: "anthropicApiKey",
      secretName: "missing",
      dataKey: "api-key",
    };
    await expect(setCredentialSource(null, "default", req, run)).rejects.toThrow(/not found/);
    expect(calls.some((c) => c[0] === "label" || c[0] === "annotate" || c[0] === "patch")).toBe(false);
  });

  test("a present Secret missing the chosen key fails with no mutation", async () => {
    const chosenSecret = { metadata: { name: "ops" }, type: "Opaque", data: { "other-key": b64("x") } };
    const { run, calls } = scriptedKubectl([
      { match: (a) => a[0] === "get" && a[1] === "secret", result: okJSON(chosenSecret) },
    ]);
    const req: Req = {
      action: "setCredentialSource",
      namespace: "default",
      credentialId: "anthropicApiKey",
      secretName: "ops",
      dataKey: "api-key",
    };
    await expect(setCredentialSource(null, "default", req, run)).rejects.toThrow(/no key/);
    expect(calls.some((c) => c[0] === "label" || c[0] === "annotate")).toBe(false);
  });

  test("requires credentialId / secretName / dataKey", async () => {
    const noop = async (): Promise<RunResult> => ok();
    await expect(
      setCredentialSource(null, "default", { action: "setCredentialSource", secretName: "s", dataKey: "k" }, noop),
    ).rejects.toThrow(/credentialId/);
  });
});

describe("clearCredentialSource", () => {
  test("removes the BYO claim and patches the env back to the managed default", async () => {
    const byoBefore = {
      metadata: {
        name: "byo-source",
        labels: { "rigel.assistant/credential-store": "true" },
        annotations: { "rigel.assistant/credential.anthropicApiKey": "api-key" },
      },
      data: { "api-key": b64("byo-secret-value") },
    };
    const managed = {
      metadata: {
        name: "rigel-assistant-credentials",
        labels: { "rigel.assistant/credential-store": "true" },
      },
      data: { anthropicApiKey: b64("managed-value") },
    };
    const { run, calls } = scriptedKubectl([
      { match: (a) => a[0] === "get" && a[1] === "secrets", result: okJSON({ items: [byoBefore, managed] }) },
      { match: (a) => a[0] === "annotate", result: ok() },
      { match: (a) => a[0] === "patch", result: ok() },
    ]);
    const req: Req = { action: "clearCredentialSource", namespace: "default", credentialId: "anthropicApiKey" };
    const res = await clearCredentialSource(null, "default", req, run);
    expect(res.code).toBe(0);

    // The BYO source's annotation is removed; the managed default is left alone.
    const annotateCalls = calls.filter((c) => c[0] === "annotate");
    expect(annotateCalls).toEqual([
      ["annotate", "secret", "byo-source", "rigel.assistant/credential.anthropicApiKey-", "-n", "default"],
    ]);
    // The patch points the env back at the managed default Secret/key.
    const patchCall = calls.find((c) => c[0] === "patch")!;
    const patch = JSON.parse(patchCall[patchCall.indexOf("-p") + 1]);
    expect(patch.spec.template.spec.containers[0].env).toEqual([
      { name: "ANTHROPIC_API_KEY", valueFrom: { secretKeyRef: { name: "rigel-assistant-credentials", key: "anthropicApiKey", optional: true } } },
    ]);
    expect(calls[calls.length - 1][0]).toBe("patch");
    // No values leak.
    for (const out of [JSON.stringify(calls), res.stdout]) {
      expect(out).not.toContain("byo-secret-value");
      expect(out).not.toContain("managed-value");
    }
  });

  test("requires a credentialId", async () => {
    const noop = async (): Promise<RunResult> => ok();
    await expect(
      clearCredentialSource(null, "default", { action: "clearCredentialSource" }, noop),
    ).rejects.toThrow(/credentialId/);
  });
});

describe("assertNoForeignDeployment (install ownership guard)", () => {
  test("no Deployment (not found) → allowed", async () => {
    const run = async (): Promise<RunResult> => ({ code: 1, stdout: "", stderr: "NotFound" });
    await expect(assertNoForeignDeployment(null, "default", run)).resolves.toBeUndefined();
  });

  test("OUR Deployment (managed-by label) → allowed (re-install)", async () => {
    const run = async (): Promise<RunResult> =>
      okJSON({ metadata: { name: "rigel-assistant", labels: { "app.kubernetes.io/managed-by": "rigel-assistant" } } });
    await expect(assertNoForeignDeployment(null, "default", run)).resolves.toBeUndefined();
  });

  test("a FOREIGN same-named Deployment → refused (no silent adopt)", async () => {
    const run = async (): Promise<RunResult> =>
      okJSON({ metadata: { name: "rigel-assistant", labels: { app: "something-else" } } });
    await expect(assertNoForeignDeployment(null, "default", run)).rejects.toThrow(/isn't managed by Rigel/);
  });

  test("unparseable response → inconclusive, not blocked", async () => {
    const run = async (): Promise<RunResult> => ({ code: 0, stdout: "not json", stderr: "" });
    await expect(assertNoForeignDeployment(null, "default", run)).resolves.toBeUndefined();
  });
});

import { setMatrixUpdates, setMatrixSecret } from "./assistant";

test("setMatrixUpdates maps only the provided matrix fields", () => {
  expect(
    setMatrixUpdates({
      action: "setMatrix",
      matrixHomeserverUrl: "https://hs",
      matrixUserId: "@rigel:hs",
      matrixRoomId: "!r:hs",
      matrixAllowedSenders: "@me:hs",
    }),
  ).toEqual({
    matrixHomeserverUrl: "https://hs",
    matrixUserId: "@rigel:hs",
    matrixRoomId: "!r:hs",
    matrixAllowedSenders: "@me:hs",
  });
  expect(setMatrixUpdates({ action: "setMatrix" })).toEqual({});
});

test("setMatrixSecret returns the token Secret YAML only when a token is supplied", () => {
  const yaml = setMatrixSecret({ action: "setMatrix", matrixAccessToken: "tok" }, "agents");
  expect(yaml).not.toBeNull();
  expect(yaml).toContain("name: rigel-matrix-token");
  expect(yaml).toContain('accessToken: "tok"');
  expect(setMatrixSecret({ action: "setMatrix" }, "agents")).toBeNull();
  expect(setMatrixSecret({ action: "setMatrix", matrixAccessToken: "   " }, "agents")).toBeNull();
});

// ---------------------------------------------------------------------------
// setChannelUpdates (generic Discord/Slack connect/disconnect + notify toggle)
// ---------------------------------------------------------------------------

import { setChannelUpdates } from "./assistant";

test("setChannelUpdates connect writes only the target channel's keys, dropping foreign keys", () => {
  expect(
    setChannelUpdates(
      {
        action: "setChannel",
        channel: "discord",
        channelData: { discordWebhookUrl: "https://discord/x", slackWebhookUrl: "https://slack/y", foo: "bar" },
      },
      {},
    ),
  ).toEqual({ discordWebhookUrl: "https://discord/x" });
});

test("setChannelUpdates disconnect writes the empty value", () => {
  expect(
    setChannelUpdates({ action: "setChannel", channel: "discord", channelData: { discordWebhookUrl: "" } }, {}),
  ).toEqual({ discordWebhookUrl: "" });
});

test("setChannelUpdates channelNotify toggles the allowlist, materializing on first write", () => {
  const existingData = { discordWebhookUrl: "https://discord/x", slackWebhookUrl: "https://slack/y" };
  expect(
    setChannelUpdates({ action: "setChannel", channel: "slack", channelNotify: false }, existingData),
  ).toEqual({ notifyChannels: "discord" });
  expect(
    setChannelUpdates({ action: "setChannel", channel: "discord", channelNotify: true }, existingData),
  ).toEqual({ notifyChannels: "discord,slack" });
});

test("setChannelUpdates throws on a missing or invalid channel", () => {
  expect(() => setChannelUpdates({ action: "setChannel" }, {})).toThrow("setChannel requires a valid channel");
  expect(() =>
    setChannelUpdates({ action: "setChannel", channel: "carrier-pigeon" as never }, {}),
  ).toThrow("setChannel requires a valid channel");
});

test("setChannelUpdates rejects a config write for signal/matrix (use setSignal/setMatrix)", () => {
  expect(() =>
    setChannelUpdates({ action: "setChannel", channel: "matrix", channelData: { matrixRoomId: "!r:hs" } }, {}),
  ).toThrow("setChannel cannot write config for signal/matrix");
  expect(() =>
    setChannelUpdates({ action: "setChannel", channel: "signal", channelData: { signalNumber: "+1" } }, {}),
  ).toThrow("setChannel cannot write config for signal/matrix");
});

test("setChannelUpdates allows the notify toggle for signal/matrix (no config data)", () => {
  const existingData = { signalNumber: "+1", discordWebhookUrl: "https://discord/x" };
  expect(
    setChannelUpdates({ action: "setChannel", channel: "signal", channelNotify: true }, existingData),
  ).toEqual({ notifyChannels: "signal,discord" });
});

test("setChannelUpdates omits notifyChannels when channelNotify is undefined", () => {
  expect(
    setChannelUpdates(
      { action: "setChannel", channel: "discord", channelData: { discordWebhookUrl: "https://discord/x" } },
      {},
    ),
  ).toEqual({ discordWebhookUrl: "https://discord/x" });
});

// ---------------------------------------------------------------------------
// mutateDigests / digestRunNowUpdate (scheduled digests, Phase 7 / Task 13)
// ---------------------------------------------------------------------------

import { mutateDigests, digestRunNowUpdate, mutateAlerts } from "./assistant";
import * as runMod from "@rigel/k8s/src/run";

describe("mutateDigests", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test("adds a digest without clobbering other config keys", async () => {
    const existingData = { alertRules: '["some-rule"]', digests: "[]" };
    let appliedStdin = "";
    vi.spyOn(runMod, "kubectl").mockResolvedValue({
      code: 0, stdout: JSON.stringify({ data: existingData }), stderr: "",
    });
    vi.spyOn(runMod, "runProcessWithStdin").mockImplementation(async (_prog, _args, stdin) => {
      appliedStdin = stdin as string;
      return { code: 0, stdout: "", stderr: "" };
    });
    await mutateDigests(null, "default", {
      action: "saveDigest",
      digest: {
        label: "Morning", channel: "signal", days: [1, 2, 3, 4, 5],
        time: "07:00", timezone: "UTC", lookback: { mode: "sinceLast" },
      },
    });
    const cm = JSON.parse(appliedStdin) as { data: Record<string, string> };
    expect(cm.data.alertRules).toBe('["some-rule"]'); // unchanged
    const digests = JSON.parse(cm.data.digests) as unknown[];
    expect(digests).toHaveLength(1);
    expect((digests[0] as { label: string }).label).toBe("Morning");
    expect(typeof (digests[0] as { id: string }).id).toBe("string");
  });

  test("saveDigest WITH digestId updates in place: same id, same createdAt, no extra entry", async () => {
    const existingCreatedAt = "2026-01-01T00:00:00.000Z";
    const existingDigests = JSON.stringify([{
      id: "existing-id", enabled: true, label: "Old label", channel: "signal",
      days: [1], time: "07:00", timezone: "UTC", lookback: { mode: "sinceLast" },
      createdAt: existingCreatedAt,
    }]);
    const existingData = { digests: existingDigests };
    let appliedStdin = "";
    vi.spyOn(runMod, "kubectl").mockResolvedValue({
      code: 0, stdout: JSON.stringify({ data: existingData }), stderr: "",
    });
    vi.spyOn(runMod, "runProcessWithStdin").mockImplementation(async (_prog, _args, stdin) => {
      appliedStdin = stdin as string;
      return { code: 0, stdout: "", stderr: "" };
    });
    await mutateDigests(null, "default", {
      action: "saveDigest",
      digestId: "existing-id",
      digest: {
        label: "Updated label", channel: "signal", days: [1, 2, 3, 4, 5],
        time: "08:00", timezone: "UTC", lookback: { mode: "sinceLast" }, enabled: false,
      },
    });
    const cm = JSON.parse(appliedStdin) as { data: Record<string, string> };
    const digests = JSON.parse(cm.data.digests) as { id: string; label: string; createdAt: string; enabled: boolean; time: string }[];
    // Only one entry (no extra entry added).
    expect(digests).toHaveLength(1);
    // Same id preserved.
    expect(digests[0].id).toBe("existing-id");
    // createdAt preserved from the original.
    expect(digests[0].createdAt).toBe(existingCreatedAt);
    // Updated fields applied.
    expect(digests[0].label).toBe("Updated label");
    expect(digests[0].time).toBe("08:00");
    expect(digests[0].enabled).toBe(false);
  });

  test("sendDigestNow writes a fresh digestRunNow token", () => {
    const before = Date.now();
    const up = digestRunNowUpdate({ action: "sendDigestNow", digestId: "a", digestMode: "preview" });
    const parsed = JSON.parse(up.digestRunNow) as { id: string; mode: string; token: string; at: number };
    expect(parsed.id).toBe("a");
    expect(parsed.mode).toBe("preview");
    expect(typeof parsed.token).toBe("string");
    expect(typeof parsed.at).toBe("number");
    expect(parsed.at).toBeGreaterThanOrEqual(before);
  });
});

describe("mutateAlerts", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test("saveAlert without alertId appends a fresh rule with a generated id", async () => {
    const existing = JSON.stringify([{
      id: "rule-1", enabled: true, text: "old rule",
      target: { scope: "cluster" }, condition: { type: "oomKilled" }, cooldownMinutes: 5, createdAt: "",
    }]);
    let appliedStdin = "";
    vi.spyOn(runMod, "kubectl").mockResolvedValue({
      code: 0, stdout: JSON.stringify({ data: { alertRules: existing } }), stderr: "",
    });
    vi.spyOn(runMod, "runProcessWithStdin").mockImplementation(async (_p, _a, stdin) => {
      appliedStdin = stdin as string;
      return { code: 0, stdout: "", stderr: "" };
    });
    await mutateAlerts(null, "default", {
      action: "saveAlert",
      alert: { label: "Alert: new", text: "new rule", target: { scope: "cluster" }, condition: { type: "crashLoop" } },
    });
    const cm = JSON.parse(appliedStdin) as { data: Record<string, string> };
    const rules = JSON.parse(cm.data.alertRules) as { id: string; text: string }[];
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.id)).toContain("rule-1");
    const added = rules.find((r) => r.text === "new rule")!;
    expect(added.id).not.toBe("rule-1");
    expect(typeof added.id).toBe("string");
  });

  test("saveAlert WITH alertId replaces in place: same id, updated fields, no extra entry", async () => {
    const existing = JSON.stringify([{
      id: "rule-1", enabled: true, text: "old text",
      target: { scope: "cluster" }, condition: { type: "oomKilled" }, cooldownMinutes: 5, createdAt: "2026-01-01T00:00:00.000Z",
    }]);
    let appliedStdin = "";
    vi.spyOn(runMod, "kubectl").mockResolvedValue({
      code: 0, stdout: JSON.stringify({ data: { alertRules: existing } }), stderr: "",
    });
    vi.spyOn(runMod, "runProcessWithStdin").mockImplementation(async (_p, _a, stdin) => {
      appliedStdin = stdin as string;
      return { code: 0, stdout: "", stderr: "" };
    });
    await mutateAlerts(null, "default", {
      action: "saveAlert",
      alertId: "rule-1",
      alert: {
        label: "Alert: updated", text: "updated text",
        target: { scope: "namespace", namespace: "prod" }, condition: { type: "crashLoop" },
      },
    });
    const cm = JSON.parse(appliedStdin) as { data: Record<string, string> };
    const rules = JSON.parse(cm.data.alertRules) as {
      id: string; text: string; target: { scope: string; namespace?: string }; condition: { type: string };
    }[];
    // No extra entry — the rule was replaced, not appended.
    expect(rules).toHaveLength(1);
    // Same id preserved (keeps the agent's per-rule fire history/cooldown attached).
    expect(rules[0].id).toBe("rule-1");
    // Updated fields applied.
    expect(rules[0].text).toBe("updated text");
    expect(rules[0].target.scope).toBe("namespace");
    expect(rules[0].condition.type).toBe("crashLoop");
  });
});

// ---------------------------------------------------------------------------
// getRbac / setRbac (in-app RBAC editor, Phase 2)
// ---------------------------------------------------------------------------

import { rbacConfigUpdate, getRbac, setRbac, discoverInstalledContexts, handleAssistant } from "./assistant";
import { DEFAULT_POLICY, setCapability, serializePolicy, parsePolicy } from "@rigel/k8s";

test("rbacConfigUpdate serializes the policy under rbacPolicy", () => {
  const p = setCapability(DEFAULT_POLICY, "drain", true);
  const upd = rbacConfigUpdate(p);
  expect(parsePolicy(upd.rbacPolicy).cells).toEqual(p.cells);
});

describe("discoverInstalledContexts", () => {
  test("keeps only contexts holding an assistant-managed Deployment", async () => {
    const run = async (ctx: string | null, args: string[]) => {
      if (args[0] === "config") {
        return {
          code: 0,
          stdout: JSON.stringify({
            "current-context": "ctx-a",
            contexts: [{ name: "ctx-a", context: { cluster: "a" } }, { name: "ctx-b", context: { cluster: "b" } }],
            clusters: [{ name: "a", cluster: { server: "https://a" } }, { name: "b", cluster: { server: "https://b" } }],
          }),
          stderr: "",
        };
      }
      if (ctx === "ctx-a") {
        return {
          code: 0,
          stdout: JSON.stringify({ metadata: { labels: { "app.kubernetes.io/managed-by": "rigel-assistant" } } }),
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: "not found" };
    };
    const installed = await discoverInstalledContexts("default", run);
    expect(installed).toEqual(["ctx-a"]);
  });
});

describe("getRbac", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test("returns DEFAULT_POLICY when assistant-config has no rbacPolicy key", async () => {
    vi.spyOn(runMod, "kubectl").mockImplementation(async (_ctx, args) => {
      if (args[0] === "get" && args[1] === "cm") {
        return { code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "not found" };
    });
    const res = await getRbac(null, "default");
    const parsed = JSON.parse(res.stdout) as { policy: string; appliedRules: unknown };
    expect(parsePolicy(parsed.policy).cells).toEqual(DEFAULT_POLICY.cells);
    expect(parsed.appliedRules).toBeNull();
  });

  test("returns the stored policy when rbacPolicy is present", async () => {
    const stored = setCapability(DEFAULT_POLICY, "drain", true);
    vi.spyOn(runMod, "kubectl").mockImplementation(async (_ctx, args) => {
      if (args[0] === "get" && args[1] === "cm") {
        return { code: 0, stdout: JSON.stringify({ data: { rbacPolicy: serializePolicy(stored) } }), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "not found" };
    });
    const res = await getRbac(null, "default");
    const parsed = JSON.parse(res.stdout) as { policy: string };
    expect(parsePolicy(parsed.policy).cells).toEqual(stored.cells);
  });
});

describe("setRbac", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test("persists + applies the ClusterRole to a single explicit context", async () => {
    const applied: { args: string[]; stdin: unknown }[] = [];
    vi.spyOn(runMod, "kubectl").mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" });
    vi.spyOn(runMod, "runProcessWithStdin").mockImplementation(async (_prog, args, stdin) => {
      applied.push({ args, stdin });
      return { code: 0, stdout: "", stderr: "" };
    });
    const policy = setCapability(DEFAULT_POLICY, "drain", true);
    const res = await setRbac("active-ctx", "default", {
      action: "setRbac", policy: serializePolicy(policy), contexts: ["active-ctx"],
    });
    const result = JSON.parse(res.stdout) as { applied: string[]; failures: unknown[] };
    expect(result.applied).toEqual(["active-ctx"]);
    expect(result.failures).toEqual([]);
    expect(applied[0]!.stdin).toContain("rbacPolicy");
    expect(applied[1]!.stdin).toMatch(/kind: ClusterRole\b/);
    expect(applied[1]!.stdin).not.toMatch(/kind: ClusterRoleBinding/);
    expect(applied[1]!.stdin).toMatch(/pods\/eviction/);
  });

  test("omitted contexts falls back to the active context alone", async () => {
    const clusterRoleContexts: string[] = [];
    vi.spyOn(runMod, "kubectl").mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" });
    vi.spyOn(runMod, "runProcessWithStdin").mockImplementation(async (_prog, fullArgs, stdin) => {
      if (/kind: ClusterRole\b/.test(String(stdin)) && !/ClusterRoleBinding/.test(String(stdin))) {
        clusterRoleContexts.push(fullArgs.includes("--context") ? fullArgs[fullArgs.indexOf("--context") + 1]! : "");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const res = await setRbac("active-ctx", "default", {
      action: "setRbac", policy: serializePolicy(DEFAULT_POLICY),
    });
    const result = JSON.parse(res.stdout) as { applied: string[] };
    expect(result.applied).toEqual(["active-ctx"]);
    expect(clusterRoleContexts).toEqual(["active-ctx"]);
  });

  test("empty contexts array falls back to the active context alone", async () => {
    vi.spyOn(runMod, "kubectl").mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" });
    vi.spyOn(runMod, "runProcessWithStdin").mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const res = await setRbac("active-ctx", "default", {
      action: "setRbac", policy: serializePolicy(DEFAULT_POLICY), contexts: [],
    });
    const result = JSON.parse(res.stdout) as { applied: string[] };
    expect(result.applied).toEqual(["active-ctx"]);
  });

  test("de-duplicates caller-supplied contexts", async () => {
    const clusterRoleApplies: string[] = [];
    vi.spyOn(runMod, "kubectl").mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" });
    vi.spyOn(runMod, "runProcessWithStdin").mockImplementation(async (_prog, _args, stdin) => {
      const s = String(stdin);
      if (/kind: ClusterRole\b/.test(s) && !/ClusterRoleBinding/.test(s)) clusterRoleApplies.push(s);
      return { code: 0, stdout: "", stderr: "" };
    });
    const res = await setRbac("ctx-a", "default", {
      action: "setRbac", policy: serializePolicy(DEFAULT_POLICY), contexts: ["ctx-a", "ctx-a", "ctx-b"],
    });
    const result = JSON.parse(res.stdout) as { applied: string[] };
    expect(result.applied).toEqual(["ctx-a", "ctx-b"]);
    expect(clusterRoleApplies).toHaveLength(2);
  });

  test("writes config AND applies the ClusterRole to EVERY passed context", async () => {
    const configWrites: string[] = [];
    const clusterRoleApplies: string[] = [];
    vi.spyOn(runMod, "kubectl").mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" });
    vi.spyOn(runMod, "runProcessWithStdin").mockImplementation(async (_prog, _args, stdin) => {
      const s = String(stdin);
      if (s.includes("rbacPolicy")) configWrites.push(s);
      if (/kind: ClusterRole\b/.test(s) && !/ClusterRoleBinding/.test(s)) clusterRoleApplies.push(s);
      return { code: 0, stdout: "", stderr: "" };
    });
    const res = await setRbac("ctx-a", "default", {
      action: "setRbac", policy: serializePolicy(DEFAULT_POLICY), contexts: ["ctx-a", "ctx-b"],
    });
    const result = JSON.parse(res.stdout) as { applied: string[] };
    expect(result.applied.sort()).toEqual(["ctx-a", "ctx-b"]);
    expect(configWrites).toHaveLength(2);
    expect(clusterRoleApplies).toHaveLength(2);
  });

  test("one context failing does not abort the others; names the failure", async () => {
    vi.spyOn(runMod, "kubectl").mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" });
    vi.spyOn(runMod, "runProcessWithStdin").mockImplementation(async (_prog, fullArgs, stdin) => {
      if (/kind: ClusterRole\b/.test(String(stdin)) && fullArgs.includes("ctx-b")) {
        return { code: 1, stdout: "", stderr: "Forbidden" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const res = await setRbac("ctx-a", "default", {
      action: "setRbac", policy: serializePolicy(DEFAULT_POLICY), contexts: ["ctx-a", "ctx-b"],
    });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("ctx-b");
    expect(res.stderr).toContain("Forbidden");
    const result = JSON.parse(res.stdout) as { applied: string[]; failures: { context: string; error: string }[] };
    expect(result.applied).toEqual(["ctx-a"]);
    expect(result.failures).toEqual([{ context: "ctx-b", error: "Forbidden" }]);
  });

  test("a thrown config-write failure is caught per context; others still succeed", async () => {
    vi.spyOn(runMod, "kubectl").mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" });
    vi.spyOn(runMod, "runProcessWithStdin").mockImplementation(async (_prog, fullArgs, stdin) => {
      if (String(stdin).includes("rbacPolicy") && fullArgs.includes("ctx-b")) {
        return { code: 1, stdout: "", stderr: "config apply denied" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const res = await setRbac("ctx-a", "default", {
      action: "setRbac", policy: serializePolicy(DEFAULT_POLICY), contexts: ["ctx-a", "ctx-b"],
    });
    expect(res.code).not.toBe(0);
    const result = JSON.parse(res.stdout) as { applied: string[]; failures: { context: string; error: string }[] };
    expect(result.applied).toEqual(["ctx-a"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.context).toBe("ctx-b");
    expect(result.failures[0]!.error).toContain("config apply denied");
  });

  test("the stored config is persisted even when that context's ClusterRole apply fails", async () => {
    const configWrites: string[] = [];
    vi.spyOn(runMod, "kubectl").mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" });
    vi.spyOn(runMod, "runProcessWithStdin").mockImplementation(async (_prog, _args, stdin) => {
      const s = String(stdin);
      if (s.includes("rbacPolicy")) configWrites.push(s);
      if (/kind: ClusterRole\b/.test(s) && !/ClusterRoleBinding/.test(s)) return { code: 1, stdout: "", stderr: "Forbidden" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const res = await setRbac("ctx-a", "default", {
      action: "setRbac", policy: serializePolicy(DEFAULT_POLICY), contexts: ["ctx-a"],
    });
    const result = JSON.parse(res.stdout) as { applied: string[]; failures: { context: string }[] };
    expect(result.applied).toEqual([]);
    expect(result.failures).toEqual([{ context: "ctx-a", error: "Forbidden" }]);
    expect(configWrites).toHaveLength(1);
  });
});

test("installedContexts returns managed contexts with the active flag", async () => {
  vi.spyOn(runMod, "kubectl").mockImplementation(async (_ctx, args) => {
    if (args[0] === "config") {
      return { code: 0, stdout: JSON.stringify({
        "current-context": "ctx-a",
        contexts: [{ name: "ctx-a", context: { cluster: "a" } }, { name: "ctx-b", context: { cluster: "b" } }],
        clusters: [{ name: "a", cluster: {} }, { name: "b", cluster: {} }],
      }), stderr: "" };
    }
    return { code: 0, stdout: JSON.stringify({ metadata: { labels: { "app.kubernetes.io/managed-by": "rigel-assistant" } } }), stderr: "" };
  });
  const res = await handleAssistant("ctx-a", { action: "installedContexts", namespace: "default" });
  const parsed = JSON.parse(res.stdout) as { contexts: { name: string; active: boolean }[] };
  expect(parsed.contexts).toEqual([
    { name: "ctx-a", active: true },
    { name: "ctx-b", active: false },
  ]);
  vi.restoreAllMocks();
});

test("handleAssistant routes getRbac/setRbac", async () => {
  vi.spyOn(runMod, "kubectl").mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" });
  const getRes = await handleAssistant(null, { action: "getRbac", namespace: "default" });
  expect(JSON.parse(getRes.stdout)).toHaveProperty("policy");
  vi.restoreAllMocks();

  vi.spyOn(runMod, "kubectl").mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" });
  vi.spyOn(runMod, "runProcessWithStdin").mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  const setRes = await handleAssistant(null, {
    action: "setRbac", namespace: "default", policy: serializePolicy(DEFAULT_POLICY), contexts: ["default"],
  });
  expect(JSON.parse(setRes.stdout)).toHaveProperty("applied");
  vi.restoreAllMocks();

  vi.spyOn(runMod, "kubectl").mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" });
  vi.spyOn(runMod, "runProcessWithStdin").mockImplementation(async (_prog, _fullArgs, stdin) => {
    if (/kind: ClusterRole\b/.test(String(stdin))) return { code: 1, stdout: "", stderr: "connection refused" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const failRes = await handleAssistant(null, {
    action: "setRbac", namespace: "default", policy: serializePolicy(DEFAULT_POLICY), contexts: ["default"],
  });
  expect(failRes.code).not.toBe(0);
  expect(failRes.stderr).toContain("connection refused");
  vi.restoreAllMocks();
});
