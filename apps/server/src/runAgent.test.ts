import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "./runAgent";
import type { ChatEvent } from "./claudeBridge";

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
  // `codex` is absent on this machine, so runCodex will surface a spawn/error
  // event from streamAgentProcess. We only assert it ROUTED to runCodex (i.e.
  // it did NOT short-circuit to the "isn't available yet" fallback).
  for await (const ev of runAgent("hi", null)) events.push(ev);
  expect(events.some((ev) => /isn't available/i.test(ev.text ?? ""))).toBe(false);
});
