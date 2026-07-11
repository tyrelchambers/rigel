import { test, expect, vi } from "vitest";
import { makeWsHandlers } from "./ws";
import { LogStreamManager } from "./logStream";
import { ActionRunManager } from "./actionRunManager";

const runAgentMock = vi.fn(async function* (..._args: unknown[]) {
  yield { type: "done" } as any;
});
vi.mock("./runAgent", () => ({ runAgent: (...args: unknown[]) => runAgentMock(...args) }));

// A minimal fake WatchManager that records the Sub it was asked to subscribe and
// lets the test drive the snapshot callback. unsubscribe is a spy.
function fakeMgr() {
  const subs: any[] = [];
  const unsub = vi.fn();
  return {
    subs,
    unsub,
    subscribe(sub: any, onSnapshot: (i: any[]) => void, onDelta: (e: any) => void, onError?: (e: any) => void) {
      subs.push({ sub, onSnapshot, onDelta, onError });
      return unsub;
    },
  };
}

// A fake ws that records every JSON message sent.
function fakeWs() {
  const sent: any[] = [];
  return { sent, readyState: 1, OPEN: 1, send: (raw: string) => sent.push(JSON.parse(raw)) } as any;
}

// Flush the microtask queue so the async (lazy per-context discovery) path settles.
const flush = () => new Promise((r) => setTimeout(r, 0));

test("subscribe defaults the context to the connection context and echoes it in the snapshot", () => {
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "boot-ctx");
  const ws = fakeWs();
  handlers.open(ws);

  handlers.message(ws, JSON.stringify({ type: "subscribe", kind: "pods", namespace: "default" }));

  expect(mgr.subs[0].sub).toEqual({ context: "boot-ctx", kind: "pods", namespace: "default" });

  // Drive a snapshot — it must echo the context back to the client.
  mgr.subs[0].onSnapshot([{ metadata: { name: "a" } }]);
  expect(ws.sent.find((f: any) => f.type === "snapshot")).toMatchObject({
    type: "snapshot",
    context: "boot-ctx",
    kind: "pods",
    namespace: "default",
  });
});

test("subscribe uses an explicit context when provided, and keys by it (no dedupe across contexts)", async () => {
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "boot-ctx");
  const ws = fakeWs();
  handlers.open(ws);

  handlers.message(ws, JSON.stringify({ type: "subscribe", context: "ctx-a", kind: "pods", namespace: "default" }));
  handlers.message(ws, JSON.stringify({ type: "subscribe", context: "ctx-b", kind: "pods", namespace: "default" }));
  await flush();

  expect(mgr.subs.map((s) => s.sub.context)).toEqual(["ctx-a", "ctx-b"]);
});

test("delta frames echo the context, event, and object", async () => {
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "boot-ctx");
  const ws = fakeWs();
  handlers.open(ws);

  handlers.message(ws, JSON.stringify({ type: "subscribe", context: "ctx-a", kind: "pods", namespace: "default" }));
  await flush();

  // Drive a delta through the captured callback — the frame must echo the context.
  mgr.subs[0].onDelta({ type: "ADDED", object: { metadata: { name: "p1" } } });
  expect(ws.sent.find((f: any) => f.type === "delta")).toMatchObject({
    type: "delta",
    context: "ctx-a",
    kind: "pods",
    namespace: "default",
    event: "ADDED",
    object: { metadata: { name: "p1" } },
  });
});

test("unsubscribe with a context tears down that subscription and frees the key", async () => {
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "boot-ctx");
  const ws = fakeWs();
  handlers.open(ws);

  handlers.message(ws, JSON.stringify({ type: "subscribe", context: "ctx-a", kind: "pods", namespace: "default" }));
  await flush();
  handlers.message(ws, JSON.stringify({ type: "unsubscribe", context: "ctx-a", kind: "pods", namespace: "default" }));
  expect(mgr.unsub).toHaveBeenCalledTimes(1);

  // The key was freed: re-subscribing the same key registers a NEW subscription
  // (not skipped by the `if (map.has(key)) return` dedupe guard).
  handlers.message(ws, JSON.stringify({ type: "subscribe", context: "ctx-a", kind: "pods", namespace: "default" }));
  await flush();
  expect(mgr.subs.length).toBe(2);
});

