import { test, expect, vi, beforeEach, afterAll } from "vitest";

process.env.RIGEL_PAID_ENTITLEMENTS = "1";
afterAll(() => { delete process.env.RIGEL_PAID_ENTITLEMENTS; });

// Capture the env that runClaude hands to the spawn layer.
const calls: { env: Record<string, string> }[] = [];
vi.mock("./agentProcess", () => ({
  // eslint-disable-next-line require-yield
  async *streamAgentProcess(opts: { env: Record<string, string> }) {
    calls.push({ env: opts.env });
  },
}));
vi.mock("./agentConfig", () => ({ claudeAuthEnv: async () => ({}) }));

import { runClaude } from "./claudeBridge";
import { setEntitlement } from "./entitlements";

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) { /* consume */ }
}

beforeEach(() => { calls.length = 0; });

test("runClaude spawns with RIGEL_UNLOCKED_AUDITS from the live entitlement", async () => {
  setEntitlement({ plan: "pro", audits: ["security", "performance"], cloudConnect: false, agentAutonomy: false, fetchedAt: "t" });
  await drain(runClaude("hi", null));
  expect(calls[0].env.RIGEL_UNLOCKED_AUDITS).toBe("security,performance");
});

test("runClaude spawns with an empty RIGEL_UNLOCKED_AUDITS when free (no entitlement)", async () => {
  setEntitlement(null);
  await drain(runClaude("hi", null));
  expect(calls[0].env.RIGEL_UNLOCKED_AUDITS).toBe("");
});
