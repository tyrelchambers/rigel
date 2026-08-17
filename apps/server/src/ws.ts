import type { WebSocket } from "ws";
import { WatchManager } from "./watchManager";
import type { WatchEvent } from "@rigel/k8s/src/watch";
import { runAgent } from "./runAgent";
import { LogStreamManager, type LogTarget } from "./logStream";
import { TerminalSession } from "./terminal";
import { ClusterCreateManager } from "./clusterCreateManager";
import { ActionRunManager } from "./actionRunManager";
import { parseChatScope, resolveReadContexts } from "./chatScope";
import { listContexts } from "./contexts";
import { requiredTools } from "./requiredTools";
import { isCloudContext } from "./cloudGate";
import { cloudEnabled } from "./entitlements";
import type { Access } from "./access";

const GATED_MESSAGE = "Cloud clusters are a Pro feature";

// HELM-16: a per-frame gate. A resolved context is blocked when it is a cloud
// provider and the account is not entitled to cloud clusters. Local/generic
// contexts (and any context on Pro) always pass.
async function cloudGated(ctx: string | null): Promise<boolean> {
  return ctx != null && !cloudEnabled() && (await isCloudContext(ctx));
}

export function makeWsHandlers(
  mgr: WatchManager,
  context: string | null = null,
  kubeconfigPath = "",
  accessFor: (ctx: string | null) => Promise<Access> = async () => ({ mode: "cluster-wide", namespaces: [] }),
) {
  const unsubs = new WeakMap<WebSocket, Map<string, () => void>>();
  const ctxAccessByWs = new WeakMap<WebSocket, Map<string, Access>>();
  const announcedByWs = new WeakMap<WebSocket, Set<string>>();
  // One kubectl-logs stream manager per connection — killed on logs.stop/close.
  const logStreams = new WeakMap<WebSocket, LogStreamManager>();
  // Abort handle for the in-flight chat turn — aborted on Stop/new-turn/close.
  const chatAborts = new WeakMap<WebSocket, AbortController>();
  // One interactive PTY shell per connection — killed on term.stop/close.
  const terminals = new WeakMap<WebSocket, TerminalSession>();
  // One in-flight cluster-create per connection — killed on cluster.stop/close.
  const creates = new WeakMap<WebSocket, ClusterCreateManager>();
  // Action-run manager per connection — multiple concurrent runs keyed by id.
  const actionRunners = new WeakMap<WebSocket, ActionRunManager>();

  // Resolve a subscribe/unsubscribe message's effective context (explicit
  // non-empty string, else the connection default) and its per-connection key.
  // Shared by both branches so they always pair on the same key.
  const resolveSub = (m: { context?: unknown; kind: string; namespace: string }) => {
    const subCtx = typeof m.context === "string" && m.context !== "" ? m.context : context;
    return { subCtx, key: `${subCtx ?? ""}/${m.kind}/${m.namespace}` };
  };

  function announceAccess(ws: WebSocket, ctxKey: string, access: Access) {
    const seen = announcedByWs.get(ws);
    if (!seen) return;
    if (seen.has(ctxKey)) return;
    seen.add(ctxKey);
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "access",
          context: ctxKey === "" ? null : ctxKey,
          mode: access.mode,
          namespaces: access.namespaces,
        }),
      );
    }
  }

  function fanOut(
    ws: WebSocket,
    map: Map<string, () => void>,
    subCtx: string | null,
    key: string,
    m: { kind: string; namespace: string },
    access: Access,
  ) {
    const targets =
      m.namespace === "*" && access.mode === "scoped" ? access.namespaces : [m.namespace];
    if (targets.length === 0) {
      ws.send(
        JSON.stringify({ type: "snapshot", context: subCtx, kind: m.kind, namespace: "*", items: [] }),
      );
    }
    const uns = targets.map((ns) =>
      mgr.subscribe(
        { context: subCtx, kind: m.kind, namespace: ns },
        (items) =>
          ws.send(
            JSON.stringify({
              type: "snapshot",
              context: subCtx,
              kind: m.kind,
              namespace: ns,
              items,
            }),
          ),
        (e: WatchEvent) =>
          ws.send(
            JSON.stringify({
              type: "delta",
              context: subCtx,
              kind: m.kind,
              namespace: ns,
              event: e.type,
              object: e.object,
            }),
          ),
        (err) =>
          ws.send(
            JSON.stringify({
              type: "error",
              context: subCtx,
              kind: m.kind,
              namespace: ns,
              reason: err.reason,
              message: err.message,
            }),
          ),
      ),
    );
    map.set(key, () => uns.forEach((u) => u()));
  }

  return {
    open(ws: WebSocket, access?: Access) {
      const resolvedAccess = access ?? { mode: "cluster-wide" as const, namespaces: [] };
      unsubs.set(ws, new Map());
      ctxAccessByWs.set(ws, new Map());
      announcedByWs.set(ws, new Set());
      logStreams.set(ws, new LogStreamManager(ws, context));
      terminals.set(ws, new TerminalSession(ws));
      creates.set(ws, new ClusterCreateManager(ws, kubeconfigPath));
      actionRunners.set(ws, new ActionRunManager(ws, context));
      const bootKey = context ?? "";
      ctxAccessByWs.get(ws)!.set(bootKey, resolvedAccess);
      announceAccess(ws, bootKey, resolvedAccess);
      // A client that connects after a binary went missing still learns about it.
      ws.send(JSON.stringify({ type: "tools.status", missing: requiredTools.state() }));
    },
    close(ws: WebSocket) {
      unsubs.get(ws)?.forEach((u) => u());
      unsubs.get(ws)?.clear();
      logStreams.get(ws)?.stop();
      chatAborts.get(ws)?.abort();
      terminals.get(ws)?.stop();
      creates.get(ws)?.stop();
      actionRunners.get(ws)?.stop();
    },
    message(ws: WebSocket, raw: string | Buffer) {
      const m = JSON.parse(String(raw));
      const map = unsubs.get(ws)!;
      if (m.type === "subscribe") {
        const { subCtx, key } = resolveSub(m);
        if (map.has(key)) return;
        const ctxKey = subCtx ?? "";
        const token = () => {};
        map.set(key, token);
        void cloudGated(subCtx).then((gated) => {
          if (map.get(key) !== token) return;
          if (gated) {
            map.delete(key);
            ws.send(
              JSON.stringify({
                type: "error",
                context: subCtx,
                kind: m.kind,
                namespace: m.namespace,
                reason: "gated",
                message: GATED_MESSAGE,
                gated: true,
              }),
            );
            return;
          }
          const cached = ctxAccessByWs.get(ws)?.get(ctxKey);
          if (cached) {
            fanOut(ws, map, subCtx, key, m, cached);
          } else {
            void accessFor(subCtx).then((access) => {
              ctxAccessByWs.get(ws)?.set(ctxKey, access);
              announceAccess(ws, ctxKey, access);
              if (map.get(key) !== token) return;
              fanOut(ws, map, subCtx, key, m, access);
            });
          }
        });
      } else if (m.type === "tools.recheck") {
        void requiredTools.probeAll();
      } else if (m.type === "unsubscribe") {
        const { key } = resolveSub(m);
        map.get(key)?.();
        map.delete(key);
      } else if (m.type === "logs.start" && Array.isArray(m.targets)) {
        const targets = m.targets as LogTarget[];
        const tail = typeof m.tailLines === "number" ? m.tailLines : 200;
        const logsCtx = typeof m.context === "string" && m.context !== "" ? m.context : context;
        void cloudGated(logsCtx).then((gated) => {
          if (gated) {
            ws.send(JSON.stringify({ type: "logs.error", namespace: "", message: GATED_MESSAGE, gated: true }));
            return;
          }
          logStreams.get(ws)?.start(targets, tail, logsCtx);
        });
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
        const chatCtx = typeof m.context === "string" && m.context !== "" ? m.context : context;
        (async () => {
          try {
            if (await cloudGated(chatCtx)) {
              ws.send(
                JSON.stringify({ type: "chat", event: { type: "error", text: GATED_MESSAGE, gated: true } }),
              );
              return;
            }
            // Only enumerate contexts when the turn fans out beyond the active one.
            const candidates =
              scope === "active"
                ? chatCtx
                  ? [chatCtx]
                  : []
                : resolveReadContexts(scope, chatCtx, (await listContexts()).map((c) => c.name));
            // Drop any cloud context the account is not entitled to from the fan-out.
            const readContexts: string[] = [];
            for (const c of candidates) if (!(await cloudGated(c))) readContexts.push(c);
            for await (const event of runAgent(m.prompt, chatCtx, ac.signal, {
              model,
              effort,
              sessionId,
              readContexts,
            })) {
              ws.send(JSON.stringify({ type: "chat", event }));
            }
          } catch (err) {
            // The user interrupting is not an error; the runner ends quietly.
            if (ac.signal.aborted) return;
            // Otherwise the agent runner itself failed (e.g. the CLI couldn't be
            // spawned, or guard provisioning threw). Surface it as a chat error so
            // the user sees WHY instead of silence; if the send throws the
            // connection is genuinely torn down, so swallow that.
            try {
              ws.send(
                JSON.stringify({
                  type: "chat",
                  event: { type: "error", text: `Agent error: ${(err as Error)?.message ?? String(err)}` },
                }),
              );
            } catch {
              /* connection torn down */
            }
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
      } else if (m.type === "action.run" && typeof m.id === "string" && m.action != null) {
        const actionCtx = typeof m.context === "string" && m.context !== "" ? m.context : context;
        void cloudGated(actionCtx).then((gated) => {
          if (gated) {
            ws.send(JSON.stringify({ type: "action.error", id: m.id, message: GATED_MESSAGE, gated: true }));
            return;
          }
          actionRunners.get(ws)?.run({ id: m.id, action: m.action, context: actionCtx });
        });
      }
    },
  };
}
