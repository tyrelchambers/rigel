import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { AGENTS_CONFIG_KEY, emptyUserConfigData } from "@rigel/k8s/src/userConfig";
import {
  __resetClusterConfigCache,
  __setClusterConfigIO,
  __useFakeClusterConfig,
  type FakeClusterConfig,
} from "./clusterConfigStore";
import { runAgent } from "./runAgent";
import { runCodex } from "./codexBridge";
import { runGemini } from "./geminiBridge";
import { runOpencode } from "./opencodeBridge";
import type { ChatEvent } from "./claudeBridge";

// Spy on the codex runner so the routing test asserts it was actually invoked,
// rather than inferring routing from a spawn error. `codex` may be installed on
// the dev/CI machine, so a real spawn would NOT reliably surface an error — the
// spy is the robust signal that runAgent entered the codex path.
vi.mock("./codexBridge", () => ({
  // eslint-disable-next-line require-yield
  runCodex: vi.fn(async function* () {
    /* no events: the test only cares that this runner was reached */
  }),
}));

// Same rationale for opencode — and `opencode` IS installed on this machine, so a
// real spawn would not error; the spy is the robust signal that the opencode path
// was reached.
vi.mock("./opencodeBridge", () => ({
  // eslint-disable-next-line require-yield
  runOpencode: vi.fn(async function* () {
    /* no events: the test only cares that this runner was reached */
  }),
}));

// Same rationale for gemini — mock the runner so the routing test asserts it was
// reached without spawning a real `gemini`.
vi.mock("./geminiBridge", () => ({
  // eslint-disable-next-line require-yield
  runGemini: vi.fn(async function* () {
    /* no events: the test only cares that this runner was reached */
  }),
}));

let fake: FakeClusterConfig;
/** The agents config lives in the cluster, so routing reads it per context. */
const CTX = "test-cluster";

/** Seed the cluster's stored agents config. */
function seedActiveAgent(activeAgentId: string): void {
  fake.secrets.set(CTX, {
    ...emptyUserConfigData(),
    [AGENTS_CONFIG_KEY]: JSON.stringify({ activeAgentId, agents: {} }),
  });
  __resetClusterConfigCache();
}

beforeEach(() => {
  fake = __useFakeClusterConfig();
});
afterEach(() => {
  __setClusterConfigIO(null);
  __resetClusterConfigCache();
});

test("an unknown active agent yields a single 'not available' error event", async () => {
  // No coming-soon agents remain, so the fallback is only hit when the active id
  // doesn't match any known runner. Force that by writing an unknown id.
  seedActiveAgent("openrouter");
  const events: ChatEvent[] = [];
  for await (const ev of runAgent("hi", CTX)) events.push(ev);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("error");
  expect(events[0].text).toMatch(/isn't available/i);
});

test("active agent codex routes to the codex runner, not the 'not available' path", async () => {
  seedActiveAgent("codex");
  const events: ChatEvent[] = [];
  for await (const ev of runAgent("hi", CTX)) events.push(ev);
  // POSITIVE assertion: it genuinely entered the codex runner. We assert via the
  // spy because `codex` can be resolvable on this machine, so a real spawn would
  // not reliably produce a spawn error to match on.
  expect(runCodex).toHaveBeenCalledTimes(1);
  expect(runCodex).toHaveBeenCalledWith("hi", CTX, undefined, undefined);
  // And it did NOT short-circuit to the "isn't available yet" fallback.
  expect(events.some((ev) => /isn't available/i.test(ev.text ?? ""))).toBe(false);
});

test("active agent gemini routes to the gemini runner, not the 'not available' path", async () => {
  seedActiveAgent("gemini");
  const events: ChatEvent[] = [];
  for await (const ev of runAgent("hi", CTX)) events.push(ev);
  // POSITIVE assertion: it genuinely entered the gemini runner (asserted via the spy).
  expect(runGemini).toHaveBeenCalledTimes(1);
  expect(runGemini).toHaveBeenCalledWith("hi", CTX, undefined, undefined);
  expect(events.some((ev) => /isn't available/i.test(ev.text ?? ""))).toBe(false);
});

test("active agent opencode routes to the opencode runner, not the 'not available' path", async () => {
  seedActiveAgent("opencode");
  const events: ChatEvent[] = [];
  for await (const ev of runAgent("hi", CTX)) events.push(ev);
  // POSITIVE assertion: it genuinely entered the opencode runner. We assert via the
  // spy because `opencode` IS resolvable on this machine, so a real spawn would not
  // reliably produce a spawn error to match on.
  expect(runOpencode).toHaveBeenCalledTimes(1);
  expect(runOpencode).toHaveBeenCalledWith("hi", CTX, undefined, undefined);
  // And it did NOT short-circuit to the "isn't available yet" fallback.
  expect(events.some((ev) => /isn't available/i.test(ev.text ?? ""))).toBe(false);
});
