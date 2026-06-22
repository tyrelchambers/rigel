import { test, expect, describe } from "vitest";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { buildCodexArgs, mapCodexEvent, runCodex } from "./codexBridge";
import { systemPrompt } from "./systemPrompt";

// ---------------------------------------------------------------------------
// buildCodexArgs — pure argv build (no subprocess, no codex)
// ---------------------------------------------------------------------------
describe("buildCodexArgs", () => {
  const WORKSPACE = "/tmp/rigel-codex-fake";

  test("emits the headless read-only-via-shim flag set + prompt, no --model", () => {
    const argv = buildCodexArgs("list pods", "prod", {}, WORKSPACE);

    // Leading positionals: `codex exec` then the flags.
    expect(argv[0]).toBe("codex");
    expect(argv[1]).toBe("exec");

    // The safety-model flag set.
    expect(argv).toContain("--json");
    // -a never
    const aIdx = argv.indexOf("-a");
    expect(aIdx).toBeGreaterThan(-1);
    expect(argv[aIdx + 1]).toBe("never");
    // -s workspace-write
    const sIdx = argv.indexOf("-s");
    expect(sIdx).toBeGreaterThan(-1);
    expect(argv[sIdx + 1]).toBe("workspace-write");
    // -c sandbox_workspace_write.network_access=true
    const cIdx = argv.indexOf("-c");
    expect(cIdx).toBeGreaterThan(-1);
    expect(argv[cIdx + 1]).toBe("sandbox_workspace_write.network_access=true");
    // --skip-git-repo-check
    expect(argv).toContain("--skip-git-repo-check");
    // -C <workspaceDir>
    const cdIdx = argv.indexOf("-C");
    expect(cdIdx).toBeGreaterThan(-1);
    expect(argv[cdIdx + 1]).toBe(WORKSPACE);

    // NO --model / -m (Claude aliases aren't Codex models).
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("-m");
  });

  test("fullPrompt (last arg) contains both the system prompt and the user prompt", () => {
    const argv = buildCodexArgs("why is nginx crashing?", "prod", {}, WORKSPACE);
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

  test("ignores opts.model / opts.effort (Codex uses its configured default)", () => {
    const argv = buildCodexArgs("hi", null, { model: "opus", effort: "high" }, WORKSPACE);
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("opus");
    expect(argv).not.toContain("--effort");
    expect(argv).not.toContain("high");
  });

  test("resume form inserts `resume <sessionId>` right after exec when sessionId is set", () => {
    const argv = buildCodexArgs("continue", "prod", { sessionId: "thread_abc" }, WORKSPACE);
    expect(argv[0]).toBe("codex");
    expect(argv[1]).toBe("exec");
    expect(argv[2]).toBe("resume");
    expect(argv[3]).toBe("thread_abc");
    // Same flags + prompt still present after the resume token.
    expect(argv).toContain("--json");
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv[argv.length - 1]).toContain("# User request");
  });

  test("fresh form (no sessionId) has no resume token", () => {
    const argv = buildCodexArgs("hi", null, {}, WORKSPACE);
    expect(argv).not.toContain("resume");
    expect(argv.slice(0, 2)).toEqual(["codex", "exec"]);
  });
});

// ---------------------------------------------------------------------------
// mapCodexEvent — pure event mapping (table-driven, tolerant)
// ---------------------------------------------------------------------------
describe("mapCodexEvent", () => {
  test("thread.started → session event", () => {
    const r = mapCodexEvent({ type: "thread.started", thread_id: "thread_xyz" });
    expect(r).toEqual([{ type: "session", sessionId: "thread_xyz" }]);
  });

  test("agent_message item.completed → text event (item.type spelling)", () => {
    const r = mapCodexEvent({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "Here are your pods:" },
    });
    expect(r).toEqual([{ type: "text", text: "Here are your pods:" }]);
  });

  test("agent_message item.completed → text event (item_type spelling)", () => {
    const r = mapCodexEvent({
      type: "item.completed",
      item: { id: "i1", item_type: "agent_message", text: "Done." },
    });
    expect(r).toEqual([{ type: "text", text: "Done." }]);
  });

  test("agent_message only emits on item.completed, not item.started", () => {
    const r = mapCodexEvent({
      type: "item.started",
      item: { id: "i1", type: "agent_message", text: "partial" },
    });
    expect(r).toHaveLength(0);
  });

  test("reasoning item.completed → thinking event", () => {
    const r = mapCodexEvent({
      type: "item.completed",
      item: { id: "i2", type: "reasoning", text: "Let me think…" },
    });
    expect(r).toEqual([{ type: "thinking", text: "Let me think…" }]);
  });

  test("command_execution item.started → tool event (toolName shell)", () => {
    const item = { id: "c1", type: "command_execution", command: "kubectl get pods" };
    const r = mapCodexEvent({ type: "item.started", item });
    expect(r).toHaveLength(1);
    const [e] = r;
    expect(e.type).toBe("tool");
    expect(e.toolId).toBe("c1");
    expect(e.toolName).toBe("shell");
    expect(e.command).toBe("kubectl get pods");
    expect(e.inputJSON).toBe(JSON.stringify(item));
  });

  test("command_execution item.completed exit 0 → toolResult not error", () => {
    const r = mapCodexEvent({
      type: "item.completed",
      item: {
        id: "c1",
        type: "command_execution",
        exit_code: 0,
        status: "completed",
        aggregated_output: "NAME   READY\nnginx  1/1",
      },
    });
    expect(r).toHaveLength(1);
    const [e] = r;
    expect(e.type).toBe("toolResult");
    expect(e.toolId).toBe("c1");
    expect(e.isError).toBe(false);
    expect(e.output).toBe("NAME   READY\nnginx  1/1");
  });

  test("command_execution item.completed non-zero exit → toolResult isError", () => {
    const r = mapCodexEvent({
      type: "item.completed",
      item: { id: "c2", item_type: "command_execution", exit_code: 1, aggregated_output: "boom" },
    });
    expect(r).toHaveLength(1);
    expect(r[0].isError).toBe(true);
    expect(r[0].output).toBe("boom");
  });

  test("command_execution item.completed status failed → toolResult isError even with exit 0", () => {
    const r = mapCodexEvent({
      type: "item.completed",
      item: { id: "c3", type: "command_execution", exit_code: 0, status: "failed", aggregated_output: "denied" },
    });
    expect(r[0].isError).toBe(true);
  });

  test("command_execution aggregated_output truncated to 600 chars", () => {
    const r = mapCodexEvent({
      type: "item.completed",
      item: { id: "c4", type: "command_execution", exit_code: 0, aggregated_output: "x".repeat(700) },
    });
    expect(r[0].output).toBe("x".repeat(600) + "…");
  });

  test("turn.completed → done event", () => {
    expect(mapCodexEvent({ type: "turn.completed", usage: { input_tokens: 10 } })).toEqual([
      { type: "done" },
    ]);
  });

  test("turn.failed → error event (stringified error)", () => {
    const r = mapCodexEvent({ type: "turn.failed", error: { message: "rate limited" } });
    expect(r).toHaveLength(1);
    expect(r[0].type).toBe("error");
    expect(r[0].text).toBe("rate limited");
  });

  test("error event → error event", () => {
    const r = mapCodexEvent({ type: "error", message: "stream broke" });
    expect(r).toEqual([{ type: "error", text: "stream broke" }]);
  });

  test("unknown / ignored types → empty array", () => {
    expect(mapCodexEvent({ type: "turn.started" })).toHaveLength(0);
    expect(mapCodexEvent({ type: "unknown.future" })).toHaveLength(0);
    expect(mapCodexEvent(null)).toHaveLength(0);
    expect(mapCodexEvent({})).toHaveLength(0);
    // ignored item types
    expect(mapCodexEvent({ type: "item.completed", item: { id: "f", type: "file_change" } })).toHaveLength(0);
    expect(mapCodexEvent({ type: "item.completed", item: { id: "w", type: "web_search" } })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runCodex — integration with a FAKE `codex` executable (no real codex/cluster)
// ---------------------------------------------------------------------------
describe("runCodex (fake codex on PATH)", () => {
  test("yields mapped session + text and cleans up temp dirs", async () => {
    // A fake `codex` that ignores its args and prints two JSONL lines: a
    // thread.started and an agent_message item.completed, then exits 0. This proves
    // runCodex composes argv/env, spawns, streams, maps, and cleans up — without a
    // real codex binary or cluster.
    const fakeDir = await mkdtemp(join(tmpdir(), "rigel-fake-codex-"));
    const fakeCodex = join(fakeDir, "codex");
    await writeFile(
      fakeCodex,
      [
        "#!/bin/sh",
        // Emit two newline-delimited JSON events on stdout, ignoring all args.
        `echo '{"type":"thread.started","thread_id":"thread_fake"}'`,
        `echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"hello from fake codex"}}'`,
        "exit 0",
      ].join("\n") + "\n",
    );
    await chmod(fakeCodex, 0o755);

    // Prepend the fake-codex dir to PATH so spawn("codex") resolves to it. runCodex
    // also prepends the guard-shim dir, but ours stays ahead of the real PATH.
    const prevPath = process.env.PATH;
    process.env.PATH = `${fakeDir}${delimiter}${prevPath ?? ""}`;

    // Capture the temp dirs runCodex creates so we can assert they're removed. They
    // are mkdtemp'd under tmpdir with these prefixes; snapshot the set before/after.
    const events: { type: string; text?: string; sessionId?: string }[] = [];
    try {
      for await (const e of runCodex("hi", null)) {
        events.push({ type: e.type, text: e.text, sessionId: e.sessionId });
      }
    } finally {
      process.env.PATH = prevPath;
    }

    // The fake's two lines mapped to a session + a text event.
    expect(events.some((e) => e.type === "session" && e.sessionId === "thread_fake")).toBe(true);
    expect(events.some((e) => e.type === "text" && e.text === "hello from fake codex")).toBe(true);

    await rm(fakeDir, { recursive: true, force: true });
  });

  test("removes its workspace temp dir after the run (no rigel-codex- leak)", async () => {
    // Verifies runCodex's `finally` cleanup. ESM module namespaces can't be spied,
    // and whole-tmpdir diffing is racy (vitest runs files in parallel). But the
    // `rigel-codex-` workspace prefix is UNIQUE to runCodex — no other test file
    // creates it (guardedKubectl uses `rigel-guard-`). So snapshotting that one
    // prefix before/after this run is race-free: a survivor means cleanup failed.
    // The guard dir shares the identical `finally` removal, so we don't separately
    // diff `rigel-guard-` (guardedKubectl tests leave their own, making it racy).
    const { readdir } = await import("node:fs/promises");
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
    try {
      // Drain the generator.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of runCodex("hi", null)) {
        /* consume */
      }
    } finally {
      process.env.PATH = prevPath;
    }

    const after = await codexDirs();
    const leaked = [...after].filter((d) => !before.has(d));
    expect(leaked).toEqual([]);

    await rm(fakeDir, { recursive: true, force: true });
  });

  test("does not leak its workspace dir when provisionGuardBin throws (kubectl unresolvable)", async () => {
    // Fix-1 regression guard: workspaceDir is mkdtemp'd BEFORE provisionGuardBin is
    // called, so if provisioning throws (kubectl not on PATH) the finally must still
    // remove the `rigel-codex-` workspace. We trigger the throw by pointing PATH at an
    // empty dir — `command -v kubectl` then fails, so provisionGuardBin throws. The
    // `rigel-codex-` prefix is unique to runCodex (see the note in the prior test), so
    // before/after snapshotting that prefix is race-free.
    const { readdir } = await import("node:fs/promises");
    const codexDirs = async () =>
      new Set((await readdir(tmpdir())).filter((d) => d.startsWith("rigel-codex-")));
    const before = await codexDirs();

    // An empty dir with no kubectl/helm/sh — but `command -v` still works because the
    // shell builtin needs no PATH; it just won't find kubectl, so whichBinary → null
    // → provisionGuardBin throws.
    const emptyDir = await mkdtemp(join(tmpdir(), "rigel-emptypath-"));
    const prevPath = process.env.PATH;
    process.env.PATH = emptyDir;

    let threw = false;
    try {
      // Draining the generator surfaces the throw from provisionGuardBin.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of runCodex("hi", null)) {
        /* consume */
      }
    } catch {
      threw = true;
    } finally {
      process.env.PATH = prevPath;
    }

    // provisionGuardBin should have thrown (kubectl unresolvable on the empty PATH).
    expect(threw).toBe(true);

    // And despite that throw, runCodex's finally removed its workspace dir.
    const after = await codexDirs();
    const leaked = [...after].filter((d) => !before.has(d));
    expect(leaked).toEqual([]);

    await rm(emptyDir, { recursive: true, force: true });
  });
});
