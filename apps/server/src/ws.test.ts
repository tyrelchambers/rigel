import { test, expect, vi } from "vitest";
import { makeWsHandlers } from "./ws";

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
  return { sent, send: (raw: string) => sent.push(JSON.parse(raw)) } as any;
}

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

test("subscribe uses an explicit context when provided, and keys by it (no dedupe across contexts)", () => {
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "boot-ctx");
  const ws = fakeWs();
  handlers.open(ws);

  handlers.message(ws, JSON.stringify({ type: "subscribe", context: "ctx-a", kind: "pods", namespace: "default" }));
  handlers.message(ws, JSON.stringify({ type: "subscribe", context: "ctx-b", kind: "pods", namespace: "default" }));

  expect(mgr.subs.map((s) => s.sub.context)).toEqual(["ctx-a", "ctx-b"]);
});

test("delta frames echo the context, event, and object", () => {
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "boot-ctx");
  const ws = fakeWs();
  handlers.open(ws);

  handlers.message(ws, JSON.stringify({ type: "subscribe", context: "ctx-a", kind: "pods", namespace: "default" }));

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

test("unsubscribe with a context tears down that subscription and frees the key", () => {
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "boot-ctx");
  const ws = fakeWs();
  handlers.open(ws);

  handlers.message(ws, JSON.stringify({ type: "subscribe", context: "ctx-a", kind: "pods", namespace: "default" }));
  handlers.message(ws, JSON.stringify({ type: "unsubscribe", context: "ctx-a", kind: "pods", namespace: "default" }));
  expect(mgr.unsub).toHaveBeenCalledTimes(1);

  // The key was freed: re-subscribing the same key registers a NEW subscription
  // (not skipped by the `if (map.has(key)) return` dedupe guard).
  handlers.message(ws, JSON.stringify({ type: "subscribe", context: "ctx-a", kind: "pods", namespace: "default" }));
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

  expect(ws.sent).toContainEqual({ type: "access", mode: "scoped", namespaces: ["team-a"] });
});

test("sends a cluster-wide access frame on open when no access is passed", () => {
  const mgr = fakeMgr();
  const handlers = makeWsHandlers(mgr as any, "ctx");
  const ws = fakeWs();
  handlers.open(ws);

  expect(ws.sent).toContainEqual({ type: "access", mode: "cluster-wide", namespaces: [] });
});
