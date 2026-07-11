/**
 * Tests for snapshot-frame routing in the WS message handler: namespace is
 * threaded into store.replaceKind, and a successful snapshot resets the
 * kind's access state to "ok".
 *
 * Harness matches ws.errorRouting.test.ts: mock the Zustand store + a minimal
 * MockWebSocket, then drive onmessage directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({
  setConnected: vi.fn(),
  setError: vi.fn(),
  setLoading: vi.fn(),
  setAccess: vi.fn(),
  clearKind: vi.fn(),
  replaceKind: vi.fn(),
}));

vi.mock("@/store/cluster", () => ({
  useCluster: {
    getState: () => ({
      setConnected: store.setConnected,
      setError: store.setError,
      setLoading: store.setLoading,
      setAccess: store.setAccess,
      clearKind: store.clearKind,
      setActiveContextInitial: vi.fn(),
      applySwitch: vi.fn(),
      namespaceByContext: {},
      replaceKind: store.replaceKind,
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

import { connectCluster } from "./ws";

beforeEach(() => {
  store.setConnected.mockClear();
  store.setError.mockClear();
  store.setLoading.mockClear();
  store.setAccess.mockClear();
  store.clearKind.mockClear();
  store.replaceKind.mockClear();
  connectCluster();
});

const pod = { metadata: { name: "web-1", namespace: "prod" } };

describe("snapshot frame routing", () => {
  it("threads a namespaced snapshot's namespace into store.replaceKind", () => {
    mockWs.onmessage!({
      data: JSON.stringify({ type: "snapshot", kind: "pods", namespace: "prod", items: [pod] }),
    });

    expect(store.replaceKind).toHaveBeenCalledWith("pods", { "prod/web-1": pod }, "prod");
  });

  it("falls back to a cluster-wide replace when the snapshot omits namespace", () => {
    mockWs.onmessage!({
      data: JSON.stringify({ type: "snapshot", kind: "pods", items: [pod] }),
    });

    expect(store.replaceKind).toHaveBeenCalledWith("pods", { "prod/web-1": pod }, "*");
  });

  it("resets the kind's access state to ok on a successful snapshot", () => {
    mockWs.onmessage!({
      data: JSON.stringify({ type: "snapshot", kind: "pods", namespace: "prod", items: [pod] }),
    });

    expect(store.setAccess).toHaveBeenCalledWith("pods", { status: "ok" });
  });
});
