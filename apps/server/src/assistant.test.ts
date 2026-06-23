import { test, expect, describe } from "vitest";
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

import { setModelsUpdates, setCredentialsSecrets } from "./assistant";

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

import { setCredentialSource, clearCredentialSource, type AssistantRequest as Req } from "./assistant";

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
