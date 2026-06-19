import { useCluster } from "@/store/cluster";
import type { ChatEvent } from "@/panels/chat/types";
import {
  LINGER_MS,
  finishLinger,
  planSubscribe,
  planUnsubscribe,
  subKey,
  type SubRegistry,
} from "./wsSubscriptions";

let socket: WebSocket | null = null;

/**
 * Store key for a watched object: `namespace/name` for namespaced resources,
 * bare `name` for cluster-scoped ones (nodes, namespaces). Namespace-qualified
 * so same-named resources in different namespaces don't clobber each other when
 * watching all namespaces.
 */
function resourceKey(o: { metadata: { name: string; namespace?: string } }): string {
  return o.metadata.namespace ? `${o.metadata.namespace}/${o.metadata.name}` : o.metadata.name;
}

/** Raw frames queued while the socket is still CONNECTING; flushed on open. */
const pendingFrames: string[] = [];
/** Ref-counted watch subscriptions, keyed by `${kind}/${namespace}`. Re-sent on
 *  every (re)connect so first-load panels (which mount before the socket is
 *  OPEN) and reconnects get their data. Entries linger briefly after their last
 *  unsubscribe so a tab switch can reuse the warm watch (see wsSubscriptions). */
const activeSubs: SubRegistry = new Map();

/** Send a subscribe/unsubscribe control frame if the socket is OPEN. Unlike
 *  rawSend these are not buffered: the onopen re-send loop replays active subs,
 *  and a lingering teardown that misses the window is harmless. */
function sendSubFrame(type: "subscribe" | "unsubscribe", kind: string, namespace: string): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, kind, namespace }));
  }
}

/** Send now if the socket is OPEN, else buffer until it opens. */
function rawSend(frame: string): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(frame);
  else pendingFrames.push(frame);
}

type ChatEventCallback = (event: ChatEvent) => void;
let chatListeners: ChatEventCallback[] = [];

/** A line streamed from the server's kubectl-logs process. */
export interface LogStreamMessage {
  type: "logs" | "logs.error";
  namespace: string;
  pod?: string;
  container?: string;
  line?: string;
  message?: string; // present on logs.error
}
type LogCallback = (msg: LogStreamMessage) => void;
let logListeners: LogCallback[] = [];

/** A single log target — a deployment (labelSelector) or a single pod. */
export interface LogTarget {
  namespace: string;
  labelSelector?: string;
  pod?: string;
  container?: string;
  previous?: boolean;
  since?: string;
}

/** Start streaming logs for the given targets. {type:"logs.start", targets, tailLines}. */
export function sendLogsStart(targets: LogTarget[], tailLines = 200): void {
  rawSend(JSON.stringify({ type: "logs.start", targets, tailLines }));
}

/** Stop all log streams for this connection. {type:"logs.stop"}. */
export function sendLogsStop(): void {
  rawSend(JSON.stringify({ type: "logs.stop" }));
}

/** Subscribe to inbound log-stream lines/errors. Returns an unsubscribe fn. */
export function onLogLine(callback: LogCallback): () => void {
  logListeners.push(callback);
  return () => {
    logListeners = logListeners.filter((c) => c !== callback);
  };
}

/**
 * Send a chat prompt to the server. {type:"chat", prompt, model?, effort?, sessionId?}.
 * Pass the prior `sessionId` (captured from the `session` event) so the turn
 * resumes the same conversation; omit it on the first turn for a fresh session.
 */
export function sendChat(
  prompt: string,
  opts?: { model?: string; effort?: string; sessionId?: string },
): void {
  rawSend(
    JSON.stringify({
      type: "chat",
      prompt,
      model: opts?.model,
      effort: opts?.effort,
      sessionId: opts?.sessionId,
    }),
  );
}

/** Request the server interrupt the current chat turn. */
export function interruptChat(): void {
  rawSend(JSON.stringify({ type: "chat-interrupt" }));
}

/** Subscribe to inbound chat events. Returns an unsubscribe fn. */
export function onChatEvent(callback: ChatEventCallback): () => void {
  chatListeners.push(callback);
  return () => {
    chatListeners = chatListeners.filter((c) => c !== callback);
  };
}

/** An event from the interactive PTY shell (Terminal panel). */
export interface TermMessage {
  type: "term";
  event: "data" | "exit" | "error";
  data?: string; // present on "data"
  code?: number; // present on "exit"
  message?: string; // present on "error"
}
type TermCallback = (msg: TermMessage) => void;
let termListeners: TermCallback[] = [];

/** Start the interactive shell at the given size. {type:"term.start", cols, rows}. */
export function sendTermStart(cols: number, rows: number): void {
  rawSend(JSON.stringify({ type: "term.start", cols, rows }));
}

