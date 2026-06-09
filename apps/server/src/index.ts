import { homedir } from "node:os";
import { resolveKubeconfigPath } from "./kubeconfig";
import { kubectl } from "@helmsman/k8s/src/run";
import { WatchManager } from "./watchManager";
import { makeWsHandlers } from "./ws";
import { buildCommand, PurgeActionError, type ActionBlock } from "./actions";
import { checkAuth } from "./auth";

const KUBECONFIG = resolveKubeconfigPath(process.env, homedir());
const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.HELMSMAN_TOKEN ?? null;

// Built web UI. Default resolves to apps/web/dist relative to this file, which
// holds whether running from source (apps/server/src) or in the container
// (/app/apps/server/src). Override with WEB_DIST if the layout differs.
const WEB_DIST = process.env.WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname;

/** Serve a file from the built web UI, falling back to index.html for SPA routes. */
async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  // Guard against path traversal escaping WEB_DIST.
  const safe = rel.split("/").filter((s) => s !== "..").join("/");
  const direct = Bun.file(`${WEB_DIST}/${safe}`);
  if (await direct.exists()) return new Response(direct);
  const index = Bun.file(`${WEB_DIST}/index.html`);
  if (await index.exists()) return new Response(index);
  return new Response("web UI not built (run `pnpm --filter web build`)", { status: 404 });
}

const ctxRes = await kubectl(null, ["config", "current-context"]);
const context = ctxRes.code === 0 ? ctxRes.stdout.trim() : null;

const mgr = new WatchManager(context);

const server = Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, kubeconfig: KUBECONFIG });
    }

    // Serve the built web UI for everything that isn't an API or WS path. The UI
    // shell loads without auth; the /api/* and /ws calls it makes are gated below.
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/ws") {
      return serveStatic(url.pathname);
    }

    // Auth gate: every non-health API/WS path requires a valid bearer token when TOKEN is set.
    if (!checkAuth(req.headers.get("authorization") ?? undefined, TOKEN)) {
      return new Response("unauthorized", { status: 401 });
    }

    // POST /api/action — execute or preview a chat action-block mutation.
    //
    // ?preview=1 → returns { command: ["kubectl", ...argv] } without executing.
    // Without preview → executes via kubectl and returns { code, stdout, stderr }.
    // purge kind → returns { purge: true, name, namespace } so the client opens
    //              the typed-name purge confirm sheet (never runs kubectl).
    if (url.pathname === "/api/action" && req.method === "POST") {
      let body: ActionBlock;
      try {
        body = (await req.json()) as ActionBlock;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }

      // purge is a client-side flow, not a kubectl command
      if (body.kind === "purge") {
        return Response.json({
          purge: true,
          name: body.name ?? body.deployment ?? null,
          namespace: body.namespace ?? "default",
        });
      }

      let argv: string[];
      try {
        argv = buildCommand(body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, { status: 422 });
      }

      // Preview mode: return the full kubectl command without running it
      if (url.searchParams.get("preview") === "1") {
        const fullCommand = ["kubectl", ...(context ? ["--context", context] : []), ...argv];
        return Response.json({ command: fullCommand });
      }

      // Execute mode: run kubectl and return the result
      const result = await kubectl(context, argv);
      return Response.json(result);
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
