import { useCluster } from "@/store/cluster";
import type { ChatEvent } from "@/panels/chat/types";

let socket: WebSocket | null = null;

type ChatEventCallback = (event: ChatEvent) => void;
let chatListeners: ChatEventCallback[] = [];

/** Send a chat prompt to the server. {type:"chat", prompt}. */
export function sendChat(prompt: string): void {
  socket?.send(JSON.stringify({ type: "chat", prompt }));
}

/** Request the server interrupt the current chat turn. */
export function interruptChat(): void {
  socket?.send(JSON.stringify({ type: "chat-interrupt" }));
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
  };
  socket.onclose = () => store.setConnected(false);
  socket.onerror = () => store.setError("websocket connection failed");
  socket.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "chat" && m.event) {
      chatListeners.forEach((cb) => cb(m.event as ChatEvent));
    } else if (m.type === "snapshot") {
      // First payload for this subscription: clear loading and surface items.
      store.setLoading(false);
      store.setError(null);
      for (const o of m.items) store.upsert(m.kind, o.metadata.name, o);
    } else if (m.type === "delta") {
      if (m.event === "DELETED") store.remove(m.kind, m.object.metadata.name);
      else store.upsert(m.kind, m.object.metadata.name, m.object);
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
  socket?.send(JSON.stringify({ type: "subscribe", kind, namespace }));
}
export function unsubscribe(kind: string, namespace = "default"): void {
  socket?.send(JSON.stringify({ type: "unsubscribe", kind, namespace }));
}
