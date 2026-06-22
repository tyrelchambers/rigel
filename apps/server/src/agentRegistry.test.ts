import { test, expect } from "vitest";
import { listAgents, getAgent } from "./agentRegistry";

test("claude, codex, gemini, and opencode are all available; openrouter is gone", () => {
  const ids = listAgents().map((a) => a.id);
  expect(ids).toEqual(["claude", "codex", "gemini", "opencode"]);
  expect(getAgent("claude")?.status).toBe("available");
  expect(getAgent("codex")?.status).toBe("available");
  expect(getAgent("gemini")?.status).toBe("available");
  expect(getAgent("opencode")?.status).toBe("available");
  // OpenRouter was removed entirely.
  expect(getAgent("openrouter")).toBeUndefined();
});

test("gemini is available with both subscription + apiKey auth methods", () => {
  const g = getAgent("gemini");
  expect(g?.status).toBe("available");
  expect(g?.authMethods).toEqual(["subscription", "apiKey"]);
  expect(g?.label).toBe("Gemini");
  expect(g?.vendor).toBe("Google");
  expect(g?.installLabel).toBe("Install Gemini CLI");
});

test("opencode is login-managed: available with a single subscription auth method", () => {
  const oc = getAgent("opencode");
  expect(oc?.status).toBe("available");
  expect(oc?.authMethods).toEqual(["subscription"]);
  expect(oc?.label).toBe("OpenCode");
  expect(oc?.vendor).toBe("OpenCode");
});

test("every agent offers at least one auth method; claude offers both", () => {
  for (const a of listAgents()) expect(a.authMethods.length).toBeGreaterThan(0);
  expect(getAgent("claude")?.authMethods).toEqual(["subscription", "apiKey"]);
});

test("getAgent returns undefined for an unknown id", () => {
  expect(getAgent("bogus")).toBeUndefined();
});
