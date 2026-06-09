import { homedir } from "node:os";
import { resolveKubeconfigPath } from "./kubeconfig";

const KUBECONFIG = resolveKubeconfigPath(process.env, homedir());
const PORT = Number(process.env.PORT ?? 8787);

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
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "hello", kubeconfig: KUBECONFIG }));
    },
    message(ws, msg) {
      ws.send(JSON.stringify({ type: "echo", data: String(msg) }));
    },
  },
});

console.log(`helmsman server on :${server.port} (kubeconfig=${KUBECONFIG})`);
