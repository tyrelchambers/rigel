/**
 * Tests that logs.start, action.run, and chat frames follow the rail's active
 * cluster context, same as subscribe/unsubscribe: `context` is stamped onto
 * the frame when the module-level `currentContext` is set (via initContext /
 * switchCluster), and omitted when it is still null (boot-context fallback).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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

vi.stubGlobal("WebSocket", MockWebSocket);
vi.stubGlobal("location", { host: "localhost:8787" });

import { connectCluster, initContext, switchCluster, runAction, sendLogsStart, sendChat } from "./ws";
import type { ActionBlock } from "@/lib/api";

const testAction: ActionBlock = { kind: "scale", name: "my-deploy", namespace: "default", replicas: 2 };

beforeEach(() => {
  connectCluster();
  mockWs.sent = [];
});

describe("context stamping before the rail resolves an active context", () => {
  it("omits context on logs.start, action.run, and chat frames", () => {
    sendLogsStart([{ namespace: "default", labelSelector: "app=web" }], 100);
    runAction("run-1", testAction);
    sendChat("hi");

    for (const raw of mockWs.sent) {
      expect(JSON.parse(raw)).not.toHaveProperty("context");
    }
    expect(mockWs.sent).toHaveLength(3);
  });
});

describe("context stamping once the rail resolves an active context", () => {
  it("stamps context on logs.start, action.run, and chat frames after initContext", () => {
    initContext("ctx-a");
    mockWs.sent = [];

    sendLogsStart([{ namespace: "default", labelSelector: "app=web" }], 100);
    runAction("run-2", testAction);
    sendChat("hi again");

    const frames = mockWs.sent.map((s) => JSON.parse(s));
    expect(frames[0]).toMatchObject({ type: "logs.start", context: "ctx-a" });
    expect(frames[1]).toMatchObject({ type: "action.run", context: "ctx-a" });
    expect(frames[2]).toMatchObject({ type: "chat", context: "ctx-a" });
  });

  it("stamps the NEW context after switchCluster", () => {
    switchCluster("ctx-b");
    mockWs.sent = [];

    sendLogsStart([{ namespace: "default", labelSelector: "app=web" }], 100);
    runAction("run-3", testAction);
    sendChat("hi once more");

    const frames = mockWs.sent.map((s) => JSON.parse(s));
    expect(frames[0]).toMatchObject({ type: "logs.start", context: "ctx-b" });
    expect(frames[1]).toMatchObject({ type: "action.run", context: "ctx-b" });
    expect(frames[2]).toMatchObject({ type: "chat", context: "ctx-b" });
  });
});
