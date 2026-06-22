import { test, expect, describe } from "vitest";
import { mkdtemp, writeFile, chmod, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { buildGeminiArgs, mapGeminiEvent, runGemini } from "./geminiBridge";
import { systemPrompt } from "./systemPrompt";

// ---------------------------------------------------------------------------
// buildGeminiArgs — pure argv build (no subprocess, no gemini)
// ---------------------------------------------------------------------------
describe("buildGeminiArgs", () => {
  test("emits the headless stream-json + yolo flag set + prompt, no -m", () => {
    const argv = buildGeminiArgs("list pods", "prod", {});

    // Leading positionals: `gemini -p <prompt>`.
    expect(argv[0]).toBe("gemini");
    expect(argv[1]).toBe("-p");

    // stream-json output + auto-approve.
    expect(argv).toContain("-o");
    const oIdx = argv.indexOf("-o");
    expect(argv[oIdx + 1]).toBe("stream-json");
    expect(argv).toContain("--approval-mode");
    const aIdx = argv.indexOf("--approval-mode");
    expect(argv[aIdx + 1]).toBe("yolo");

    // No sandbox flag (it would block kubectl's network).
    expect(argv).not.toContain("-s");
    expect(argv).not.toContain("--sandbox");

    // No resume this pass.
    expect(argv).not.toContain("-r");
    expect(argv).not.toContain("--resume");

    // No -m for a missing model.
    expect(argv).not.toContain("-m");
    expect(argv).not.toContain("--model");
  });

  test("fullPrompt (the -p value) contains both the system prompt and the user prompt", () => {
    const argv = buildGeminiArgs("why is nginx crashing?", "prod", {});
    const fullPrompt = argv[2];
    expect(fullPrompt).toContain("running inside Rigel");
    expect(fullPrompt).toContain("prod");
    expect(fullPrompt).toContain("# User request");
    expect(fullPrompt).toContain("why is nginx crashing?");
    expect(fullPrompt.startsWith(systemPrompt("prod"))).toBe(true);
  });

  test("passes a real Gemini model via -m", () => {
    const argv = buildGeminiArgs("hi", null, { model: "gemini-2.5-pro" });
    const mIdx = argv.indexOf("-m");
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toBe("gemini-2.5-pro");
  });

  test("skips a bare Claude alias (opus/sonnet/haiku) — no -m", () => {
    for (const alias of ["opus", "sonnet", "haiku"]) {
      const argv = buildGeminiArgs("hi", null, { model: alias });
      expect(argv).not.toContain("-m");
      expect(argv).not.toContain(alias);
    }
  });

  test("opts.effort is ignored; opts.sessionId never adds -r (fresh per turn)", () => {
    const argv = buildGeminiArgs("hi", null, { effort: "high", sessionId: "sess_abc" });
    expect(argv).not.toContain("--effort");
    expect(argv).not.toContain("high");
    expect(argv).not.toContain("-r");
    expect(argv).not.toContain("sess_abc");
  });
});

// ---------------------------------------------------------------------------
// mapGeminiEvent — pure event mapping (table-driven, tolerant)
// ---------------------------------------------------------------------------
describe("mapGeminiEvent", () => {
  test("init → session event", () => {
    const r = mapGeminiEvent({ type: "init", session_id: "sess_xyz", model: "gemini-2.5-pro" });
    expect(r).toEqual([{ type: "session", sessionId: "sess_xyz" }]);
  });

  test("init without a string session_id → empty", () => {
    expect(mapGeminiEvent({ type: "init" })).toHaveLength(0);
    expect(mapGeminiEvent({ type: "init", session_id: 42 })).toHaveLength(0);
  });

  test("assistant message → text event", () => {
    const r = mapGeminiEvent({ type: "message", role: "assistant", content: "Here are your pods:" });
    expect(r).toEqual([{ type: "text", text: "Here are your pods:" }]);
  });

  test("user message → empty (don't echo the prompt back)", () => {
    expect(mapGeminiEvent({ type: "message", role: "user", content: "list pods" })).toHaveLength(0);
  });

  test("assistant message without string content → empty", () => {
    expect(mapGeminiEvent({ type: "message", role: "assistant" })).toHaveLength(0);
    expect(mapGeminiEvent({ type: "message", role: "assistant", content: 5 })).toHaveLength(0);
  });

  test("tool_use → tool event (command extracted from parameters)", () => {
    const r = mapGeminiEvent({
      type: "tool_use",
      tool_name: "run_shell_command",
      tool_id: "t1",
      parameters: { command: "kubectl get pods" },
    });
    expect(r).toHaveLength(1);
    const [e] = r;
    expect(e.type).toBe("tool");
    expect(e.toolId).toBe("t1");
    expect(e.toolName).toBe("run_shell_command");
    expect(e.command).toBe("kubectl get pods");
    expect(e.inputJSON).toBe(JSON.stringify({ command: "kubectl get pods" }));
  });

  test("tool_use without a command param → tool event, command undefined, inputJSON '{}'", () => {
    const r = mapGeminiEvent({ type: "tool_use", tool_name: "read_file", tool_id: "t2" });
    expect(r[0].command).toBeUndefined();
    expect(r[0].inputJSON).toBe("{}");
  });

  test("tool_result success → toolResult not error", () => {
    const r = mapGeminiEvent({
      type: "tool_result",
      tool_id: "t1",
      status: "success",
      output: "NAME   READY\nnginx  1/1",
    });
    expect(r).toEqual([
      { type: "toolResult", toolId: "t1", isError: false, output: "NAME   READY\nnginx  1/1" },
    ]);
  });

  test("tool_result error → toolResult isError, falls back to error.message", () => {
    const r = mapGeminiEvent({
      type: "tool_result",
      tool_id: "t2",
      status: "error",
      error: { message: "permission denied" },
    });
    expect(r).toHaveLength(1);
    expect(r[0].isError).toBe(true);
    expect(r[0].output).toBe("permission denied");
  });

  test("tool_result output truncated to 600 chars", () => {
    const r = mapGeminiEvent({
      type: "tool_result",
      tool_id: "t3",
      status: "success",
      output: "x".repeat(700),
    });
    expect(r[0].output).toBe("x".repeat(600) + "…");
  });

  test("error severity 'error' → error event", () => {
    const r = mapGeminiEvent({ type: "error", severity: "error", message: "stream broke" });
    expect(r).toEqual([{ type: "error", text: "stream broke" }]);
  });

  test("error severity 'warning' → empty (don't kill the turn on a warning)", () => {
    expect(mapGeminiEvent({ type: "error", severity: "warning", message: "heads up" })).toHaveLength(0);
  });

  test("result success → done event", () => {
    expect(mapGeminiEvent({ type: "result", status: "success", stats: {} })).toEqual([
      { type: "done" },
    ]);
  });

  test("result error → error event then done", () => {
    const r = mapGeminiEvent({ type: "result", status: "error", error: { message: "rate limited" } });
    expect(r).toEqual([
      { type: "error", text: "rate limited" },
      { type: "done" },
    ]);
  });

  test("result error without a message → fallback error text then done", () => {
    const r = mapGeminiEvent({ type: "result", status: "error" });
    expect(r).toEqual([
      { type: "error", text: "Gemini turn failed" },
      { type: "done" },
    ]);
  });

  test("unknown / malformed events → empty array (no throw)", () => {
    expect(mapGeminiEvent({ type: "unknown.future" })).toHaveLength(0);
    expect(mapGeminiEvent(null)).toHaveLength(0);
    expect(mapGeminiEvent(undefined)).toHaveLength(0);
    expect(mapGeminiEvent("a string")).toHaveLength(0);
    expect(mapGeminiEvent({})).toHaveLength(0);
    // Missing fields must not throw.
    expect(() => mapGeminiEvent({ type: "tool_use" })).not.toThrow();
    expect(() => mapGeminiEvent({ type: "tool_result" })).not.toThrow();
    expect(() => mapGeminiEvent({ type: "message" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runGemini — integration with a FAKE `gemini` executable (no real gemini/cluster)
// ---------------------------------------------------------------------------
describe("runGemini (fake gemini on PATH)", () => {
  test("yields mapped session + text + done and cleans up temp dirs", async () => {
    // A fake `gemini` that ignores its args and prints three JSONL lines: an init, an
    // assistant message, and a successful result, then exits 0. This proves runGemini
    // composes argv/env, spawns, streams, maps, and cleans up — without a real gemini
    // binary or cluster.
    const fakeDir = await mkdtemp(join(tmpdir(), "rigel-fake-gemini-"));
    const fakeGemini = join(fakeDir, "gemini");
    await writeFile(
      fakeGemini,
      [
        "#!/bin/sh",
        `echo '{"type":"init","session_id":"sess_fake","model":"gemini-2.5-pro"}'`,
        `echo '{"type":"message","role":"assistant","content":"hello from fake gemini"}'`,
        `echo '{"type":"result","status":"success"}'`,
        "exit 0",
      ].join("\n") + "\n",
    );
    await chmod(fakeGemini, 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${fakeDir}${delimiter}${prevPath ?? ""}`;

    const events: { type: string; text?: string; sessionId?: string }[] = [];
    try {
      for await (const e of runGemini("hi", null)) {
        events.push({ type: e.type, text: e.text, sessionId: e.sessionId });
      }
    } finally {
      process.env.PATH = prevPath;
    }

    expect(events.some((e) => e.type === "session" && e.sessionId === "sess_fake")).toBe(true);
    expect(events.some((e) => e.type === "text" && e.text === "hello from fake gemini")).toBe(true);
    // Done comes from the result event (runGemini does not synthesize it).
    expect(events.some((e) => e.type === "done")).toBe(true);

    await rm(fakeDir, { recursive: true, force: true });
  });

  test("removes its workspace temp dir after the run (no rigel-gemini- leak)", async () => {
    // Verifies runGemini's `finally` cleanup. The `rigel-gemini-` workspace prefix is
    // UNIQUE to runGemini, so snapshotting that one prefix before/after is race-free.
    const geminiDirs = async () =>
      new Set((await readdir(tmpdir())).filter((d) => d.startsWith("rigel-gemini-")));
    const before = await geminiDirs();

    const fakeDir = await mkdtemp(join(tmpdir(), "rigel-fake-gemini2-"));
    const fakeGemini = join(fakeDir, "gemini");
    await writeFile(
      fakeGemini,
      ["#!/bin/sh", `echo '{"type":"result","status":"success"}'`, "exit 0"].join("\n") + "\n",
    );
    await chmod(fakeGemini, 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${fakeDir}${delimiter}${prevPath ?? ""}`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of runGemini("hi", null)) {
        /* consume */
      }
    } finally {
      process.env.PATH = prevPath;
    }

    const after = await geminiDirs();
    expect([...after].filter((d) => !before.has(d))).toEqual([]);

    await rm(fakeDir, { recursive: true, force: true });
  });

  test("does not leak its workspace dir when provisionGuardBin throws (kubectl unresolvable)", async () => {
    // workspaceDir is mkdtemp'd BEFORE provisionGuardBin is called, so if provisioning
    // throws (kubectl not on PATH) the finally must still remove the `rigel-gemini-`
    // workspace. Trigger the throw by pointing PATH at an empty dir.
    const geminiDirs = async () =>
      new Set((await readdir(tmpdir())).filter((d) => d.startsWith("rigel-gemini-")));
    const before = await geminiDirs();

    const emptyDir = await mkdtemp(join(tmpdir(), "rigel-emptypath-gemini-"));
    const prevPath = process.env.PATH;
    process.env.PATH = emptyDir;

    let threw = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of runGemini("hi", null)) {
        /* consume */
      }
    } catch {
      threw = true;
    } finally {
      process.env.PATH = prevPath;
    }

    expect(threw).toBe(true);
    const after = await geminiDirs();
    expect([...after].filter((d) => !before.has(d))).toEqual([]);

    await rm(emptyDir, { recursive: true, force: true });
  });
});
