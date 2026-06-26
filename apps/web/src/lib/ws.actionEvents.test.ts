/**
 * Tests for action-run WS plumbing: onActionEvent, runAction.
 *
 * ws.ts has module-level state (socket, listeners). We mock the Zustand store
 * and WebSocket global so we can import the module in node env, then test:
 *   - onActionEvent(id, cb) receives frames for that id only
 *   - unsubscribe stops delivery
 *   - runAction(id, action) sends the correct frame on the socket
 *
 * Routing is exercised by calling connectCluster() with a mock WebSocket so we
 * can trigger the onmessage handler directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock useCluster (Zustand store) — ws.ts calls it from connectCluster.
vi.mock("@/store/cluster", () => ({
  useCluster: {
    getState: () => ({
      setConnected: vi.fn(),
      setError: vi.fn(),
      setLoading: vi.fn(),
      setActiveContextInitial: vi.fn(),
      applySwitch: vi.fn(),
      namespaceByContext: {},
      replaceKind: vi.fn(),
      upsert: vi.fn(),
      remove: vi.fn(),
    }),
  },
}));

// A minimal mock WebSocket that captures sent frames and exposes onmessage.
// A minimal mock WebSocket that captures sent frames and exposes onmessage.
// connectCluster() instantiates it via the stubbed global; the constructor
// stores the latest instance in `mockWs` so tests can drive onmessage/onopen.
class MockWebSocket {
  readyState = 1; // OPEN
  static OPEN = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor() {
    mockWs = this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
}

let mockWs: MockWebSocket;

// Patch globalThis.WebSocket so connectCluster uses our mock.
vi.stubGlobal("WebSocket", MockWebSocket);

// Also stub location.host (used by connectCluster).
vi.stubGlobal("location", { host: "localhost:8787" });

import { connectCluster, onActionEvent, runAction, type ActionEvent } from "./ws";
import type { ActionBlock } from "@/lib/api";

const testAction: ActionBlock = { kind: "scale", name: "my-deploy", namespace: "default", replicas: 2 };

beforeEach(() => {
  // Re-connect each test to reset the socket reference and flush any lingering state.
  connectCluster();
});

describe("onActionEvent / routing", () => {
  it("delivers action.progress to a subscriber with the matching id", () => {
    const received: ActionEvent[] = [];
    const unsub = onActionEvent("run-1", (e) => received.push(e));

    mockWs.onmessage!({ data: JSON.stringify({ type: "action.progress", id: "run-1", line: "hello" }) });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "action.progress", id: "run-1", line: "hello" });
    unsub();
  });

  it("delivers action.done to a subscriber with the matching id", () => {
    const received: ActionEvent[] = [];
    const unsub = onActionEvent("run-1", (e) => received.push(e));

    mockWs.onmessage!({ data: JSON.stringify({ type: "action.done", id: "run-1", code: 0 }) });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "action.done", id: "run-1", code: 0 });
    unsub();
  });

  it("delivers action.error to a subscriber with the matching id", () => {
    const received: ActionEvent[] = [];
    const unsub = onActionEvent("run-1", (e) => received.push(e));

    mockWs.onmessage!({ data: JSON.stringify({ type: "action.error", id: "run-1", message: "bad action" }) });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "action.error", id: "run-1", message: "bad action" });
    unsub();
  });

  it("does NOT deliver frames for a different id", () => {
    const received: ActionEvent[] = [];
    const unsub = onActionEvent("run-1", (e) => received.push(e));

    mockWs.onmessage!({ data: JSON.stringify({ type: "action.progress", id: "run-2", line: "other run" }) });

    expect(received).toHaveLength(0);
    unsub();
  });

  it("concurrent runs stay isolated — each subscriber only sees its own id", () => {
    const run1: ActionEvent[] = [];
    const run2: ActionEvent[] = [];
    const unsub1 = onActionEvent("run-1", (e) => run1.push(e));
    const unsub2 = onActionEvent("run-2", (e) => run2.push(e));

    mockWs.onmessage!({ data: JSON.stringify({ type: "action.progress", id: "run-1", line: "a" }) });
    mockWs.onmessage!({ data: JSON.stringify({ type: "action.progress", id: "run-2", line: "b" }) });
    mockWs.onmessage!({ data: JSON.stringify({ type: "action.done", id: "run-1", code: 0 }) });

    expect(run1).toHaveLength(2);
    expect(run2).toHaveLength(1);
    expect(run1[0]).toMatchObject({ type: "action.progress", line: "a" });
    expect(run2[0]).toMatchObject({ type: "action.progress", line: "b" });
    unsub1();
    unsub2();
  });

  it("unsubscribe stops delivery of subsequent frames", () => {
    const received: ActionEvent[] = [];
    const unsub = onActionEvent("run-1", (e) => received.push(e));

    mockWs.onmessage!({ data: JSON.stringify({ type: "action.progress", id: "run-1", line: "before" }) });
    unsub();
    mockWs.onmessage!({ data: JSON.stringify({ type: "action.progress", id: "run-1", line: "after" }) });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ line: "before" });
  });
});

describe("runAction", () => {
  it("sends an action.run frame with the given id and action on the socket", () => {
    mockWs.sent = [];
    runAction("run-42", testAction);

    expect(mockWs.sent).toHaveLength(1);
    const frame = JSON.parse(mockWs.sent[0]!);
    expect(frame).toEqual({ type: "action.run", id: "run-42", action: testAction });
  });

  it("buffers the frame if the socket is not yet OPEN and sends it on connect", () => {
    // Simulate a socket in CONNECTING state (readyState 0).
    mockWs.readyState = 0;
    mockWs.sent = [];

    runAction("run-buf", testAction);

    // Nothing sent yet.
    expect(mockWs.sent).toHaveLength(0);

    // Now flip to OPEN and fire onopen (the rawSend drain loop).
    mockWs.readyState = 1;
    mockWs.onopen?.();

    // The pending frame should have been drained.
    const actionFrames = mockWs.sent.filter((s) => {
      const parsed = JSON.parse(s);
      return parsed.type === "action.run";
    });
    expect(actionFrames).toHaveLength(1);
    expect(JSON.parse(actionFrames[0]!)).toEqual({ type: "action.run", id: "run-buf", action: testAction });
  });
});
