import { useCluster } from "@/store/cluster";
import type { ChatEvent } from "@/panels/chat/types";

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
/** Active watch subscriptions, re-sent on every (re)connect so first-load
 *  panels (which mount before the socket is OPEN) and reconnects get their data. */
const activeSubs = new Map<string, { kind: string; namespace: string }>();

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

/** Send a chat prompt to the server. {type:"chat", prompt, model?, effort?}. */
export function sendChat(prompt: string, opts?: { model?: string; effort?: string }): void {
  rawSend(JSON.stringify({ type: "chat", prompt, model: opts?.model, effort: opts?.effort }));
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

export function connectCluster(): void {
  socket = new WebSocket(`ws://${location.host}/ws`);
  const store = useCluster.getState();
  socket.onopen = () => {
    store.setConnected(true);
    store.setError(null);
    // (Re)send every active watch subscription — panels mount before the
    // socket opens, so their initial subscribe() calls would otherwise be lost.
    for (const sub of activeSubs.values()) {
      socket!.send(JSON.stringify({ type: "subscribe", kind: sub.kind, namespace: sub.namespace }));
    }
    // Drain any chat/log frames buffered while connecting.
    while (pendingFrames.length) socket!.send(pendingFrames.shift()!);
  };
  socket.onclose = () => store.setConnected(false);
  socket.onerror = () => store.setError("websocket connection failed");
  socket.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "chat" && m.event) {
      chatListeners.forEach((cb) => cb(m.event as ChatEvent));
    } else if (m.type === "logs" || m.type === "logs.error") {
      logListeners.forEach((cb) => cb(m as LogStreamMessage));
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
  const store = useCluster.getState();
  store.setLoading(true);
  store.setError(null);
  // Record the subscription so it is (re)sent on open/reconnect. If the socket
  // is already OPEN send immediately; otherwise the onopen flush handles it.
  activeSubs.set(`${kind}/${namespace}`, { kind, namespace });
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "subscribe", kind, namespace }));
  }
}
export function unsubscribe(kind: string, namespace = "default"): void {
  activeSubs.delete(`${kind}/${namespace}`);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "unsubscribe", kind, namespace }));
  }
}
