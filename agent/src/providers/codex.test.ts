import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { buildCodexArgs, mapCodexEvent, codexBridge } from "./codex.js";

describe("buildCodexArgs", () => {
  test("emits the headless read-only-via-shim flag set + prompt", () => {
    const argv = buildCodexArgs("list pods", { model: "gpt-5-codex", prompt: "list pods" } as any);
    expect(argv[0]).toBe("codex");
    expect(argv[1]).toBe("exec");
    expect(argv).toContain("--json");
    expect(argv).not.toContain("-a");
    expect(argv).toContain("approval_policy=never");
    expect(argv).toContain("sandbox_mode=workspace-write");
    expect(argv).toContain("sandbox_workspace_write.network_access=true");
    expect(argv).toContain("--skip-git-repo-check");
    const mIdx = argv.indexOf("-m");
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toBe("gpt-5-codex");
    expect(argv[argv.length - 1]).toBe("list pods");
  });
  test("no -m when model is absent or a bare Claude alias", () => {
    expect(buildCodexArgs("hi", { prompt: "hi" } as any)).not.toContain("-m");
    expect(buildCodexArgs("hi", { model: "opus", prompt: "hi" } as any)).not.toContain("-m");
  });
});

describe("mapCodexEvent", () => {
  test("thread.started → session", () => {
    expect(mapCodexEvent({ type: "thread.started", thread_id: "t1" })).toEqual([{ type: "session", sessionId: "t1" }]);
  });
  test("agent_message item.completed → text", () => {
    expect(mapCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "done" } })).toEqual([{ type: "text", text: "done" }]);
  });
  test("turn.failed → error", () => {
    expect(mapCodexEvent({ type: "turn.failed", error: { message: "rate limited" } })).toEqual([{ type: "error", text: "rate limited" }]);
  });
  test("transient Reconnecting errors are suppressed", () => {
    expect(mapCodexEvent({ type: "error", message: "Reconnecting... 2/5" })).toEqual([]);
  });
  test("unknown events → []", () => {
    expect(mapCodexEvent({ type: "turn.started" })).toEqual([]);
    expect(mapCodexEvent(null)).toEqual([]);
  });
});

describe("codexBridge.authEnv", () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.CODEX_API_KEY; });
  afterEach(() => { process.env = { ...saved }; });
  test("null without CODEX_API_KEY", () => { expect(codexBridge.authEnv()).toBeNull(); });
  test("CODEX_API_KEY env when present", () => {
    process.env.CODEX_API_KEY = "sk-codex";
    expect(codexBridge.authEnv()).toEqual({ CODEX_API_KEY: "sk-codex" });
  });
});

// ---------------------------------------------------------------------------
// codexBridge.run — integration with a FAKE `codex` executable (no real codex/cluster)
// ---------------------------------------------------------------------------
describe("codexBridge.run (fake codex on PATH)", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  test("happy path: collects text + sessionId from JSONL, isError false", async () => {
    // A fake `codex` shell script that emits two JSONL events and exits 0.
    // Proves run() composes argv/env, spawns, streams, maps, and cleans up.
    const fakeDir = await mkdtemp(join(tmpdir(), "rigel-fake-codex-"));
    const fakeCodex = join(fakeDir, "codex");
    await writeFile(
      fakeCodex,
      [
        "#!/bin/sh",
        `echo '{"type":"thread.started","thread_id":"thread_abc"}'`,
        `echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"hello from codex"}}'`,
        "exit 0",
      ].join("\n") + "\n",
    );
    await chmod(fakeCodex, 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${fakeDir}${delimiter}${prevPath ?? ""}`;
    process.env.CODEX_API_KEY = "sk-fake";

    let result: Awaited<ReturnType<typeof codexBridge.run>>;
    try {
      result = await codexBridge.run({ prompt: "hi", systemPrompt: "" } as any);
    } finally {
      process.env.PATH = prevPath;
    }

    expect(result.isError).toBe(false);
    expect(result.text).toBe("hello from codex");
    expect(result.sessionId).toBe("thread_abc");

    await rm(fakeDir, { recursive: true, force: true });
  });

  test("workspace dir is cleaned up after successful run (no rigel-codex- leak)", async () => {
    // Snapshot the rigel-codex- prefix before and after; any survivor = cleanup bug.
    // The rigel-codex- prefix is unique to codexBridge.run so snapshotting is race-free.
    const codexDirs = async () =>
      new Set((await readdir(tmpdir())).filter((d) => d.startsWith("rigel-codex-")));
    const before = await codexDirs();

    const fakeDir = await mkdtemp(join(tmpdir(), "rigel-fake-codex2-"));
    const fakeCodex = join(fakeDir, "codex");
    await writeFile(
      fakeCodex,
      ["#!/bin/sh", `echo '{"type":"turn.completed"}'`, "exit 0"].join("\n") + "\n",
    );
    await chmod(fakeCodex, 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${fakeDir}${delimiter}${prevPath ?? ""}`;
    process.env.CODEX_API_KEY = "sk-fake";

    try {
      await codexBridge.run({ prompt: "hi", systemPrompt: "" } as any);
    } finally {
      process.env.PATH = prevPath;
    }

    const after = await codexDirs();
    const leaked = [...after].filter((d) => !before.has(d));
    expect(leaked).toEqual([]);

    await rm(fakeDir, { recursive: true, force: true });
  });

  test("does not leak workspace dir when provisionGuardBin throws (empty PATH)", async () => {
    // Empty PATH means kubectl is unresolvable → provisionGuardBin throws inside
    // the try block. The workspace dir (rigel-codex-) is created BEFORE that call,
    // so the finally must still remove it. run() catches the throw and returns isError.
    const codexDirs = async () =>
      new Set((await readdir(tmpdir())).filter((d) => d.startsWith("rigel-codex-")));
    const before = await codexDirs();

    const emptyDir = await mkdtemp(join(tmpdir(), "rigel-emptypath-"));
    const prevPath = process.env.PATH;
    process.env.PATH = emptyDir;
    process.env.CODEX_API_KEY = "sk-fake";

    let result: Awaited<ReturnType<typeof codexBridge.run>>;
    try {
      result = await codexBridge.run({ prompt: "hi", systemPrompt: "" } as any);
    } finally {
      process.env.PATH = prevPath;
    }

    // run() swallows the throw → returns isError (not a thrown exception).
    expect(result!.isError).toBe(true);

    const after = await codexDirs();
    const leaked = [...after].filter((d) => !before.has(d));
    expect(leaked).toEqual([]);

    await rm(emptyDir, { recursive: true, force: true });
  });

  test("missing CODEX_API_KEY returns isError:true with descriptive errorMessage", async () => {
    delete process.env.CODEX_API_KEY;
    // No fake CLI on PATH — if it were spawned it would ENOENT, giving a different error.
    const result = await codexBridge.run({ prompt: "hi", systemPrompt: "" } as any);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toMatch(/CODEX_API_KEY/);
  });
});
