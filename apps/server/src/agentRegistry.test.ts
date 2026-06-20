import { test, expect } from "vitest";
import { listAgents, getAgent } from "./agentRegistry";

test("claude is the only available agent; the rest are coming soon", () => {
  const ids = listAgents().map((a) => a.id);
  expect(ids).toEqual(["claude", "codex", "gemini", "opencode", "openrouter"]);
  expect(getAgent("claude")?.status).toBe("available");
  for (const id of ["codex", "gemini", "opencode", "openrouter"] as const) {
    expect(getAgent(id)?.status).toBe("comingSoon");
  }
});

test("every agent offers at least one auth method; claude offers both", () => {
  for (const a of listAgents()) expect(a.authMethods.length).toBeGreaterThan(0);
  expect(getAgent("claude")?.authMethods).toEqual(["subscription", "apiKey"]);
  expect(getAgent("openrouter")?.authMethods).toEqual(["apiKey"]);
});

test("getAgent returns undefined for an unknown id", () => {
  expect(getAgent("bogus")).toBeUndefined();
});
