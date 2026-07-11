/**
 * Tests for access-frame routing in the WS message handler: the server's
 * `access` frame (sent once on connect) records the connection's mode
 * (cluster-wide vs. scoped) and, when scoped, the accessible namespace set.
 *
 * Harness matches ws.errorRouting.test.ts / ws.snapshotRouting.test.ts: mock
 * the Zustand store + a minimal MockWebSocket, then drive onmessage directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({
  setConnected: vi.fn(),
  setError: vi.fn(),
  setLoading: vi.fn(),
  setAccess: vi.fn(),
  setContextAccess: vi.fn(),
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
      setContextAccess: store.setContextAccess,
      clearKind: store.clearKind,
      replaceKind: store.replaceKind,
      setActiveContextInitial: vi.fn(),
      applySwitch: vi.fn(),
      namespaceByContext: {},
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
  store.setContextAccess.mockClear();
  store.clearKind.mockClear();
  store.replaceKind.mockClear();
  connectCluster();
});

describe("access frame routing", () => {
  it("routes a scoped access frame into store.setContextAccess with its context and namespaces", () => {
    mockWs.onmessage!({
      data: JSON.stringify({
        type: "access",
        context: "prod",
        mode: "scoped",
        namespaces: ["team-a", "team-b"],
      }),
    });

    expect(store.setContextAccess).toHaveBeenCalledWith("prod", "scoped", ["team-a", "team-b"]);
  });

  it("routes a cluster-wide access frame into store.setContextAccess with an empty namespace list", () => {
    mockWs.onmessage!({
      data: JSON.stringify({ type: "access", context: "prod", mode: "cluster-wide", namespaces: [] }),
    });

    expect(store.setContextAccess).toHaveBeenCalledWith("prod", "cluster-wide", []);
  });

  it("defaults to an empty namespace list when the frame omits it", () => {
    mockWs.onmessage!({
      data: JSON.stringify({ type: "access", context: "prod", mode: "cluster-wide" }),
    });

    expect(store.setContextAccess).toHaveBeenCalledWith("prod", "cluster-wide", []);
  });

  it("passes null context through when the frame omits it", () => {
    mockWs.onmessage!({
      data: JSON.stringify({ type: "access", mode: "cluster-wide", namespaces: [] }),
    });

    expect(store.setContextAccess).toHaveBeenCalledWith(null, "cluster-wide", []);
  });
});
