import { useCluster } from "@/store/cluster";

let socket: WebSocket | null = null;

export function connectCluster(): void {
  socket = new WebSocket(`ws://${location.host}/ws`);
  const store = useCluster.getState();
  socket.onopen = () => store.setConnected(true);
  socket.onclose = () => store.setConnected(false);
  socket.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "snapshot") for (const o of m.items) store.upsert(m.kind, o.metadata.name, o);
    else if (m.type === "delta") {
      if (m.event === "DELETED") store.remove(m.kind, m.object.metadata.name);
      else store.upsert(m.kind, m.object.metadata.name, m.object);
    }
  };
}

export function subscribe(kind: string, namespace = "default"): void {
  socket?.send(JSON.stringify({ type: "subscribe", kind, namespace }));
}
export function unsubscribe(kind: string, namespace = "default"): void {
  socket?.send(JSON.stringify({ type: "unsubscribe", kind, namespace }));
}
