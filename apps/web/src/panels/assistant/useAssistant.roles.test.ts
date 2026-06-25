import { describe, expect, test } from "vitest";
import { parseRolesFromConfig, parseLimitsFromConfig, credsFromSources } from "./useAssistant";

describe("parseRolesFromConfig", () => {
  test("reads both roles from the assistant-config keys", () => {
    const roles = parseRolesFromConfig({
      workerProvider: "gemini", workerModel: "gemini-2.5-pro",
      supervisorProvider: "claude", supervisorModel: "claude-opus-4-8", supervisorEffort: "high",
    });
    expect(roles.worker).toEqual({ provider: "gemini", model: "gemini-2.5-pro" });
    expect(roles.supervisor).toEqual({ provider: "claude", model: "claude-opus-4-8", effort: "high" });
  });

  test("falls back to the Claude defaults when no role keys are present", () => {
    const roles = parseRolesFromConfig({});
    expect(roles.worker).toEqual({ provider: "claude", model: "claude-sonnet-4-6", effort: "high" });
    expect(roles.supervisor).toEqual({ provider: "claude", model: "claude-opus-4-8", effort: "high" });
  });
});

describe("parseLimitsFromConfig", () => {
  test("reads + coerces the limit keys, splitting namespaces on newlines", () => {
    const limits = parseLimitsFromConfig({
      pollIntervalMs: "45000", confirmPolls: "4", namespaces: "default\nkube-system",
    });
    expect(limits.pollIntervalMs).toBe(45000);
    expect(limits.confirmPolls).toBe(4);
    expect(limits.namespaces).toEqual(["default", "kube-system"]);
  });

  test("empty namespaces string → empty array (all namespaces)", () => {
    expect(parseLimitsFromConfig({ namespaces: "" }).namespaces).toEqual([]);
  });
});

describe("credsFromSources", () => {
  test("maps ready credential ids to an AssistantCredentials presence view", () => {
    expect(
      credsFromSources({
        geminiApiKey: { ready: true, secretName: "rigel-assistant-credentials" },
        claudeToken: { ready: true, secretName: "rigel-assistant-token" },
      }),
    ).toEqual({ geminiApiKey: "set", claudeToken: "set" });
  });
  test("a resolved-but-empty source (ready: false) is omitted, so its chip reads Not set", () => {
    expect(
      credsFromSources({
        anthropicApiKey: { ready: false, secretName: "rigel-assistant-credentials" },
      }),
    ).toEqual({});
  });
  test("no sources → empty (all chips read Not set)", () => {
    expect(credsFromSources({})).toEqual({});
  });
});
