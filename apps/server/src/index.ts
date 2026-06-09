import { homedir } from "node:os";
import { resolveKubeconfigPath } from "./kubeconfig";
import { kubectl } from "@helmsman/k8s/src/run";
import { WatchManager } from "./watchManager";
import { makeWsHandlers } from "./ws";

const KUBECONFIG = resolveKubeconfigPath(process.env, homedir());
const PORT = Number(process.env.PORT ?? 8787);

const ctxRes = await kubectl(null, ["config", "current-context"]);
const context = ctxRes.code === 0 ? ctxRes.stdout.trim() : null;

const mgr = new WatchManager(context);

const server = Bun.serve({
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, kubeconfig: KUBECONFIG });
    }
    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) return; // handled by websocket
      return new Response("expected websocket", { status: 426 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: makeWsHandlers(mgr, context),
});

console.log(`helmsman server on :${server.port} (kubeconfig=${KUBECONFIG})`);
