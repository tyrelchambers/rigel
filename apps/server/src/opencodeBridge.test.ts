import { test, expect, describe } from "vitest";
import { mkdtemp, writeFile, chmod, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { buildOpencodeArgs, mapOpencodeEvent, runOpencode } from "./opencodeBridge";
import { systemPrompt } from "./systemPrompt";

// ---------------------------------------------------------------------------
// buildOpencodeArgs — pure argv build (no subprocess, no opencode)
// ---------------------------------------------------------------------------
describe("buildOpencodeArgs", () => {
  const RUNDIR = "/tmp/rigel-opencode-fake";

  test("emits the headless json flag set + prompt, no -m/--model", () => {
    const argv = buildOpencodeArgs("list pods", "prod", {}, RUNDIR);

    // Leading positionals: `opencode run` then the flags.
    expect(argv[0]).toBe("opencode");
    expect(argv[1]).toBe("run");

    // --format json
    const fmtIdx = argv.indexOf("--format");
    expect(fmtIdx).toBeGreaterThan(-1);
    expect(argv[fmtIdx + 1]).toBe("json");
    // --thinking
    expect(argv).toContain("--thinking");
    // --dir <runDir>
    const dirIdx = argv.indexOf("--dir");
    expect(dirIdx).toBeGreaterThan(-1);
    expect(argv[dirIdx + 1]).toBe(RUNDIR);

    // NO model flag (Claude aliases aren't OpenCode models).
    expect(argv).not.toContain("-m");
    expect(argv).not.toContain("--model");

    // No resume token on a fresh turn.
    expect(argv).not.toContain("-s");
  });

  test("fullPrompt (last arg) contains both the system prompt and the user prompt", () => {
    const argv = buildOpencodeArgs("why is nginx crashing?", "prod", {}, RUNDIR);
    const fullPrompt = argv[argv.length - 1];
    // The system prompt teaches the action-block contract — a stable substring of it.
    expect(fullPrompt).toContain("running inside Rigel");
    // Context is threaded into the system prompt.
    expect(fullPrompt).toContain("prod");
    // The user's actual request is appended under a header.
    expect(fullPrompt).toContain("# User request");
    expect(fullPrompt).toContain("why is nginx crashing?");
    // It's literally systemPrompt(context) + the request.
    expect(fullPrompt.startsWith(systemPrompt("prod"))).toBe(true);
  });

  test("passes a real OpenCode model via -m", () => {
    const argv = buildOpencodeArgs("hi", null, { model: "anthropic/claude-sonnet-4" }, RUNDIR);
    const mIdx = argv.indexOf("-m");
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toBe("anthropic/claude-sonnet-4");
  });

  test("skips a bare Claude alias (opus/sonnet/haiku) — no -m", () => {
    for (const alias of ["opus", "sonnet", "haiku"]) {
      const argv = buildOpencodeArgs("hi", null, { model: alias }, RUNDIR);
      expect(argv).not.toContain("-m");
      expect(argv).not.toContain(alias);
    }
  });

  test("no -m when opts.model is absent; opts.effort is always ignored", () => {
    const argv = buildOpencodeArgs("hi", null, { effort: "high" }, RUNDIR);
    expect(argv).not.toContain("-m");
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("high");
  });

  test("resume form adds `-s <sessionId>` when sessionId is set", () => {
    const argv = buildOpencodeArgs("continue", "prod", { sessionId: "ses_abc" }, RUNDIR);
    expect(argv[0]).toBe("opencode");
    expect(argv[1]).toBe("run");
    const sIdx = argv.indexOf("-s");
    expect(sIdx).toBeGreaterThan(-1);
    expect(argv[sIdx + 1]).toBe("ses_abc");
    // Same flags + prompt still present.
    expect(argv).toContain("--format");
    expect(argv).toContain("--thinking");
    expect(argv[argv.length - 1]).toContain("# User request");
  });

  test("fresh form (no sessionId) has no -s token", () => {
    const argv = buildOpencodeArgs("hi", null, {}, RUNDIR);
    expect(argv).not.toContain("-s");
    expect(argv.slice(0, 2)).toEqual(["opencode", "run"]);
  });
});

// ---------------------------------------------------------------------------
// mapOpencodeEvent — pure event mapping (table-driven, tolerant)
// ---------------------------------------------------------------------------
describe("mapOpencodeEvent", () => {
  test("text → text event", () => {
    const r = mapOpencodeEvent({ type: "text", part: { text: "Here are your pods:" } });
    expect(r).toEqual([{ type: "text", text: "Here are your pods:" }]);
  });

  test("text with no text → empty array", () => {
    expect(mapOpencodeEvent({ type: "text", part: {} })).toHaveLength(0);
    expect(mapOpencodeEvent({ type: "text", part: { text: "" } })).toHaveLength(0);
    expect(mapOpencodeEvent({ type: "text" })).toHaveLength(0);
  });

  test("reasoning → thinking event", () => {
    const r = mapOpencodeEvent({ type: "reasoning", part: { text: "Let me think…" } });
    expect(r).toEqual([{ type: "thinking", text: "Let me think…" }]);
  });

  test("reasoning with no text → empty array", () => {
    expect(mapOpencodeEvent({ type: "reasoning", part: {} })).toHaveLength(0);
  });

  test("tool_use completed → tool + toolResult (isError false)", () => {
    const part = {
      id: "t1",
      type: "tool",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "kubectl get pods" },
        output: "NAME   READY\nnginx  1/1",
        title: "kubectl get pods",
      },
    };
    const r = mapOpencodeEvent({ type: "tool_use", part });
    expect(r).toHaveLength(2);
    const [tool, result] = r;
    expect(tool.type).toBe("tool");
    expect(tool.toolId).toBe("t1");
    expect(tool.toolName).toBe("bash");
    expect(tool.command).toBe("kubectl get pods");
    expect(tool.inputJSON).toBe(JSON.stringify(part));
    expect(result.type).toBe("toolResult");
    expect(result.toolId).toBe("t1");
    expect(result.isError).toBe(false);
    expect(result.output).toBe("NAME   READY\nnginx  1/1");
  });

  test("tool_use error → toolResult isError true, falls back to error text", () => {
    const part = {
      id: "t2",
      tool: "bash",
      state: { status: "error", input: { command: "kubectl delete pod x" }, error: "denied: cluster mutation" },
    };
    const r = mapOpencodeEvent({ type: "tool_use", part });
    expect(r).toHaveLength(2);
    const [tool, result] = r;
    expect(tool.command).toBe("kubectl delete pod x");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("denied: cluster mutation");
  });

  test("tool_use output truncated to 600 chars", () => {
    const part = { id: "t3", tool: "bash", state: { status: "completed", output: "x".repeat(700) } };
    const r = mapOpencodeEvent({ type: "tool_use", part });
    expect(r[1].output).toBe("x".repeat(600) + "…");
  });

  test("tool_use with missing state/input does not throw and yields undefined command", () => {
    const r = mapOpencodeEvent({ type: "tool_use", part: { id: "t4", tool: "read" } });
    expect(r).toHaveLength(2);
    expect(r[0].command).toBeUndefined();
    expect(r[1].isError).toBe(false);
    expect(r[1].output).toBe("");
  });

  test("step_start → session event carrying sessionID", () => {
    const r = mapOpencodeEvent({ type: "step_start", sessionID: "ses_xyz", part: {} });
    expect(r).toEqual([{ type: "session", sessionId: "ses_xyz" }]);
  });

  test("step_finish → empty array", () => {
    expect(mapOpencodeEvent({ type: "step_finish", part: {} })).toHaveLength(0);
  });

  test("error → error event (structured message preferred)", () => {
    const r = mapOpencodeEvent({ type: "error", error: { name: "SessionError", data: { message: "rate limited" } } });
    expect(r).toEqual([{ type: "error", text: "rate limited" }]);
  });

  test("error → falls back to name then a default", () => {
    expect(mapOpencodeEvent({ type: "error", error: { name: "BoomError" } })).toEqual([
      { type: "error", text: "BoomError" },
    ]);
    expect(mapOpencodeEvent({ type: "error", error: {} })).toEqual([
      { type: "error", text: "opencode error" },
    ]);
  });

  test("unknown / null / empty → empty array", () => {
    expect(mapOpencodeEvent({ type: "unknown.future" })).toHaveLength(0);
    expect(mapOpencodeEvent(null)).toHaveLength(0);
    expect(mapOpencodeEvent({})).toHaveLength(0);
    expect(mapOpencodeEvent("nope")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runOpencode — integration with a FAKE `opencode` executable (no real opencode)
// ---------------------------------------------------------------------------
describe("runOpencode (fake opencode on PATH)", () => {
  test("yields mapped session/text, synthesizes done, writes opencode.json, cleans up", async () => {
    // A fake `opencode` that ignores its args, prints two emit-shape JSONL lines (a
    // step_start carrying the session id and a text part), then exits 0. This proves
    // runOpencode composes argv/env, writes the permission config, spawns, streams,
    // maps, synthesizes `done`, and cleans up — without a real opencode or cluster.
    const fakeDir = await mkdtemp(join(tmpdir(), "rigel-fake-opencode-"));
    const fakeOpencode = join(fakeDir, "opencode");
    await writeFile(
      fakeOpencode,
      [
        "#!/bin/sh",
        `echo '{"type":"step_start","sessionID":"ses_fake","part":{}}'`,
        `echo '{"type":"text","part":{"text":"hello from fake opencode"}}'`,
        "exit 0",
      ].join("\n") + "\n",
    );
    await chmod(fakeOpencode, 0o755);

    // Snapshot the unique run-dir prefix before/after to assert cleanup (race-free:
    // `rigel-opencode-` is created only by runOpencode).
    const runDirs = async () =>
      new Set((await readdir(tmpdir())).filter((d) => d.startsWith("rigel-opencode-")));
    const before = await runDirs();

    const prevPath = process.env.PATH;
    process.env.PATH = `${fakeDir}${delimiter}${prevPath ?? ""}`;

    const events: { type: string; text?: string; sessionId?: string }[] = [];
    try {
      for await (const e of runOpencode("hi", null)) {
        events.push({ type: e.type, text: e.text, sessionId: e.sessionId });
      }
    } finally {
      process.env.PATH = prevPath;
    }

    // The fake's two lines mapped to a session + a text event…
    expect(events.some((e) => e.type === "session" && e.sessionId === "ses_fake")).toBe(true);
    expect(events.some((e) => e.type === "text" && e.text === "hello from fake opencode")).toBe(true);
    // …and runOpencode synthesized a trailing `done` (opencode emits none).
    expect(events[events.length - 1].type).toBe("done");

    // The run dir (with its opencode.json) was removed — no leak.
    const after = await runDirs();
    expect([...after].filter((d) => !before.has(d))).toEqual([]);

    await rm(fakeDir, { recursive: true, force: true });
  });

  test("the opencode.json the runner writes allows bash and denies edit/web", async () => {
    // Capture the actual config file by having the fake copy run-dir/opencode.json into
    // a known sentinel path we control, then read+assert its parsed contents.
    const fakeDir = await mkdtemp(join(tmpdir(), "rigel-fake-opencode3-"));
    const sentinel = join(fakeDir, "captured.json");
    const fakeOpencode = join(fakeDir, "opencode");
    await writeFile(
      fakeOpencode,
      [
        "#!/bin/sh",
        "dir=''",
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--dir" ]; then dir="$2"; fi',
        "  shift",
        "done",
        `cp "$dir/opencode.json" '${sentinel}'`,
        "exit 0",
      ].join("\n") + "\n",
    );
    await chmod(fakeOpencode, 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${fakeDir}${delimiter}${prevPath ?? ""}`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of runOpencode("hi", null)) {
        /* drain */
      }
    } finally {
      process.env.PATH = prevPath;
    }

    const cfg = JSON.parse(await readFile(sentinel, "utf8"));
    expect(cfg).toEqual({
      permission: { "*": "allow", edit: "deny", webfetch: "deny", websearch: "deny" },
    });

    await rm(fakeDir, { recursive: true, force: true });
  });
});
