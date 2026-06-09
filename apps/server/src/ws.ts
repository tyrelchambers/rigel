import type { ServerWebSocket } from "bun";
import { WatchManager } from "./watchManager";
import type { WatchEvent } from "@helmsman/k8s/src/watch";

export function makeWsHandlers(mgr: WatchManager) {
  const unsubs = new WeakMap<ServerWebSocket<any>, Map<string, () => void>>();
  return {
    open(ws: ServerWebSocket<any>) {
      unsubs.set(ws, new Map());
    },
    close(ws: ServerWebSocket<any>) {
      unsubs.get(ws)?.forEach((u) => u());
    },
    message(ws: ServerWebSocket<any>, raw: string | Buffer) {
      const m = JSON.parse(String(raw));
      const map = unsubs.get(ws)!;
      if (m.type === "subscribe") {
        const key = `${m.kind}/${m.namespace}`;
        if (map.has(key)) return;
        const un = mgr.subscribe(
          { kind: m.kind, namespace: m.namespace },
          (items) =>
            ws.send(
              JSON.stringify({
                type: "snapshot",
                kind: m.kind,
                namespace: m.namespace,
                items,
              }),
            ),
          (e: WatchEvent) =>
            ws.send(
              JSON.stringify({
                type: "delta",
                kind: m.kind,
                namespace: m.namespace,
                event: e.type,
                object: e.object,
              }),
            ),
        );
        map.set(key, un);
      } else if (m.type === "unsubscribe") {
        const key = `${m.kind}/${m.namespace}`;
        map.get(key)?.();
        map.delete(key);
      }
    },
  };
}