/** Forward keystrokes / pasted text to the shell. {type:"term.input", data}. */
export function sendTermInput(data: string): void {
  rawSend(JSON.stringify({ type: "term.input", data }));
}

/** Propagate a terminal resize to the PTY. {type:"term.resize", cols, rows}. */
export function sendTermResize(cols: number, rows: number): void {
  rawSend(JSON.stringify({ type: "term.resize", cols, rows }));
}

/** Kill the shell for this connection. {type:"term.stop"}. */
export function sendTermStop(): void {
  rawSend(JSON.stringify({ type: "term.stop" }));
}

/** Subscribe to inbound terminal events. Returns an unsubscribe fn. */
export function onTermEvent(callback: TermCallback): () => void {
  termListeners.push(callback);
  return () => {
    termListeners = termListeners.filter((c) => c !== callback);
  };
}

export function connectCluster(): void {
  socket = new WebSocket(`ws://${location.host}/ws`);
  const store = useCluster.getState();
  socket.onopen = () => {
    store.setConnected(true);
    store.setError(null);
    // (Re)send every in-use watch subscription. Panels mount before the socket
    // opens, so their initial subscribe() calls would otherwise be lost. Skip
    // entries that are lingering with refs 0; those are on their way out.
    for (const sub of activeSubs.values()) {
      if (sub.refs > 0) {
        socket!.send(JSON.stringify({ type: "subscribe", kind: sub.kind, namespace: sub.namespace }));
      }
    }
    // Drain any chat/log frames buffered while connecting.
    while (pendingFrames.length) socket!.send(pendingFrames.shift()!);
  };
  // Clear the global loading flag on close/error too: a cold subscribe sets it
  // and only a snapshot clears it, so a socket that drops before any snapshot
  // arrives would otherwise leave every panel spinning forever.
  socket.onclose = () => {
    store.setConnected(false);
    store.setLoading(false);
  };
  socket.onerror = () => {
    store.setError("websocket connection failed");
    store.setLoading(false);
  };
  socket.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "chat" && m.event) {
      chatListeners.forEach((cb) => cb(m.event as ChatEvent));
    } else if (m.type === "logs" || m.type === "logs.error") {
      logListeners.forEach((cb) => cb(m as LogStreamMessage));
    } else if (m.type === "term") {
      termListeners.forEach((cb) => cb(m as TermMessage));
    } else if (m.type === "snapshot") {
      // Authoritative full set for this subscription: REPLACE the kind's items
      // (not merge) so switching namespace swaps the data instead of piling the
      // new namespace on top of the old one.
      store.setLoading(false);
      store.setError(null);
      const items: Record<string, unknown> = {};
      for (const o of m.items) items[resourceKey(o)] = o;
      store.replaceKind(m.kind, items);
    } else if (m.type === "delta") {
      if (m.event === "DELETED") store.remove(m.kind, resourceKey(m.object));
      else store.upsert(m.kind, resourceKey(m.object), m.object);
    } else if (m.type === "error") {
      store.setLoading(false);
      store.setError(typeof m.message === "string" ? m.message : "watch failed");
    }
  };
}

export function subscribe(kind: string, namespace = "default"): void {
  // Warm reuse (entry already exists) cancels any pending teardown, bumps the
  // ref count and sends nothing. The server is still subscribed and the store
  // still holds the data, so a tab switch is instant. Only a cold subscribe
  // (the first ref) toggles loading and sends the subscribe frame.
  const { sendSubscribe, toggleLoading, clearedTimer } = planSubscribe(activeSubs, kind, namespace);
  if (clearedTimer) clearTimeout(clearedTimer);
  if (toggleLoading) {
    const store = useCluster.getState();
    store.setLoading(true);
    store.setError(null);
  }
  // If the socket is not OPEN yet, the onopen re-send loop will send this.
  if (sendSubscribe) sendSubFrame("subscribe", kind, namespace);
}
export function unsubscribe(kind: string, namespace = "default"): void {
  // Decrement the ref count. The watch is only torn down once nothing relies on
  // it, and even then only after a linger grace period: if a subscribe arrives
  // during the linger it revives the entry and the timer below is cancelled.
  const { startLinger } = planUnsubscribe(activeSubs, kind, namespace);
  if (!startLinger) return;
  const entry = activeSubs.get(subKey(kind, namespace));
  if (!entry) return;
  entry.lingerTimer = setTimeout(() => {
    const { sendUnsubscribe } = finishLinger(activeSubs, kind, namespace);
    // Best-effort: sendSubFrame is a no-op if the socket isn't OPEN. If a
    // reconnect races the linger, this frame may be dropped, but that's safe:
    // the server releases every subscription on socket close (per-connection
    // cleanup is the source of truth), so a reconnect never strands a watch.
    if (sendUnsubscribe) sendSubFrame("unsubscribe", kind, namespace);
  }, LINGER_MS);
}
