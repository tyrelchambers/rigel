import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "./runAgent";
import { runCodex } from "./codexBridge";
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

let home: string;
const ORIG_HOME = process.env.HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rigel-runagent-"));
  process.env.HOME = home;
  await mkdir(join(home, ".claude"), { recursive: true });
});
afterEach(async () => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  await rm(home, { recursive: true, force: true });
});

test("a coming-soon active agent yields a single 'not available' error event", async () => {
  // Force the active agent to a coming-soon one by writing the config directly.
  await writeFile(
    join(home, ".claude", "rigel-agents.json"),
    JSON.stringify({ activeAgentId: "gemini", agents: {} }),
  );
  const events: ChatEvent[] = [];
  for await (const ev of runAgent("hi", null)) events.push(ev);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("error");
  expect(events[0].text).toMatch(/isn't available/i);
});

test("active agent codex routes to the codex runner, not the 'not available' path", async () => {
  await writeFile(
    join(home, ".claude", "rigel-agents.json"),
    JSON.stringify({ activeAgentId: "codex", agents: {} }),
  );
  const events: ChatEvent[] = [];
  for await (const ev of runAgent("hi", null)) events.push(ev);
  // POSITIVE assertion: it genuinely entered the codex runner. We assert via the
  // spy because `codex` can be resolvable on this machine, so a real spawn would
  // not reliably produce a spawn error to match on.
  expect(runCodex).toHaveBeenCalledTimes(1);
  expect(runCodex).toHaveBeenCalledWith("hi", null, undefined, undefined);
  // And it did NOT short-circuit to the "isn't available yet" fallback.
  expect(events.some((ev) => /isn't available/i.test(ev.text ?? ""))).toBe(false);
});
