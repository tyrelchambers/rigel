import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { buildOpencodeArgs, mapOpencodeEvent, opencodeBridge } from "./opencode.js";

describe("buildOpencodeArgs", () => {
  test("headless json + thinking + dir + model + trailing prompt", () => {
    const argv = buildOpencodeArgs("hi", { model: "anthropic/claude-x", prompt: "hi" } as any, "/run/dir");
    expect(argv.slice(0, 2)).toEqual(["opencode", "run"]);
    expect(argv).toContain("--format");
    expect(argv).toContain("json");
    expect(argv).toContain("--thinking");
    const dIdx = argv.indexOf("--dir");
    expect(argv[dIdx + 1]).toBe("/run/dir");
    const mIdx = argv.indexOf("-m");
    expect(argv[mIdx + 1]).toBe("anthropic/claude-x");
    expect(argv[argv.length - 1]).toBe("hi");
  });
  test("resume inserts -s <sessionId>", () => {
    const argv = buildOpencodeArgs("go", { resumeSessionId: "oc1", prompt: "go" } as any, "/d");
    const sIdx = argv.indexOf("-s");
    expect(argv[sIdx + 1]).toBe("oc1");
  });
  test("no -m for a bare Claude alias", () => {
    expect(buildOpencodeArgs("hi", { model: "opus", prompt: "hi" } as any, "/d")).not.toContain("-m");
  });
});

describe("mapOpencodeEvent", () => {
  test("text part → text", () => {
    expect(mapOpencodeEvent({ type: "text", part: { text: "answer" } })).toEqual([{ type: "text", text: "answer" }]);
  });
  test("step_start with sessionID → session", () => {
    expect(mapOpencodeEvent({ type: "step_start", sessionID: "oc9" })).toEqual([{ type: "session", sessionId: "oc9" }]);
  });
  test("error → error (structured message preferred)", () => {
    expect(mapOpencodeEvent({ type: "error", error: { data: { message: "no creds" } } })).toEqual([{ type: "error", text: "no creds" }]);
  });
  test("unknown → []", () => {
    expect(mapOpencodeEvent({ type: "step_finish" })).toEqual([]);
    expect(mapOpencodeEvent(null)).toEqual([]);
  });
});

describe("opencodeBridge.authEnv", () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.OPENCODE_AUTH_CONTENT; delete process.env.OPENCODE_API_KEY; });
  afterEach(() => { process.env = { ...saved }; });
  test("null with no opencode credential", () => { expect(opencodeBridge.authEnv()).toBeNull(); });
  test("OPENCODE_AUTH_CONTENT blob when present", () => {
    process.env.OPENCODE_AUTH_CONTENT = "{...}";
    expect(opencodeBridge.authEnv()).toEqual({ OPENCODE_AUTH_CONTENT: "{...}" });
  });
  test("OPENCODE_API_KEY when present", () => {
    process.env.OPENCODE_API_KEY = "oc-key";
    expect(opencodeBridge.authEnv()).toEqual({ OPENCODE_API_KEY: "oc-key" });
  });
});

// ---------------------------------------------------------------------------
// opencodeBridge.run — integration with a FAKE `opencode` executable (no real opencode/cluster)
// ---------------------------------------------------------------------------
describe("opencodeBridge.run (fake opencode on PATH)", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  test("happy path: collects text + sessionId from JSONL, isError false", async () => {
    // A fake `opencode` shell script that emits JSONL events and exits 0.
    const fakeDir = await mkdtemp(join(tmpdir(), "rigel-fake-opencode-"));
    const fakeOpencode = join(fakeDir, "opencode");
    await writeFile(
      fakeOpencode,
      [
        "#!/bin/sh",
        `echo '{"type":"step_start","sessionID":"oc_sess_1"}'`,
        `echo '{"type":"text","part":{"text":"hello from opencode"}}'`,
        "exit 0",
      ].join("\n") + "\n",
    );
    await chmod(fakeOpencode, 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${fakeDir}${delimiter}${prevPath ?? ""}`;
    process.env.OPENCODE_API_KEY = "oc-fake";

    let result: Awaited<ReturnType<typeof opencodeBridge.run>>;
    try {
      result = await opencodeBridge.run({ prompt: "hi", systemPrompt: "" } as any);
    } finally {
      process.env.PATH = prevPath;
    }

    expect(result.isError).toBe(false);
    expect(result.text).toBe("hello from opencode");
    expect(result.sessionId).toBe("oc_sess_1");

    await rm(fakeDir, { recursive: true, force: true });
  });

  test("workspace dir is cleaned up after successful run (no rigel-opencode- leak)", async () => {
    // The rigel-opencode- prefix is unique to opencodeBridge.run so snapshotting is race-free.
    const opencodeDirs = async () =>
      new Set((await readdir(tmpdir())).filter((d) => d.startsWith("rigel-opencode-")));
    const before = await opencodeDirs();

    const fakeDir = await mkdtemp(join(tmpdir(), "rigel-fake-opencode2-"));
    const fakeOpencode = join(fakeDir, "opencode");
    await writeFile(
      fakeOpencode,
      ["#!/bin/sh", "exit 0"].join("\n") + "\n",
    );
    await chmod(fakeOpencode, 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${fakeDir}${delimiter}${prevPath ?? ""}`;
    process.env.OPENCODE_API_KEY = "oc-fake";

    try {
      await opencodeBridge.run({ prompt: "hi", systemPrompt: "" } as any);
    } finally {
      process.env.PATH = prevPath;
    }

    const after = await opencodeDirs();
    const leaked = [...after].filter((d) => !before.has(d));
    expect(leaked).toEqual([]);

    await rm(fakeDir, { recursive: true, force: true });
  });

  test("does not leak workspace dir when provisionGuardBin throws (empty PATH)", async () => {
    // Empty PATH → kubectl unresolvable → provisionGuardBin throws inside try block.
    // Workspace dir (rigel-opencode-) is created BEFORE that call; finally must still remove it.
    const opencodeDirs = async () =>
      new Set((await readdir(tmpdir())).filter((d) => d.startsWith("rigel-opencode-")));
    const before = await opencodeDirs();

    const emptyDir = await mkdtemp(join(tmpdir(), "rigel-emptypath-"));
    const prevPath = process.env.PATH;
    process.env.PATH = emptyDir;
    process.env.OPENCODE_API_KEY = "oc-fake";

    let result: Awaited<ReturnType<typeof opencodeBridge.run>>;
    try {
      result = await opencodeBridge.run({ prompt: "hi", systemPrompt: "" } as any);
    } finally {
      process.env.PATH = prevPath;
    }

    // run() swallows the throw → returns isError (not a thrown exception).
    expect(result!.isError).toBe(true);

    const after = await opencodeDirs();
    const leaked = [...after].filter((d) => !before.has(d));
    expect(leaked).toEqual([]);

    await rm(emptyDir, { recursive: true, force: true });
  });

  test("missing credential returns isError:true with descriptive errorMessage", async () => {
    delete process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_AUTH_CONTENT;
    // No fake CLI on PATH — if it were spawned it would ENOENT, giving a different error.
    const result = await opencodeBridge.run({ prompt: "hi", systemPrompt: "" } as any);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toMatch(/OPENCODE/);
  });
});
