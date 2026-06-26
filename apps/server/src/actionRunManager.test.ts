import { test, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ActionRunManager } from "./actionRunManager";
import { buildCommand } from "./actions";
import { buildKubectlArgs } from "@rigel/k8s/src/run";
import type { ActionBlock } from "./actions";

function fakeProc() {
  const p = new EventEmitter() as any;
  p.stdout = new PassThrough();
  p.stderr = new PassThrough();
  p.kill = vi.fn();
  return p;
}
function fakeWs() {
  const sent: any[] = [];
  return { sent, send: (raw: string) => sent.push(JSON.parse(raw)) };
}

// ---------------------------------------------------------------------------
// argv parity test — the manager must pass the exact same argv the REST route
// would build: buildKubectlArgs(context, buildCommand(action)).
// ---------------------------------------------------------------------------
test("manager passes the same argv as the REST route for a restart action", () => {
  const action: ActionBlock = {
    kind: "restart",
    name: "my-app",
    namespace: "staging",
  };
  const context = "my-cluster";

  const spawns: Array<{ bin: string; args: string[] }> = [];
  const spawnFn = (bin: string, args: string[]) => {
    spawns.push({ bin, args });
    return fakeProc();
  };
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, context, spawnFn as any);
  mgr.run({ id: "r1", action });

  expect(spawns).toHaveLength(1);
  expect(spawns[0]!.bin).toBe("kubectl");
  const expectedArgs = buildKubectlArgs(context, buildCommand(action));
  expect(spawns[0]!.args).toEqual(expectedArgs);
});

test("argv parity with no context (null)", () => {
  const action: ActionBlock = {
    kind: "scale",
    name: "api",
    namespace: "default",
    replicas: 3,
  };
  const spawns: Array<{ bin: string; args: string[] }> = [];
  const spawnFn = (bin: string, args: string[]) => {
    spawns.push({ bin, args });
    return fakeProc();
  };
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, spawnFn as any);
  mgr.run({ id: "s1", action });

  expect(spawns[0]!.args).toEqual(buildKubectlArgs(null, buildCommand(action)));
});

// ---------------------------------------------------------------------------
// streaming tests
// ---------------------------------------------------------------------------
test("stdout lines are emitted as action.progress frames with the correct id", async () => {
  const proc = fakeProc();
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, (() => proc) as any);
  mgr.run({ id: "p1", action: { kind: "restart", name: "app", namespace: "default" } });

  proc.stdout.write("line one\nline two\n");
  await new Promise((r) => setImmediate(r));

  const frames = ws.sent.filter((m) => m.type === "action.progress" && m.id === "p1");
  expect(frames.map((f: any) => f.line)).toEqual(["line one", "line two"]);
});

test("stderr lines are also emitted as action.progress frames", async () => {
  const proc = fakeProc();
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, (() => proc) as any);
  mgr.run({ id: "e1", action: { kind: "restart", name: "app", namespace: "default" } });

  proc.stderr.write("Warning: something\n");
  await new Promise((r) => setImmediate(r));

  expect(ws.sent.find((m: any) => m.type === "action.progress" && m.line === "Warning: something")).toBeTruthy();
});

test("partial lines are buffered until a newline arrives", async () => {
  const proc = fakeProc();
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, (() => proc) as any);
  mgr.run({ id: "buf", action: { kind: "restart", name: "app", namespace: "default" } });

  proc.stdout.write("partial");
  await new Promise((r) => setImmediate(r));
  expect(ws.sent.filter((m: any) => m.type === "action.progress")).toHaveLength(0);

  proc.stdout.write(" line\n");
  await new Promise((r) => setImmediate(r));
  expect(ws.sent.find((m: any) => m.line === "partial line")).toBeTruthy();
});

// ---------------------------------------------------------------------------
// done / error
// ---------------------------------------------------------------------------
test("process exit code 0 emits action.done with code 0", async () => {
  const proc = fakeProc();
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, (() => proc) as any);
  mgr.run({ id: "done0", action: { kind: "restart", name: "app", namespace: "default" } });

  proc.emit("close", 0);
  await new Promise((r) => setImmediate(r));

  expect(ws.sent.find((m: any) => m.type === "action.done" && m.id === "done0" && m.code === 0)).toBeTruthy();
});

test("non-zero exit emits action.done with the exit code", async () => {
  const proc = fakeProc();
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, (() => proc) as any);
  mgr.run({ id: "fail1", action: { kind: "restart", name: "app", namespace: "default" } });

  proc.emit("close", 1);
  await new Promise((r) => setImmediate(r));

  expect(ws.sent.find((m: any) => m.type === "action.done" && m.id === "fail1" && m.code === 1)).toBeTruthy();
});

test("spawn error (ENOENT) emits action.error", async () => {
  const proc = fakeProc();
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, (() => proc) as any);
  mgr.run({ id: "spawnErr", action: { kind: "restart", name: "app", namespace: "default" } });

  proc.emit("error", new Error("spawn kubectl ENOENT"));
  await new Promise((r) => setImmediate(r));

  expect(ws.sent.find((m: any) => m.type === "action.error" && m.id === "spawnErr")).toBeTruthy();
});

