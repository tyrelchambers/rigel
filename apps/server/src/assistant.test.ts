import { test, expect } from "vitest";
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
