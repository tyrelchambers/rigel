import { test, expect } from "vitest";
import { streamAgentProcess, type ChatEvent } from "./agentProcess";

// A trivial mapper: each parsed JSONL object becomes one text event carrying its
// `msg` field. Lets us assert the harness's spawn/stream/parse/abort lifecycle
// against a REAL subprocess (no mocks).
const mapText = (ev: any): ChatEvent[] => [{ type: "text", text: ev.msg }];

async function collect(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

test("streams JSONL lines as mapped events and skips blank + non-JSON lines", async () => {
  // node writes two JSONL lines, one blank line, and one non-JSON line. The
  // harness should yield only the two parseable lines, in order.
  const script =
    'process.stdout.write(\'{"msg":"one"}\\n\\nnot json\\n{"msg":"two"}\\n\')';
  const events = await collect(
    streamAgentProcess({
      argv: ["node", "-e", script],
      env: process.env as Record<string, string>,
      mapEvent: mapText,
    }),
  );
  expect(events).toEqual([
    { type: "text", text: "one" },
    { type: "text", text: "two" },
  ]);
});

test("non-zero exit yields an error event with trimmed stderr", async () => {
  const script = 'process.stderr.write("boom\\n"); process.exit(3)';
  const events = await collect(
    streamAgentProcess({
      argv: ["node", "-e", script],
      env: process.env as Record<string, string>,
      mapEvent: mapText,
    }),
  );
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("error");
  expect(events[0].text).toBe("boom");
});

test("non-zero exit with no stderr falls back to the binary/code message", async () => {
  const events = await collect(
    streamAgentProcess({
      argv: ["node", "-e", "process.exit(2)"],
      env: process.env as Record<string, string>,
      mapEvent: mapText,
    }),
  );
  expect(events).toEqual([{ type: "error", text: "node exited with code 2" }]);
});

test("abort yields a done event and not an error", async () => {
  const controller = new AbortController();
  // A process that stays alive long enough to be aborted mid-stream.
  const script =
    'process.stdout.write(\'{"msg":"first"}\\n\'); setTimeout(() => {}, 10000)';
  const gen = streamAgentProcess({
    argv: ["node", "-e", script],
    env: process.env as Record<string, string>,
    signal: controller.signal,
    mapEvent: mapText,
  });

  const out: ChatEvent[] = [];
  for await (const e of gen) {
    out.push(e);
    if (e.type === "text") controller.abort();
  }

  expect(out[0]).toEqual({ type: "text", text: "first" });
  expect(out.at(-1)).toEqual({ type: "done" });
  expect(out.some((e) => e.type === "error")).toBe(false);
});

test("already-aborted signal kills immediately and yields done", async () => {
  const controller = new AbortController();
  controller.abort();
  const events = await collect(
    streamAgentProcess({
      argv: ["node", "-e", "setTimeout(() => {}, 10000)"],
      env: process.env as Record<string, string>,
      signal: controller.signal,
      mapEvent: mapText,
    }),
  );
  expect(events).toEqual([{ type: "done" }]);
});

test("missing binary surfaces an error event (ENOENT, not a hang)", async () => {
  const events = await collect(
    streamAgentProcess({
      argv: ["definitely-not-a-real-binary-xyz", "-e", "noop"],
      env: process.env as Record<string, string>,
      mapEvent: mapText,
    }),
  );
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("error");
  expect(events[0].text).toBeTruthy();
});