test("forwards a watch onError to the client as a kind-scoped error frame", () => {
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "boot-ctx");
  const ws = fakeWs();
  handlers.open(ws);

  handlers.message(ws, JSON.stringify({ type: "subscribe", kind: "secrets", namespace: "*" }));

  mgr.subs[0].onError({ reason: "forbidden", message: "secrets is forbidden" });
  expect(ws.sent).toContainEqual(
    expect.objectContaining({ type: "error", kind: "secrets", reason: "forbidden" }),
  );
});

test("fans out a wildcard subscribe to one watch per accessible namespace in scoped mode", () => {
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "ctx");
  const ws = fakeWs();
  handlers.open(ws, { mode: "scoped", namespaces: ["team-a", "team-b"] });

  handlers.message(ws, JSON.stringify({ type: "subscribe", kind: "pods", namespace: "*" }));

  expect(mgr.subs.map((s) => s.sub.namespace).sort()).toEqual(["team-a", "team-b"]);
});

test("keeps a single cluster-wide watch in cluster-wide mode (default)", () => {
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "ctx");
  const ws = fakeWs();
  handlers.open(ws);

  handlers.message(ws, JSON.stringify({ type: "subscribe", kind: "pods", namespace: "*" }));

  expect(mgr.subs.map((s) => s.sub.namespace)).toEqual(["*"]);
});

test("settles a zero-target scoped subscribe with a single empty snapshot and spawns no watches", () => {
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "ctx");
  const ws = fakeWs();
  handlers.open(ws, { mode: "scoped", namespaces: [] });

  handlers.message(ws, JSON.stringify({ type: "subscribe", kind: "pods", namespace: "*" }));

  expect(mgr.subs.length).toBe(0);
  const snapshots = ws.sent.filter((f: any) => f.type === "snapshot");
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({ type: "snapshot", kind: "pods", namespace: "*", items: [] });
});

test("tears down all fanned-out watches on unsubscribe", () => {
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "ctx");
  const ws = fakeWs();
  handlers.open(ws, { mode: "scoped", namespaces: ["team-a", "team-b"] });

  handlers.message(ws, JSON.stringify({ type: "subscribe", kind: "pods", namespace: "*" }));
  handlers.message(ws, JSON.stringify({ type: "unsubscribe", kind: "pods", namespace: "*" }));

  expect(mgr.unsub).toHaveBeenCalledTimes(2);
});

test("sends an access frame on open reflecting the passed access", () => {
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "ctx");
  const ws = fakeWs();
  handlers.open(ws, { mode: "scoped", namespaces: ["team-a"] });

  expect(ws.sent).toContainEqual({ type: "access", context: "ctx", mode: "scoped", namespaces: ["team-a"] });
});

test("sends a cluster-wide access frame on open when no access is passed", () => {
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "ctx");
  const ws = fakeWs();
  handlers.open(ws);

  expect(ws.sent).toContainEqual({ type: "access", context: "ctx", mode: "cluster-wide", namespaces: [] });
});

test("subscribing to a new context lazily discovers its access and fans out over that scope", async () => {
  const mgr = fakeMgr();
  const accessFor = vi.fn(async (ctx: string | null) =>
    ctx === "other-ctx"
      ? ({ mode: "scoped", namespaces: ["team-x"] } as const)
      : ({ mode: "cluster-wide", namespaces: [] } as const),
  );
  const handlers = makeWsHandlers(mgr as any, "boot-ctx", "", accessFor as any);
  const ws = fakeWs();
  handlers.open(ws, { mode: "cluster-wide", namespaces: [] });

  handlers.message(ws, JSON.stringify({ type: "subscribe", context: "other-ctx", kind: "pods", namespace: "*" }));

  // The boot context is cached, so this new context goes through the async path.
  expect(mgr.subs.length).toBe(0);
  await flush();

  expect(accessFor).toHaveBeenCalledWith("other-ctx");
  expect(mgr.subs.map((s) => s.sub).sort((a, b) => a.namespace.localeCompare(b.namespace))).toEqual([
    { context: "other-ctx", kind: "pods", namespace: "team-x" },
  ]);
  expect(ws.sent).toContainEqual({ type: "access", context: "other-ctx", mode: "scoped", namespaces: ["team-x"] });
});

