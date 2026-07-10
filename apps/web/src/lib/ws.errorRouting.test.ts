/**
 * Tests for error-frame routing in the WS message handler: a `kind`-scoped
 * error (watch access failure) goes to store.setAccess; a kind-less error
 * (e.g. a chat failure) goes to store.setError.
 *
 * Harness matches ws.actionEvents.test.ts: mock the Zustand store + a minimal
 * MockWebSocket, then drive onmessage directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({
  setConnected: vi.fn(),
  setError: vi.fn(),
  setLoading: vi.fn(),
  setAccess: vi.fn(),
  clearKind: vi.fn(),
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

import { connectCluster } from "./ws";

beforeEach(() => {
  store.setConnected.mockClear();
  store.setError.mockClear();
  store.setLoading.mockClear();
  store.setAccess.mockClear();
  store.clearKind.mockClear();
  connectCluster();
});

describe("error frame routing", () => {
  it("routes a kind-scoped forbidden error into store.setAccess", () => {
    mockWs.onmessage!({
      data: JSON.stringify({ type: "error", kind: "secrets", namespace: "default", reason: "forbidden", message: "denied" }),
    });

    expect(store.setAccess).toHaveBeenCalledWith("secrets", { status: "forbidden", message: "denied" });
    expect(store.clearKind).toHaveBeenCalledWith("secrets");
    expect(store.setError).not.toHaveBeenCalled();
  });

  it("routes a kind-scoped non-forbidden error into store.setAccess with status error and does not clear the slice", () => {
    mockWs.onmessage!({
      data: JSON.stringify({ type: "error", kind: "pods", reason: "timeout", message: "watch failed" }),
    });

    expect(store.setAccess).toHaveBeenCalledWith("pods", { status: "error", message: "watch failed" });
    expect(store.clearKind).not.toHaveBeenCalled();
    expect(store.setError).not.toHaveBeenCalled();
  });

  it("routes a kind-less error into the global store.setError", () => {
    mockWs.onmessage!({ data: JSON.stringify({ type: "error", message: "chat failed" }) });

    expect(store.setError).toHaveBeenCalledWith("chat failed");
    expect(store.setAccess).not.toHaveBeenCalled();
    expect(store.clearKind).not.toHaveBeenCalled();
  });
});
