import { describe, expect, test } from "vitest";
import {
  PROVIDER_IDS,
  DEFAULT_WORKER,
  DEFAULT_SUPERVISOR,
  DEFAULT_LIMITS,
  credentialKeyFor,
  isClaudeFamily,
  credentialReady,
} from "./providerMeta";
import type { AssistantCredentials } from "@/lib/api";

describe("providerMeta", () => {
  test("the four provider ids in stable order", () => {
    expect(PROVIDER_IDS).toEqual(["claude", "codex", "gemini", "opencode"]);
  });

  test("role defaults match the out-of-box assistant", () => {
    expect(DEFAULT_WORKER).toEqual({ provider: "claude", model: "claude-sonnet-4-6", effort: "high" });
    expect(DEFAULT_SUPERVISOR).toEqual({ provider: "claude", model: "claude-opus-4-8", effort: "high" });
  });

  test("limit defaults mirror the server DEFAULT_INSTALL_CONFIG (no drift)", () => {
    expect(DEFAULT_LIMITS).toEqual({
      pollIntervalMs: 30000,
      maxPerResourcePerHour: 3,
      maxPerNight: 20,
      maxAttemptsPerIncident: 3,
      confirmPolls: 2,
      namespaces: [],
    });
  });

  test("credentialKeyFor maps a provider to its primary Secret key", () => {
    expect(credentialKeyFor("claude")).toBe("claudeToken");
    expect(credentialKeyFor("codex")).toBe("codexApiKey");
    expect(credentialKeyFor("gemini")).toBe("geminiApiKey");
    expect(credentialKeyFor("opencode")).toBe("opencodeApiKey");
  });

  test("isClaudeFamily is true only for claude (drives the effort control)", () => {
    expect(isClaudeFamily("claude")).toBe(true);
    expect(isClaudeFamily("gemini")).toBe(false);
  });

  test("credentialReady is true when ANY of a provider's keys is set", () => {
    const creds: AssistantCredentials = { anthropicApiKey: "sk-ant", geminiApiKey: "" };
    expect(credentialReady("claude", creds)).toBe(true); // anthropicApiKey is an alt claude key
    expect(credentialReady("codex", creds)).toBe(false);
    expect(credentialReady("gemini", { geminiApiKey: "g" })).toBe(true);
    expect(credentialReady("opencode", { opencodeAuthContent: "blob" })).toBe(true);
  });
});
