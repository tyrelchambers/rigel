import type { WebSocket } from "ws";
import { WatchManager } from "./watchManager";
import type { WatchEvent } from "@rigel/k8s/src/watch";
import { runAgent } from "./runAgent";
import { LogStreamManager, type LogTarget } from "./logStream";
import { TerminalSession } from "./terminal";
import { ClusterCreateManager } from "./clusterCreateManager";
import { parseChatScope, resolveReadContexts } from "./chatScope";
import { listContexts } from "./contexts";

export function makeWsHandlers(mgr: WatchManager, context: string | null = null, kubeconfigPath = "") {
  const unsubs = new WeakMap<WebSocket, Map<string, () => void>>();
  // One kubectl-logs stream manager per connection — killed on logs.stop/close.
  const logStreams = new WeakMap<WebSocket, LogStreamManager>();
  // Abort handle for the in-flight chat turn — aborted on Stop/new-turn/close.
  const chatAborts = new WeakMap<WebSocket, AbortController>();
  // One interactive PTY shell per connection — killed on term.stop/close.
  const terminals = new WeakMap<WebSocket, TerminalSession>();
  // One in-flight cluster-create per connection — killed on cluster.stop/close.
  const creates = new WeakMap<WebSocket, ClusterCreateManager>();

  // Resolve a subscribe/unsubscribe message's effective context (explicit
  // non-empty string, else the connection default) and its per-connection key.
  // Shared by both branches so they always pair on the same key.
  const resolveSub = (m: { context?: unknown; kind: string; namespace: string }) => {
    const subCtx = typeof m.context === "string" && m.context !== "" ? m.context : context;
    return { subCtx, key: `${subCtx ?? ""}/${m.kind}/${m.namespace}` };
  };

  return {
    open(ws: WebSocket) {
      unsubs.set(ws, new Map());
      logStreams.set(ws, new LogStreamManager(ws, context));
      terminals.set(ws, new TerminalSession(ws));
      creates.set(ws, new ClusterCreateManager(ws, kubeconfigPath));
    },
    close(ws: WebSocket) {
      unsubs.get(ws)?.forEach((u) => u());
      logStreams.get(ws)?.stop();
      chatAborts.get(ws)?.abort();
      terminals.get(ws)?.stop();
      creates.get(ws)?.stop();
    },
    message(ws: WebSocket, raw: string | Buffer) {
      const m = JSON.parse(String(raw));
      const map = unsubs.get(ws)!;
      if (m.type === "subscribe") {
        const { subCtx, key } = resolveSub(m);
        if (map.has(key)) return;
        const un = mgr.subscribe(
          { context: subCtx, kind: m.kind, namespace: m.namespace },
          (items) =>
            ws.send(
              JSON.stringify({
                type: "snapshot",
                context: subCtx,
                kind: m.kind,
                namespace: m.namespace,
                items,
              }),
            ),
          (e: WatchEvent) =>
            ws.send(
              JSON.stringify({
                type: "delta",
                context: subCtx,
                kind: m.kind,
                namespace: m.namespace,
                event: e.type,
                object: e.object,
              }),
            ),
        );
        map.set(key, un);
      } else if (m.type === "unsubscribe") {
        const { key } = resolveSub(m);
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
        const scope = parseChatScope(m.scope);
        (async () => {
          try {
            // Only enumerate contexts when the turn fans out beyond the active one.
            const readContexts =
              scope === "active"
                ? context
                  ? [context]
                  : []
                : resolveReadContexts(scope, context, (await listContexts()).map((c) => c.name));
            for await (const event of runAgent(m.prompt, context, ac.signal, {
              model,
              effort,
              sessionId,
              readContexts,
            })) {
              ws.send(JSON.stringify({ type: "chat", event }));
            }
          } catch {
            /* connection/stream torn down */
          }
        })();
      } else if (m.type === "chat-interrupt") {
        // Stop button: kill the running claude subprocess for this connection.
        chatAborts.get(ws)?.abort();
      } else if (m.type === "term.start") {
        terminals.get(ws)?.start(Number(m.cols), Number(m.rows));
      } else if (m.type === "term.input" && typeof m.data === "string") {
        terminals.get(ws)?.write(m.data);
      } else if (m.type === "term.resize") {
        terminals.get(ws)?.resize(Number(m.cols), Number(m.rows));
      } else if (m.type === "term.stop") {
        terminals.get(ws)?.stop();
      } else if (m.type === "cluster.create" && typeof m.name === "string") {
        creates.get(ws)?.create({ tool: m.tool, name: m.name, version: m.version });
      } else if (m.type === "cluster.stop") {
        creates.get(ws)?.stop();
      }
    },
  };
}
