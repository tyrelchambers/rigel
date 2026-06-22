import { test, expect } from "vitest";
import { listAgents, getAgent } from "./agentRegistry";

test("claude, codex, and opencode are available; the rest are coming soon", () => {
  const ids = listAgents().map((a) => a.id);
  expect(ids).toEqual(["claude", "codex", "gemini", "opencode", "openrouter"]);
  expect(getAgent("claude")?.status).toBe("available");
  expect(getAgent("codex")?.status).toBe("available");
  expect(getAgent("opencode")?.status).toBe("available");
  for (const id of ["gemini", "openrouter"] as const) {
    expect(getAgent(id)?.status).toBe("comingSoon");
  }
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
  expect(getAgent("openrouter")?.authMethods).toEqual(["apiKey"]);
});

test("getAgent returns undefined for an unknown id", () => {
  expect(getAgent("bogus")).toBeUndefined();
});
