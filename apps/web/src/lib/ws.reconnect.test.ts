/**
 * Reconnect behavior for the cluster WebSocket. The socket can drop after the
 * app is idle (machine sleep, server hiccup); the client must reconnect on its
 * own instead of stranding the UI on a permanent "disconnected" state.
 *
 * Harness: a MockWebSocket records every instance the module constructs, plus
 * stable store spies (via vi.hoisted) so we can assert connected transitions.
 * Fake timers drive the backoff.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store = vi.hoisted(() => ({
  setConnected: vi.fn(),
  setError: vi.fn(),
  setLoading: vi.fn(),
}));

vi.mock("@/store/cluster", () => ({
  useCluster: {
    getState: () => ({
      setConnected: store.setConnected,
      setError: store.setError,
      setLoading: store.setLoading,
      setActiveContextInitial: () => {},
      applySwitch: () => {},
      namespaceByContext: {},
      replaceKind: () => {},
      upsert: () => {},
      remove: () => {},
    }),
  },
}));

const sockets: MockWebSocket[] = [];
class MockWebSocket {
  static OPEN = 1;
  readyState = 0; // CONNECTING until a test opens it
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor() {
    sockets.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);
vi.stubGlobal("location", { host: "localhost:8787" });

import { connectCluster } from "./ws";

/** Flip the most recently constructed socket to OPEN and fire its onopen. */
function openLast(): MockWebSocket {
  const s = sockets[sockets.length - 1]!;
  s.readyState = 1;
  s.onopen!();
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  store.setConnected.mockClear();
  store.setError.mockClear();
  store.setLoading.mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("connectCluster reconnect", () => {
  it("opens a socket and marks the store connected", () => {
    connectCluster();
    expect(sockets).toHaveLength(1);
    openLast();
    expect(store.setConnected).toHaveBeenLastCalledWith(true);
  });

  it("reconnects after the socket closes", () => {
    connectCluster();
    openLast();

    sockets[sockets.length - 1]!.onclose!();
    expect(store.setConnected).toHaveBeenLastCalledWith(false);
    expect(sockets).toHaveLength(1); // does not reconnect synchronously

    vi.advanceTimersByTime(1000); // base backoff elapses
    expect(sockets).toHaveLength(2); // a fresh socket was opened

    openLast();
    expect(store.setConnected).toHaveBeenLastCalledWith(true);
  });

  it("backs off exponentially across consecutive failures and resets on a successful open", () => {
    connectCluster();
    openLast(); // a good open resets the backoff to base

    // First drop retries after the base delay (1s).
    sockets[sockets.length - 1]!.onclose!();
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    // This attempt never opens, so the next retry must wait longer (2s).
    sockets[sockets.length - 1]!.onclose!();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2); // 1s is no longer enough
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(3); // 2s total

    // A successful open clears the backoff: the next drop retries at base again.
    openLast();
    sockets[sockets.length - 1]!.onclose!();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(4);
  });
});
