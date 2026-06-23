import { describe, expect, test } from "vitest";
import {
  PROVIDER_IDS,
  PROVIDER_AUTH,
  DEFAULT_WORKER,
  DEFAULT_SUPERVISOR,
  DEFAULT_LIMITS,
  credentialKeyFor,
  authMethodSummary,
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

  test("authMethodSummary reflects each provider's real auth options", () => {
    // Claude, OpenCode and Codex all support a subscription OR an API key headless.
    expect(authMethodSummary("claude")).toBe("Subscription or API key");
    expect(authMethodSummary("opencode")).toBe("Subscription or API key");
    expect(authMethodSummary("codex")).toBe("Subscription or API key");
    // Gemini's consumer login can't run headless, so it is API-key only.
    expect(authMethodSummary("gemini")).toBe("API key");
  });

  test("PROVIDER_AUTH methods route to the Secret key matching their kind", () => {
    // Claude, Codex and OpenCode expose both a subscription and an API-key method.
    expect(PROVIDER_AUTH.claude.find((m) => m.kind === "subscription")?.key).toBe("claudeToken");
    expect(PROVIDER_AUTH.claude.find((m) => m.kind === "apiKey")?.key).toBe("anthropicApiKey");
    expect(PROVIDER_AUTH.codex.find((m) => m.kind === "subscription")?.key).toBe("codexAuthContent");
    expect(PROVIDER_AUTH.codex.find((m) => m.kind === "apiKey")?.key).toBe("codexApiKey");
    expect(PROVIDER_AUTH.opencode.find((m) => m.kind === "subscription")?.key).toBe("opencodeAuthContent");
    expect(PROVIDER_AUTH.opencode.find((m) => m.kind === "apiKey")?.key).toBe("opencodeApiKey");
    // Gemini is API-key only.
    expect(PROVIDER_AUTH.gemini).toHaveLength(1);
    expect(PROVIDER_AUTH.gemini[0]!.key).toBe("geminiApiKey");
  });

  test("the first method of every provider is the one to offer first (recommended when there's a choice)", () => {
    for (const id of PROVIDER_IDS) {
      const methods = PROVIDER_AUTH[id];
      expect(methods.length).toBeGreaterThan(0);
      if (methods.length > 1) expect(methods[0]!.recommended).toBe(true);
    }
  });
});
