import type { ServerWebSocket } from "bun";
import { WatchManager } from "./watchManager";
import type { WatchEvent } from "@helmsman/k8s/src/watch";
import { runClaude } from "./claudeBridge";
import { LogStreamManager, type LogTarget } from "./logStream";

export function makeWsHandlers(mgr: WatchManager, context: string | null = null) {
  const unsubs = new WeakMap<ServerWebSocket<any>, Map<string, () => void>>();
  // One kubectl-logs stream manager per connection — killed on logs.stop/close.
  const logStreams = new WeakMap<ServerWebSocket<any>, LogStreamManager>();
  return {
    open(ws: ServerWebSocket<any>) {
      unsubs.set(ws, new Map());
      logStreams.set(ws, new LogStreamManager(ws, context));
    },
    close(ws: ServerWebSocket<any>) {
      unsubs.get(ws)?.forEach((u) => u());
      logStreams.get(ws)?.stop();
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
      } else if (m.type === "logs.start" && Array.isArray(m.targets)) {
        const targets = m.targets as LogTarget[];
        const tail = typeof m.tailLines === "number" ? m.tailLines : 200;
        logStreams.get(ws)?.start(targets, tail);
      } else if (m.type === "logs.stop") {
        logStreams.get(ws)?.stop();
      } else if (m.type === "chat" && typeof m.prompt === "string") {
        (async () => {
          for await (const event of runClaude(m.prompt, context)) {
            ws.send(JSON.stringify({ type: "chat", event }));
          }
        })();
      }
    },
  };
}