// ---------------------------------------------------------------------------
// guard tests — disallowed / unsupported action kinds
// ---------------------------------------------------------------------------
test("purge kind emits action.error without spawning", () => {
  const spawnFn = vi.fn();
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, spawnFn as any);
  mgr.run({ id: "purge1", action: { kind: "purge", name: "my-app" } });

  expect(spawnFn).not.toHaveBeenCalled();
  expect(ws.sent.find((m: any) => m.type === "action.error" && m.id === "purge1")).toBeTruthy();
});

test("applyManifest kind emits action.error without spawning", () => {
  const spawnFn = vi.fn();
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, spawnFn as any);
  mgr.run({ id: "am1", action: { kind: "applyManifest", manifest: "apiVersion: v1" } });

  expect(spawnFn).not.toHaveBeenCalled();
  expect(ws.sent.find((m: any) => m.type === "action.error" && m.id === "am1")).toBeTruthy();
});

test("unknown action kind emits action.error without spawning", () => {
  const spawnFn = vi.fn();
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, spawnFn as any);
  mgr.run({ id: "unk1", action: { kind: "notARealKind" } });

  expect(spawnFn).not.toHaveBeenCalled();
  expect(ws.sent.find((m: any) => m.type === "action.error" && m.id === "unk1")).toBeTruthy();
});

// ---------------------------------------------------------------------------
// multiple concurrent runs on the same connection
// ---------------------------------------------------------------------------
test("multiple concurrent runs on the same manager are independent", async () => {
  const procA = fakeProc();
  const procB = fakeProc();
  const procs = [procA, procB];
  let i = 0;
  const spawnFn = () => procs[i++]!;
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, spawnFn as any);

  mgr.run({ id: "a", action: { kind: "restart", name: "alpha", namespace: "ns" } });
  mgr.run({ id: "b", action: { kind: "restart", name: "beta", namespace: "ns" } });

  procA.stdout.write("from A\n");
  procB.stdout.write("from B\n");
  await new Promise((r) => setImmediate(r));

  const aFrames = ws.sent.filter((m: any) => m.type === "action.progress" && m.id === "a");
  const bFrames = ws.sent.filter((m: any) => m.type === "action.progress" && m.id === "b");
  expect(aFrames.map((f: any) => f.line)).toEqual(["from A"]);
  expect(bFrames.map((f: any) => f.line)).toEqual(["from B"]);
});

// ---------------------------------------------------------------------------
// stop() kills all in-flight processes
// ---------------------------------------------------------------------------
test("stop() kills all in-flight processes", async () => {
  const procA = fakeProc();
  const procB = fakeProc();
  const procs = [procA, procB];
  let i = 0;
  const spawnFn = () => procs[i++]!;
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, spawnFn as any);

  mgr.run({ id: "x", action: { kind: "restart", name: "alpha", namespace: "ns" } });
  mgr.run({ id: "y", action: { kind: "restart", name: "beta", namespace: "ns" } });

  mgr.stop();
  expect(procA.kill).toHaveBeenCalled();
  expect(procB.kill).toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// robustness: trailing partial line flush, duplicate id, malformed action
// ---------------------------------------------------------------------------
test("a final line with no trailing newline is flushed on stream end", async () => {
  const proc = fakeProc();
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, (() => proc) as any);
  mgr.run({ id: "flush", action: { kind: "pause", name: "app", namespace: "default" } });

  proc.stdout.write("deployment.apps/app paused"); // no trailing \n
  proc.stdout.end();
  await new Promise((r) => setImmediate(r));

  expect(
    ws.sent.find((m: any) => m.type === "action.progress" && m.id === "flush" && m.line === "deployment.apps/app paused"),
  ).toBeTruthy();
});

test("a duplicate in-flight id is rejected without killing or overwriting the first run", () => {
  const procA = fakeProc();
  const procB = fakeProc();
  const procs = [procA, procB];
  let i = 0;
  const spawnFn = vi.fn(() => procs[i++]!);
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, spawnFn as any);

  mgr.run({ id: "dup", action: { kind: "restart", name: "app", namespace: "ns" } });
  mgr.run({ id: "dup", action: { kind: "restart", name: "app", namespace: "ns" } });

  // Only the first run spawned; the second was rejected.
  expect(spawnFn).toHaveBeenCalledTimes(1);
  expect(procA.kill).not.toHaveBeenCalled();
  expect(ws.sent.find((m: any) => m.type === "action.error" && m.id === "dup" && /already in progress/i.test(m.message))).toBeTruthy();

  // The first run is still tracked — its close still emits action.done.
  procA.emit("close", 0);
  return new Promise((r) => setImmediate(r)).then(() => {
    expect(ws.sent.find((m: any) => m.type === "action.done" && m.id === "dup")).toBeTruthy();
  });
});

test("a missing/undefined action emits action.error without spawning", () => {
  const spawnFn = vi.fn();
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, spawnFn as any);
  mgr.run({ id: "bad1", action: undefined as any });

  expect(spawnFn).not.toHaveBeenCalled();
  expect(ws.sent.find((m: any) => m.type === "action.error" && m.id === "bad1")).toBeTruthy();
});

test("an action with no kind emits action.error without spawning", () => {
  const spawnFn = vi.fn();
  const ws = fakeWs();
  const mgr = new ActionRunManager(ws as any, null, spawnFn as any);
  mgr.run({ id: "bad2", action: {} as any });

  expect(spawnFn).not.toHaveBeenCalled();
  expect(ws.sent.find((m: any) => m.type === "action.error" && m.id === "bad2")).toBeTruthy();
});
