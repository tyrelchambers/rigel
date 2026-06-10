import { homedir } from "node:os";
import { resolveKubeconfigPath } from "./kubeconfig";
import { kubectl } from "@helmsman/k8s/src/run";
import { WatchManager } from "./watchManager";
import { makeWsHandlers } from "./ws";
import { buildCommand, PurgeActionError, type ActionBlock } from "./actions";
import { applyManifest, installHelm, type HelmInstallRequest } from "./install";
import { handlePurge, type PurgeRequest } from "./purge";
import { getPodMetrics, getNodeMetrics } from "./metrics";
import { handleUpdates, type UpdatesRequest } from "./updates";
import { handleAssistant, type AssistantRequest } from "./assistant";
import { handleSignal, type SignalRequest } from "./signal";
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

    // GET /api/metrics/pods?namespace=<ns|*> — current pod CPU/memory usage.
    // Always HTTP 200; { available:false, items:[] } when metrics-server absent.
    if (url.pathname === "/api/metrics/pods" && req.method === "GET") {
      const ns = url.searchParams.get("namespace") ?? "*";
      const result = await getPodMetrics(context, ns);
      return Response.json(result);
    }

    // GET /api/metrics/nodes — current node CPU/memory usage. Same graceful path.
    if (url.pathname === "/api/metrics/nodes" && req.method === "GET") {
      const result = await getNodeMetrics(context);
      return Response.json(result);
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

    // POST /api/apply — catalog wizard MANIFEST install. Feeds the multi-doc
    // YAML to `kubectl apply -f -` via STDIN (never shell-interpolated).
    // Returns { code, stdout, stderr }.
    if (url.pathname === "/api/apply" && req.method === "POST") {
      let body: { yaml?: string };
      try {
        body = (await req.json()) as { yaml?: string };
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.yaml !== "string" || body.yaml.trim() === "") {
        return Response.json({ error: "missing yaml" }, { status: 422 });
      }
      const result = await applyManifest(context, body.yaml);
      return Response.json(result);
    }

    // POST /api/helm — catalog wizard HELM install. Runs repo add (idempotent)
    // → repo update → upgrade --install in sequence. Returns { code, stdout, stderr }.
    if (url.pathname === "/api/helm" && req.method === "POST") {
      let body: Partial<HelmInstallRequest>;
      try {
        body = (await req.json()) as Partial<HelmInstallRequest>;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (
        !body.repoName ||
        !body.repoURL ||
        !body.chart ||
        !body.releaseName ||
        !body.namespace ||
        typeof body.values !== "string"
      ) {
        return Response.json(
          { error: "missing required helm fields (repoName, repoURL, chart, releaseName, namespace, values)" },
          { status: 422 },
        );
      }
      const result = await installHelm(context, {
        repoName: body.repoName,
        repoURL: body.repoURL,
        chart: body.chart,
        version: body.version ?? null,
        releaseName: body.releaseName,
        namespace: body.namespace,
        values: body.values,
      });
      return Response.json(result);
    }

    // POST /api/purge — full app-removal flow (docs/parity/purge.md).
    //
    // dryRun=true  → discover related resources (label + name-prefix), detect a
    //                helm release, enforce guardrails. Returns { discovered,
    //                helmRelease?, blockedReason? }.
    // dryRun=false → execute: helm uninstall (if managed) then kubectl delete
    //                per selected resource. Returns { ok, results }.
    if (url.pathname === "/api/purge" && req.method === "POST") {
      let body: PurgeRequest;
      try {
        body = (await req.json()) as PurgeRequest;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.namespace !== "string" || typeof body.instance !== "string") {
        return Response.json({ error: "missing namespace or instance" }, { status: 422 });
      }
      const result = await handlePurge(context, body);
      return Response.json(result);
    }

    // POST /api/updates — check running images for newer stable releases.
    //
    // Body { images: string[] }. For each image, resolves an update status via
    // the deterministic resolver tiers (registry version → moving-tag digest →
    // GitHub Releases). Per-image failures degrade to { kind:"unknown" } rather
    // than failing the batch. Always HTTP 200 with { results: UpdateResult[] }.
    if (url.pathname === "/api/updates" && req.method === "POST") {
      let body: UpdatesRequest;
      try {
        body = (await req.json()) as UpdatesRequest;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!Array.isArray(body?.images)) {
        return Response.json({ error: "missing images array" }, { status: 422 });
      }
      const result = await handleUpdates(body);
      return Response.json(result);
    }

    // POST /api/assistant — control plane for the in-cluster assistant agent
    // (docs/parity/assistant.md). Dispatches on `action`. Every cluster write
    // is a kubectl argv invocation (no shell); the OAuth token is only ever
    // piped into the applied Secret and is NEVER logged or echoed back.
    if (url.pathname === "/api/assistant" && req.method === "POST") {
      let body: AssistantRequest;
      try {
        body = (await req.json()) as AssistantRequest;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.action !== "string") {
        return Response.json({ error: "missing action" }, { status: 422 });
      }
      if (
        (body.action === "silence" || body.action === "unsilence") &&
        (typeof body.fingerprint !== "string" || body.fingerprint.trim() === "")
      ) {
        return Response.json({ error: "missing fingerprint" }, { status: 422 });
      }
      try {
        const result = await handleAssistant(context, body);
        if (result.code !== 0) {
          return Response.json(
            { error: result.stderr.trim() || result.stdout.trim() || `exit ${result.code}` },
            { status: 500 },
          );
        }
        return Response.json({ success: true });
      } catch (err) {
        // Log WITHOUT the token (err.message carries kubectl stderr, never the
        // Secret payload — that only ever lives on the process stdin pipe).
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`assistant action ${body.action}:`, msg);
        return Response.json({ error: msg }, { status: 500 });
      }
    }

    // POST /api/signal — Signal notifications bridge proxy
    // (docs/parity/settings.md §7.1). Opens a short-lived port-forward to
    // svc/signal-cli-rest and proxies one request to the bridge REST API:
    //   link     → PNG QR bytes (image/png)
    //   accounts → { accounts: string[] }
    //   status   → { ready: true }
    //   sendTest → { ok: true }
    // Every action runs via kubectl argv (no shell); port-forward stderr is
    // surfaced verbatim as "Port-forward failed: <stderr>".
    if (url.pathname === "/api/signal" && req.method === "POST") {
      let body: SignalRequest;
      try {
        body = (await req.json()) as SignalRequest;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.action !== "string") {
        return Response.json({ error: "missing action" }, { status: 422 });
      }
      const result = await handleSignal(context, body);
      if (result.kind === "error") {
        return Response.json({ error: result.message }, { status: result.status });
      }
      if (result.kind === "png") {
        // Uint8Array is a valid Response body at runtime (Bun/DOM); the cast
        // sidesteps TS 5.7's Uint8Array<ArrayBufferLike> vs BodyInit strictness.
        return new Response(result.bytes as unknown as BodyInit, {
          headers: { "Content-Type": "image/png" },
        });
      }
      return Response.json(result.body);
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