test("a subscribe/unsubscribe/subscribe race on an undiscovered context fans out exactly once", async () => {
  const mgr = fakeMgr();
  const accessFor = vi.fn(async () => ({ mode: "cluster-wide", namespaces: [] } as const));
  const handlers = makeWsHandlers(mgr as any, "boot-ctx", "", accessFor as any);
  const ws = fakeWs();
  handlers.open(ws, { mode: "cluster-wide", namespaces: [] });

  const sub = JSON.stringify({ type: "subscribe", context: "ctx-b", kind: "pods", namespace: "default" });
  const unsub = JSON.stringify({ type: "unsubscribe", context: "ctx-b", kind: "pods", namespace: "default" });
  handlers.message(ws, sub);
  handlers.message(ws, unsub);
  handlers.message(ws, sub);
  await flush();

  // Both pending discoveries resolve, but only the current placeholder's proceeds.
  expect(mgr.subs.length).toBe(1);
});

test("closing during discovery bails the pending fan-out instead of watching a dead socket", async () => {
  const mgr = fakeMgr();
  const accessFor = vi.fn(async () => ({ mode: "cluster-wide", namespaces: [] } as const));
  const handlers = makeWsHandlers(mgr as any, "boot-ctx", "", accessFor as any);
  const ws = fakeWs();
  handlers.open(ws, { mode: "cluster-wide", namespaces: [] });

  handlers.message(ws, JSON.stringify({ type: "subscribe", context: "ctx-b", kind: "pods", namespace: "default" }));
  handlers.close(ws);
  await flush();

  expect(mgr.subs.length).toBe(0);
});

test("logs.start with an explicit context calls the log manager's start with it, not the boot context", () => {
  const startSpy = vi.spyOn(LogStreamManager.prototype, "start").mockImplementation(() => {});
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "boot-ctx");
  const ws = fakeWs();
  handlers.open(ws);

  const targets = [{ namespace: "default", labelSelector: "app=web" }];
  handlers.message(
    ws,
    JSON.stringify({ type: "logs.start", targets, tailLines: 50, context: "ctx-b" }),
  );

  expect(startSpy).toHaveBeenCalledWith(targets, 50, "ctx-b");
  startSpy.mockRestore();
});

test("logs.start without a context falls back to the connection's boot context", () => {
  const startSpy = vi.spyOn(LogStreamManager.prototype, "start").mockImplementation(() => {});
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "boot-ctx");
  const ws = fakeWs();
  handlers.open(ws);

  const targets = [{ namespace: "default", labelSelector: "app=web" }];
  handlers.message(ws, JSON.stringify({ type: "logs.start", targets, tailLines: 50 }));

  expect(startSpy).toHaveBeenCalledWith(targets, 50, "boot-ctx");
  startSpy.mockRestore();
});

test("action.run with an explicit context passes it through to the action manager", () => {
  const runSpy = vi.spyOn(ActionRunManager.prototype, "run").mockImplementation(() => {});
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "boot-ctx");
  const ws = fakeWs();
  handlers.open(ws);

  const action = { kind: "restart", name: "my-app", namespace: "default" };
  handlers.message(ws, JSON.stringify({ type: "action.run", id: "r1", action, context: "ctx-b" }));

  expect(runSpy).toHaveBeenCalledWith({ id: "r1", action, context: "ctx-b" });
  runSpy.mockRestore();
});

test("action.run without a context falls back to the connection's boot context", () => {
  const runSpy = vi.spyOn(ActionRunManager.prototype, "run").mockImplementation(() => {});
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "boot-ctx");
  const ws = fakeWs();
  handlers.open(ws);

  const action = { kind: "restart", name: "my-app", namespace: "default" };
  handlers.message(ws, JSON.stringify({ type: "action.run", id: "r1", action }));

  expect(runSpy).toHaveBeenCalledWith({ id: "r1", action, context: "boot-ctx" });
  runSpy.mockRestore();
});

test("chat with an explicit context feeds it to runAgent instead of the boot context", () => {
  runAgentMock.mockClear();
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "boot-ctx");
  const ws = fakeWs();
  handlers.open(ws);

  handlers.message(ws, JSON.stringify({ type: "chat", prompt: "hi", context: "ctx-b" }));

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const [prompt, ctxArg] = runAgentMock.mock.calls[0]!;
  expect(prompt).toBe("hi");
  expect(ctxArg).toBe("ctx-b");
});

test("chat without a context falls back to the connection's boot context", () => {
  runAgentMock.mockClear();
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "boot-ctx");
  const ws = fakeWs();
  handlers.open(ws);

  handlers.message(ws, JSON.stringify({ type: "chat", prompt: "hi" }));

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const [, ctxArg] = runAgentMock.mock.calls[0]!;
  expect(ctxArg).toBe("boot-ctx");
});
