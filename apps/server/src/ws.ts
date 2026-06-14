import type { ServerWebSocket } from "bun";
import { WatchManager } from "./watchManager";
import type { WatchEvent } from "@helmsman/k8s/src/watch";
import { runClaude } from "./claudeBridge";
import { LogStreamManager, type LogTarget } from "./logStream";

export function makeWsHandlers(mgr: WatchManager, context: string | null = null) {
  const unsubs = new WeakMap<ServerWebSocket<any>, Map<string, () => void>>();
  // One kubectl-logs stream manager per connection — killed on logs.stop/close.
  const logStreams = new WeakMap<ServerWebSocket<any>, LogStreamManager>();
  // Abort handle for the in-flight chat turn — aborted on Stop/new-turn/close.
  const chatAborts = new WeakMap<ServerWebSocket<any>, AbortController>();
  return {
    open(ws: ServerWebSocket<any>) {
      unsubs.set(ws, new Map());
      logStreams.set(ws, new LogStreamManager(ws, context));
    },
    close(ws: ServerWebSocket<any>) {
      unsubs.get(ws)?.forEach((u) => u());
      logStreams.get(ws)?.stop();
      chatAborts.get(ws)?.abort();
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
        // A new turn supersedes any in-flight one.
        chatAborts.get(ws)?.abort();
        const ac = new AbortController();
        chatAborts.set(ws, ac);
        const model = typeof m.model === "string" ? m.model : undefined;
        const effort = typeof m.effort === "string" ? m.effort : undefined;
        // Resume the prior session so the turn keeps conversation history. The
        // client owns the id (from the `session` event); the server stays stateless.
        const sessionId = typeof m.sessionId === "string" ? m.sessionId : undefined;
        (async () => {
          try {
            for await (const event of runClaude(m.prompt, context, ac.signal, { model, effort, sessionId })) {
              ws.send(JSON.stringify({ type: "chat", event }));
            }
          } catch {
            /* connection/stream torn down */
          }
        })();
      } else if (m.type === "chat-interrupt") {
        // Stop button: kill the running claude subprocess for this connection.
        chatAborts.get(ws)?.abort();
      }
    },
  };
}
