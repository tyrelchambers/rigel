import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { buildGeminiArgs, mapGeminiEvent, geminiBridge } from "./gemini.js";

describe("buildGeminiArgs", () => {
  test("headless stream-json + yolo + model", () => {
    const argv = buildGeminiArgs("why crash?", { model: "gemini-2.5-pro", prompt: "why crash?" } as any);
    expect(argv[0]).toBe("gemini");
    expect(argv).toContain("-p");
    expect(argv).toContain("-o");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--approval-mode");
    expect(argv).toContain("yolo");
    const mIdx = argv.indexOf("-m");
    expect(argv[mIdx + 1]).toBe("gemini-2.5-pro");
  });
  test("no -m for a bare Claude alias or absent model", () => {
    expect(buildGeminiArgs("hi", { model: "sonnet", prompt: "hi" } as any)).not.toContain("-m");
    expect(buildGeminiArgs("hi", { prompt: "hi" } as any)).not.toContain("-m");
  });
});

describe("mapGeminiEvent", () => {
  test("init → session", () => {
    expect(mapGeminiEvent({ type: "init", session_id: "g1" })).toEqual([{ type: "session", sessionId: "g1" }]);
  });
  test("assistant message → text", () => {
    expect(mapGeminiEvent({ type: "message", role: "assistant", content: "hello" })).toEqual([{ type: "text", text: "hello" }]);
  });
  test("user message → ignored", () => {
    expect(mapGeminiEvent({ type: "message", role: "user", content: "echo" })).toEqual([]);
  });
  test("error severity error → error; warning → ignored", () => {
    expect(mapGeminiEvent({ type: "error", severity: "error", message: "boom" })).toEqual([{ type: "error", text: "boom" }]);
    expect(mapGeminiEvent({ type: "error", severity: "warning", message: "meh" })).toEqual([]);
  });
  test("result status error → error then done; success → done", () => {
    expect(mapGeminiEvent({ type: "result", status: "error", error: { message: "fail" } })).toEqual([
      { type: "error", text: "fail" }, { type: "done" },
    ]);
    expect(mapGeminiEvent({ type: "result", status: "success" })).toEqual([{ type: "done" }]);
  });
});

describe("geminiBridge.authEnv", () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.GEMINI_API_KEY; });
  afterEach(() => { process.env = { ...saved }; });
  test("null without GEMINI_API_KEY", () => { expect(geminiBridge.authEnv()).toBeNull(); });
  test("GEMINI_API_KEY when present", () => {
    process.env.GEMINI_API_KEY = "g-key";
    expect(geminiBridge.authEnv()).toEqual({ GEMINI_API_KEY: "g-key" });
  });
});

// ---------------------------------------------------------------------------
// geminiBridge.run — integration with a FAKE `gemini` executable (no real gemini/cluster)
// ---------------------------------------------------------------------------
describe("geminiBridge.run (fake gemini on PATH)", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  test("happy path: collects text + sessionId from JSONL, isError false", async () => {
    // A fake `gemini` shell script that emits three JSONL events and exits 0.
    const fakeDir = await mkdtemp(join(tmpdir(), "rigel-fake-gemini-"));
    const fakeGemini = join(fakeDir, "gemini");
    await writeFile(
      fakeGemini,
      [
        "#!/bin/sh",
        `echo '{"type":"init","session_id":"gemini_sess_1"}'`,
        `echo '{"type":"message","role":"assistant","content":"hello from gemini"}'`,
        `echo '{"type":"result","status":"success"}'`,
        "exit 0",
      ].join("\n") + "\n",
    );
    await chmod(fakeGemini, 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${fakeDir}${delimiter}${prevPath ?? ""}`;
    process.env.GEMINI_API_KEY = "g-fake";

    let result: Awaited<ReturnType<typeof geminiBridge.run>>;
    try {
      result = await geminiBridge.run({ prompt: "hi", systemPrompt: "" } as any);
    } finally {
      process.env.PATH = prevPath;
    }

    expect(result.isError).toBe(false);
    expect(result.text).toBe("hello from gemini");
    expect(result.sessionId).toBe("gemini_sess_1");

    await rm(fakeDir, { recursive: true, force: true });
  });

  test("workspace dir is cleaned up after successful run (no rigel-gemini- leak)", async () => {
    // The rigel-gemini- prefix is unique to geminiBridge.run so snapshotting is race-free.
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
    process.env.GEMINI_API_KEY = "g-fake";

    try {
      await geminiBridge.run({ prompt: "hi", systemPrompt: "" } as any);
    } finally {
      process.env.PATH = prevPath;
    }

    const after = await geminiDirs();
    const leaked = [...after].filter((d) => !before.has(d));
    expect(leaked).toEqual([]);

    await rm(fakeDir, { recursive: true, force: true });
  });

  test("does not leak workspace dir when provisionGuardBin throws (empty PATH)", async () => {
    // Empty PATH → kubectl unresolvable → provisionGuardBin throws inside try block.
    // Workspace dir (rigel-gemini-) is created BEFORE that call; finally must still remove it.
    const geminiDirs = async () =>
      new Set((await readdir(tmpdir())).filter((d) => d.startsWith("rigel-gemini-")));
    const before = await geminiDirs();

    const emptyDir = await mkdtemp(join(tmpdir(), "rigel-emptypath-"));
    const prevPath = process.env.PATH;
    process.env.PATH = emptyDir;
    process.env.GEMINI_API_KEY = "g-fake";

    let result: Awaited<ReturnType<typeof geminiBridge.run>>;
    try {
      result = await geminiBridge.run({ prompt: "hi", systemPrompt: "" } as any);
    } finally {
      process.env.PATH = prevPath;
    }

    // run() swallows the throw → returns isError (not a thrown exception).
    expect(result!.isError).toBe(true);

    const after = await geminiDirs();
    const leaked = [...after].filter((d) => !before.has(d));
    expect(leaked).toEqual([]);

    await rm(emptyDir, { recursive: true, force: true });
  });

  test("missing GEMINI_API_KEY returns isError:true with descriptive errorMessage", async () => {
    delete process.env.GEMINI_API_KEY;
    // No fake CLI on PATH — if it were spawned it would ENOENT, giving a different error.
    const result = await geminiBridge.run({ prompt: "hi", systemPrompt: "" } as any);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toMatch(/GEMINI_API_KEY/);
  });
});
