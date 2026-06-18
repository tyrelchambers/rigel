import { homedir } from "node:os";
import { resolveKubeconfigPath } from "./kubeconfig";
import { kubectl } from "@helmsman/k8s/src/run";
import { WatchManager } from "./watchManager";
import { makeWsHandlers } from "./ws";
import { buildCommand, PurgeActionError, type ActionBlock } from "./actions";
import { applyManifest, installHelm, type HelmInstallRequest } from "./install";
import { handlePurge, type PurgeRequest } from "./purge";
import {
  loadSources, saveSources, diffSource, applySource, previewRepoFix, proposeRepoFix,
  loadGithubToken, githubAccountStatus, connectGithub, disconnectGithub, listGithubRepos, listRepoTree, readRepoFile,
} from "./git";
import {
  sanitizeSourceName,
  normalizeManifestPath,
  resolveTarget,
  findByDeployment,
  upsertDeployment,
  type GitSource,
  type GitDeployment,
} from "@helmsman/k8s/src/gitSources";
import { getPodMetrics, getNodeMetrics, getNodeDisk } from "./metrics";
import { getUsageHistory, detectAllBackends, flavorForPort } from "./prometheusMetrics";
import { handleUpdates, type UpdatesRequest } from "./updates";
import { chatConfig, setClaudeToken } from "./chatConfig";
import { buildSuggestions } from "./suggestions";
import { getClusterYamlSchema } from "./clusterSchema";
import { stripStatusBlock } from "@helmsman/k8s/src/manifestClean";
import {
  passwordConfigured,
  passwordMatches,
  hasValidSession,
  sessionSetCookie,
  sessionClearCookie,
} from "./session";
import { handleAssistant, type AssistantRequest } from "./assistant";
import { handleSignal, type SignalRequest } from "./signal";
import { PortForwardManager, type TargetKind } from "./portForward";
import { checkAuth } from "./auth";

const KUBECONFIG = resolveKubeconfigPath(process.env, homedir());
const PORT = Number(process.env.PORT ?? 8787);
// Treat an empty/whitespace HELMSMAN_TOKEN as "unset" — compose/Helm commonly
// pass it as "" which would otherwise make checkAuth() treat the bearer as open
// and defeat the password gate.
const TOKEN = process.env.HELMSMAN_TOKEN?.trim() || null;

// Upstream metrics-server manifest (onboarding one-click install).
const METRICS_SERVER_URL =
  "https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml";

// Built web UI. Default resolves to apps/web/dist relative to this file, which
// holds whether running from source (apps/server/src) or in the container
// (/app/apps/server/src). Override with WEB_DIST if the layout differs.
const WEB_DIST = process.env.WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname;

/**
 * Cache policy for the SPA: Vite fingerprints assets (e.g. `/assets/index-<hash>.js`),
 * so those are safe to cache forever (a new build → a new filename). But
 * `index.html` references the current hashed bundle, so it MUST NOT be cached —
 * otherwise the browser keeps loading the previous build's JS after a redeploy
 * (the classic "I rebuilt but still see the old UI" trap). Serve fingerprinted
 * assets immutable; serve index.html (and SPA fallbacks) no-store.
 */
function cacheHeaders(pathname: string): HeadersInit {
  if (pathname.startsWith("/assets/")) {
    return { "Cache-Control": "public, max-age=31536000, immutable" };
  }
  return { "Cache-Control": "no-store, must-revalidate" };
}

/** Serve a file from the built web UI, falling back to index.html for SPA routes. */
async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  // Guard against path traversal escaping WEB_DIST.
  const safe = rel.split("/").filter((s) => s !== "..").join("/");
  const direct = Bun.file(`${WEB_DIST}/${safe}`);
  if (await direct.exists()) return new Response(direct, { headers: cacheHeaders(rel) });
  // SPA fallback → index.html, which must always revalidate.
  const index = Bun.file(`${WEB_DIST}/index.html`);
  if (await index.exists()) return new Response(index, { headers: { "Cache-Control": "no-store, must-revalidate" } });
  return new Response("web UI not built (run `pnpm --filter web build`)", { status: 404 });
}

const ctxRes = await kubectl(null, ["config", "current-context"]);
const context = ctxRes.code === 0 ? ctxRes.stdout.trim() : null;

const mgr = new WatchManager(context);

// Port-forward subprocess registry (docs/parity/portforward.md). One instance
// for the server's lifetime; killed wholesale on shutdown so no zombie kubectl
// survives. The forwards bind the SERVER's 127.0.0.1 — see the module caveat.
const portForwards = new PortForwardManager(context);

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

    // --- Auth endpoints (open) — drive the login screen / cookie session. ---
    if (url.pathname === "/api/auth-status" && req.method === "GET") {
      return Response.json({
        authRequired: passwordConfigured(),
        authenticated: hasValidSession(req, Date.now()),
      });
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      if (!passwordConfigured()) return Response.json({ ok: true });
      const body = (await req.json().catch(() => ({}))) as { password?: unknown };
      if (typeof body.password === "string" && passwordMatches(body.password)) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Set-Cookie": sessionSetCookie(req, Date.now()) },
        });
      }
      return new Response(JSON.stringify({ ok: false }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": sessionClearCookie() },
      });
    }

    // Auth gate: when a password (browser) and/or HELMSMAN_TOKEN (CLI) is set,
    // every other /api + /ws request needs a valid session cookie OR bearer token.
    if (passwordConfigured() || TOKEN !== null) {
      // NOTE: checkAuth returns true when TOKEN is null (its "no bearer = open"
      // rule), so only treat the bearer as proof of auth when a token is set —
      // otherwise it would defeat the password gate.
      const bearerOk = TOKEN !== null && checkAuth(req.headers.get("authorization") ?? undefined, TOKEN);
      if (!hasValidSession(req, Date.now()) && !bearerOk) {
        return new Response("unauthorized", { status: 401 });
      }
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

    // GET /api/metrics/node-disk — per-node root-fs usage from the kubelet
    // Summary API. Graceful: { available:false, items:[] } when unreachable.
    if (url.pathname === "/api/metrics/node-disk" && req.method === "GET") {
      const result = await getNodeDisk(context);
      return Response.json(result);
    }

    // GET /api/metrics/usage?namespace=<ns|*> — 30-day per-pod/container usage
    // history from a detected Prometheus/VictoriaMetrics backend, for
    // right-sizing. Always HTTP 200; { available:false } when no backend exists.
    // GET /api/metrics/backends — Prometheus/VictoriaMetrics backends detected in
    // the cluster, for the right-sizing source picker.
    if (url.pathname === "/api/metrics/backends" && req.method === "GET") {
      const backends = await detectAllBackends(context);
      return Response.json({ backends });
    }

    if (url.pathname === "/api/metrics/usage" && req.method === "GET") {
      const ns = url.searchParams.get("namespace") ?? "*";
      // Optional explicit backend (bns/svc/port) from the picker; else auto-detect.
      const bns = url.searchParams.get("bns");
      const svc = url.searchParams.get("svc");
      const portStr = url.searchParams.get("port");
      const port = Number(portStr);
      const explicit =
        bns && svc && portStr && Number.isFinite(port)
          ? { namespace: bns, service: svc, port, flavor: flavorForPort(port) }
          : undefined;
      const result = await getUsageHistory(context, ns, explicit);
      return Response.json(result);
    }

    // GET /api/cnpg-plugin — is the `kubectl cnpg` plugin installed on the
    // server? Mirrors the Swift `CNPGPluginProbe` (runs `kubectl cnpg version`).
    // The Databases panel uses this to enable/disable CNPG-specific actions.
    // Always HTTP 200; { available:false } when the plugin is missing.
    if (url.pathname === "/api/cnpg-plugin" && req.method === "GET") {
      const probe = await kubectl(context, ["cnpg", "version"]);
      return Response.json({ available: probe.code === 0 });
    }

    // GET /api/cert-manager-plugin — is the `kubectl cert-manager` plugin
    // (cmctl) installed? The Certificates panel uses this to enable/disable the
    // Force-renew action. `version --client` never touches the cluster and (unlike
    // the `help` subcommand) still accepts the `--context` flag the wrapper inserts
    // after the plugin name, so exit 0 ⇒ present. Always HTTP 200.
    if (url.pathname === "/api/cert-manager-plugin" && req.method === "GET") {
      const probe = await kubectl(context, ["cert-manager", "version", "--client"]);
      return Response.json({ available: probe.code === 0 });
    }

    // GET /api/suggestions — cluster-aware chat suggestion chips. One-shot reads
    // (kept off the watch store so the namespace filter isn't disturbed); always
    // returns { prompts } (degrades to just the "Investigate cluster" fallback).
    if (url.pathname === "/api/suggestions" && req.method === "GET") {
      const items = async (args: string[]): Promise<unknown[]> => {
        const r = await kubectl(context, [...args, "-o", "json"]);
        if (r.code !== 0) return [];
        try {
          return (JSON.parse(r.stdout) as { items?: unknown[] }).items ?? [];
        } catch {
          return [];
        }
      };
      const [pods, deployments, nodes, events] = await Promise.all([
        items(["get", "pods", "-A"]),
        items(["get", "deployments", "-A"]),
        items(["get", "nodes"]),
        items(["get", "events", "-A", "--field-selector", "type=Warning"]),
      ]);
      return Response.json({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        prompts: buildSuggestions({ pods, deployments, nodes, events } as any),
      });
    }

    // GET  /api/chat-config — is the AI copilot's Claude token configured?
    // POST /api/chat-config { token } — set it (empty clears); env-set tokens
    // take precedence and are not overwritten. Lets a self-hoster enable chat
    // from the Settings screen without an env restart.
    if (url.pathname === "/api/chat-config" && req.method === "GET") {
      return Response.json(await chatConfig());
    }
    if (url.pathname === "/api/chat-config" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { token?: unknown };
      await setClaudeToken(typeof body.token === "string" ? body.token : "");
      return Response.json(await chatConfig());
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

    // POST /api/apply — MANIFEST apply, used by the catalog wizard and the
    // Apply YAML panel. Feeds the multi-doc YAML to `kubectl apply -f -` via
    // STDIN (never shell-interpolated). `dryRun` runs --dry-run=server so the
    // apiserver validates without persisting. Returns { code, stdout, stderr }.
    if (url.pathname === "/api/apply" && req.method === "POST") {
      let body: { yaml?: string; dryRun?: boolean };
      try {
        body = (await req.json()) as { yaml?: string; dryRun?: boolean };
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.yaml !== "string" || body.yaml.trim() === "") {
        return Response.json({ error: "missing yaml" }, { status: 422 });
      }
      const result = await applyManifest(context, body.yaml, body.dryRun === true);
      return Response.json(result);
    }

    // GET /api/resource?kind=&name=&namespace=[&clean=1] — read-only
    // `kubectl get <kind> <name> [-n ns] -o yaml`, for the "View YAML" viewer.
    // Pass clean=1 to strip managedFields + status block (for the live editor).
    // Returns { code, yaml, stderr }. Omit namespace for cluster-scoped kinds.
    if (url.pathname === "/api/resource" && req.method === "GET") {
      const kind = url.searchParams.get("kind");
      const name = url.searchParams.get("name");
      const namespace = url.searchParams.get("namespace");
      const clean = url.searchParams.get("clean") === "1";
      if (!kind || !name) return Response.json({ error: "missing kind or name" }, { status: 422 });
      const args = [
        "get", kind, name, "-o", "yaml",
        ...(clean ? ["--show-managed-fields=false"] : []),
        ...(namespace ? ["-n", namespace] : []),
      ];
      const res = await kubectl(context, args);
      const yamlOut = clean && res.code === 0 ? stripStatusBlock(res.stdout) : res.stdout;
      return Response.json({ code: res.code, yaml: yamlOut, stderr: res.stderr });
    }

    // GET /api/openapi-schema — the live cluster's OpenAPI v2 converted to a
    // monaco-yaml JSON Schema (cached per context). { schema } or { schema: null }
    // when unavailable; the client then edits lint-only (no static fallback).
    if (url.pathname === "/api/openapi-schema" && req.method === "GET") {
      return Response.json({ schema: await getClusterYamlSchema(context) });
    }

    // POST /api/install/metrics-server — one-click upstream metrics-server for
    // the onboarding wizard (enables `kubectl top` → live metrics + right-sizing).
    // Applies the official components.yaml, then best-effort adds
    // --kubelet-insecure-tls (the common homelab/k3s/kind fix for self-signed
    // kubelet certs). Always 200 with { code, stdout, stderr } from the apply.
    if (url.pathname === "/api/install/metrics-server" && req.method === "POST") {
      const apply = await kubectl(context, ["apply", "-f", METRICS_SERVER_URL]);
      if (apply.code === 0) {
        // Tolerate failure: not every cluster needs/accepts the flag.
        await kubectl(context, [
          "patch", "deployment", "metrics-server", "-n", "kube-system", "--type=json",
          "-p", '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]',
        ]);
      }
      return Response.json(apply);
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

    // ── GitOps: deploy manifests from a GitHub repo ───────────────────────────
    // GET /api/git/account — GitHub connection status (connected + login).
    if (url.pathname === "/api/git/account" && req.method === "GET") {
      return Response.json(await githubAccountStatus(context));
    }

    // POST /api/git/account — { token }. Validates against the GitHub API and
    // stores it (with the login) in the helmsman-github Secret.
    if (url.pathname === "/api/git/account" && req.method === "POST") {
      let body: { token?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!body.token) return Response.json({ error: "missing token" }, { status: 422 });
      const r = await connectGithub(context, body.token);
      if (!r.ok) return Response.json({ error: r.message ?? "could not connect" }, { status: 422 });
      return Response.json({ connected: true, login: r.login });
    }

    // DELETE /api/git/account — remove the stored PAT.
    if (url.pathname === "/api/git/account" && req.method === "DELETE") {
      await disconnectGithub(context);
      return Response.json({ connected: false, login: null });
    }

    // GET /api/git/repos — list the connected account's repos (for the picker).
    if (url.pathname === "/api/git/repos" && req.method === "GET") {
      const token = await loadGithubToken(context);
      if (!token) return Response.json({ error: "GitHub not connected" }, { status: 409 });
      return Response.json({ repos: await listGithubRepos(token) });
    }

    // GET /api/git/repo-tree?repo=owner/repo&branch=&path= — one directory level
    // of a repo (the add-source folder browser).
    if (url.pathname === "/api/git/repo-tree" && req.method === "GET") {
      const repo = url.searchParams.get("repo");
      const branch = url.searchParams.get("branch");
      const path = url.searchParams.get("path") ?? "";
      if (!repo || !branch) return Response.json({ error: "missing repo or branch" }, { status: 422 });
      const token = await loadGithubToken(context);
      if (!token) return Response.json({ error: "GitHub not connected" }, { status: 409 });
      return Response.json({ entries: await listRepoTree(token, repo, branch, path) });
    }

    // GET /api/git/repo-file?repo=owner/repo&branch=&path= — one file's text
    // (server holds the token). Powers the GitOps file editor.
    if (url.pathname === "/api/git/repo-file" && req.method === "GET") {
      const repo = url.searchParams.get("repo");
      const branch = url.searchParams.get("branch");
      const path = url.searchParams.get("path");
      if (!repo || !branch || !path) return Response.json({ error: "missing repo, branch, or path" }, { status: 422 });
      const token = await loadGithubToken(context);
      if (!token) return Response.json({ error: "GitHub not connected" }, { status: 409 });
      const r = await readRepoFile(token, repo, branch, path);
      if (!r.ok) return Response.json({ error: r.message ?? "could not read file" }, { status: 422 });
      return Response.json({ content: r.content });
    }

    // GET /api/git/sources — list configured sources (never includes tokens).
    if (url.pathname === "/api/git/sources" && req.method === "GET") {
      return Response.json({ sources: await loadSources(context) });
    }

    // POST /api/git/sources — add or update a REPO source. Body:
    // { name, repoURL, branch?, deployments?: [{ name, path }] }. Deployments are
    // merged by name (each one's lastSynced* state is preserved; existing
    // deployments not listed are kept). Auth uses the account-level GitHub PAT.
    if (url.pathname === "/api/git/sources" && req.method === "POST") {
      let body: { name?: string; repoURL?: string; branch?: string; deployments?: { name?: string; path?: string }[] };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!body.name || !body.repoURL) {
        return Response.json({ error: "missing name or repoURL" }, { status: 422 });
      }
      const name = sanitizeSourceName(body.name);
      if (!name) return Response.json({ error: "invalid name" }, { status: 422 });

      // Normalize + validate the incoming deployments.
      let incoming: GitDeployment[];
      try {
        incoming = (body.deployments ?? []).map((d) => {
          const depName = sanitizeSourceName(d.name ?? "");
          if (!depName) throw new Error("invalid deployment name");
          return { name: depName, path: normalizeManifestPath(d.path ?? ".") };
        });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
      }
      const dup = incoming.find((d, i) => incoming.findIndex((x) => x.name === d.name) !== i);
      if (dup) return Response.json({ error: `duplicate deployment name: ${dup.name}` }, { status: 422 });

      const sources = await loadSources(context);
      // A deployment name is a global id — it can't already belong to another repo.
      for (const d of incoming) {
        const owner = findByDeployment(sources, d.name);
        if (owner && owner.repo.name !== name) {
          return Response.json({ error: `deployment "${d.name}" is already used by repo "${owner.repo.name}"` }, { status: 409 });
        }
      }
      const existing = sources.find((s) => s.name === name);
      const deployments = incoming.reduce((acc, d) => upsertDeployment(acc, d), existing?.deployments ?? []);
      const next: GitSource = {
        name,
        repoURL: body.repoURL.trim(),
        branch: body.branch?.trim() || existing?.branch || "main",
        deployments,
      };
      const merged = existing ? sources.map((s) => (s.name === name ? next : s)) : [...sources, next];
      const saved = await saveSources(context, merged);
      if (saved.code !== 0) return Response.json({ error: saved.stderr || "failed to save sources" }, { status: 500 });
      return Response.json({ sources: merged });
    }

    // POST /api/git/sources/deployment — add or update ONE deployment under a repo.
    // Body: { repo, name, path }. Preserves the deployment's lastSynced* on update.
    if (url.pathname === "/api/git/sources/deployment" && req.method === "POST") {
      let body: { repo?: string; name?: string; path?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!body.repo || !body.name) return Response.json({ error: "missing repo or name" }, { status: 422 });
      const depName = sanitizeSourceName(body.name);
      if (!depName) return Response.json({ error: "invalid name" }, { status: 422 });
      let path: string;
      try {
        path = normalizeManifestPath(body.path ?? ".");
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
      }
      const sources = await loadSources(context);
      const repo = sources.find((s) => s.name === body.repo);
      if (!repo) return Response.json({ error: "unknown repo" }, { status: 404 });
      const owner = findByDeployment(sources, depName);
      if (owner && owner.repo.name !== repo.name) {
        return Response.json({ error: `deployment "${depName}" is already used by repo "${owner.repo.name}"` }, { status: 409 });
      }
      const updatedRepo: GitSource = { ...repo, deployments: upsertDeployment(repo.deployments, { name: depName, path }) };
      const merged = sources.map((s) => (s.name === repo.name ? updatedRepo : s));
      const saved = await saveSources(context, merged);
      if (saved.code !== 0) return Response.json({ error: saved.stderr || "failed to save sources" }, { status: 500 });
      return Response.json({ sources: merged });
    }

    // DELETE /api/git/sources/deployment?repo=&name= — remove one deployment.
    if (url.pathname === "/api/git/sources/deployment" && req.method === "DELETE") {
      const repoName = url.searchParams.get("repo");
      const depName = url.searchParams.get("name");
      if (!repoName || !depName) return Response.json({ error: "missing repo or name" }, { status: 422 });
      const sources = await loadSources(context);
      const merged = sources.map((s) =>
        s.name === repoName ? { ...s, deployments: s.deployments.filter((d) => d.name !== depName) } : s,
      );
      await saveSources(context, merged);
      return Response.json({ sources: merged });
    }

    // DELETE /api/git/sources?name= — remove a whole repo (and its deployments).
    if (url.pathname === "/api/git/sources" && req.method === "DELETE") {
      const name = url.searchParams.get("name");
      if (!name) return Response.json({ error: "missing name" }, { status: 422 });
      const sources = await loadSources(context);
      const merged = sources.filter((s) => s.name !== name);
      await saveSources(context, merged);
      return Response.json({ sources: merged });
    }

    // POST /api/git/sync — { repo, deployment, dryRun? }. dryRun → kubectl diff
    // (preview); otherwise clone + apply, then record the synced sha/status on
    // that deployment.
    if (url.pathname === "/api/git/sync" && req.method === "POST") {
      let body: { repo?: string; deployment?: string; dryRun?: boolean };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!body.repo || !body.deployment) return Response.json({ error: "missing repo or deployment" }, { status: 422 });
      const sources = await loadSources(context);
      const repo = sources.find((s) => s.name === body.repo);
      const dep = repo?.deployments.find((d) => d.name === body.deployment);
      if (!repo || !dep) return Response.json({ error: "unknown deployment" }, { status: 404 });
      const token = await loadGithubToken(context);
      const target = resolveTarget(repo, dep);
      if (body.dryRun === true) {
        return Response.json(await diffSource(context, target, token));
      }
      const res = await applySource(context, target, token);
      const updatedDep: GitDeployment = {
        ...dep,
        lastSyncedSha: res.sha ?? dep.lastSyncedSha,
        lastSyncedAt: new Date().toISOString(),
        lastStatus: res.code === 0 ? "ok" : "error",
        lastMessage: res.code === 0 ? "" : (res.stderr || res.stdout).slice(0, 500),
      };
      const updatedRepo: GitSource = { ...repo, deployments: repo.deployments.map((d) => (d.name === dep.name ? updatedDep : d)) };
      await saveSources(context, sources.map((s) => (s.name === repo.name ? updatedRepo : s)));
      return Response.json(res);
    }

    // POST /api/git/propose-fix — AI fix → pull request (feature 3c). Body:
    // { source, filePath, content, title, body?, dryRun? }. dryRun → git diff
    // preview; otherwise branch + commit + push + open a PR via the GitHub API.
    if (url.pathname === "/api/git/propose-fix" && req.method === "POST") {
      let body: { source?: string; filePath?: string; content?: string; title?: string; body?: string; dryRun?: boolean };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!body.source || !body.filePath || typeof body.content !== "string" || !body.title) {
        return Response.json({ error: "missing source, filePath, content, or title" }, { status: 422 });
      }
      const sources = await loadSources(context);
      // `source` is the deployment's provenance id (the value of the
      // helmsman.dev/source-repo annotation stamped on the workload).
      const found = findByDeployment(sources, body.source);
      if (!found) return Response.json({ error: "unknown source" }, { status: 404 });
      const token = await loadGithubToken(context);
      const input = { source: resolveTarget(found.repo, found.dep), token, filePath: body.filePath, content: body.content, title: body.title, body: body.body };
      if (body.dryRun === true) return Response.json(await previewRepoFix(input));
      return Response.json(await proposeRepoFix(input));
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

    // POST /api/portforward — kubectl port-forward subprocess manager
    // (docs/parity/portforward.md). Dispatches on `action`:
    //   start → spawn `kubectl port-forward svc/<name> <local>:<remote> -n <ns>`,
    //           returns { ok:true, forward } (status "starting"; polls to running).
    //   stop  → SIGTERM the child for `id`, returns { ok:true }.
    //   list  → { forwards: ActiveForward[] }.
    // The forward binds the SERVER's loopback (127.0.0.1) — reachable from the
    // host only when the server runs locally or the port is published.
    if (url.pathname === "/api/portforward" && req.method === "POST") {
      let body: {
        action?: "start" | "stop" | "list";
        namespace?: string;
        service?: string;
        remotePort?: number;
        localPort?: number;
        context?: string;
        targetKind?: TargetKind;
        id?: string;
      };
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }

      if (body.action === "list") {
        return Response.json({ forwards: portForwards.list() });
      }

      if (body.action === "stop") {
        if (typeof body.id !== "string" || body.id.trim() === "") {
          return Response.json({ ok: false, error: "missing id" }, { status: 422 });
        }
        const stopped = await portForwards.stop(body.id);
        if (!stopped) {
          return Response.json({ ok: false, error: "no such forward" }, { status: 404 });
        }
        return Response.json({ ok: true });
      }

      if (body.action === "start") {
        if (typeof body.namespace !== "string" || typeof body.service !== "string") {
          return Response.json(
            { ok: false, error: "missing namespace or service" },
            { status: 422 },
          );
        }
        if (typeof body.remotePort !== "number") {
          return Response.json({ ok: false, error: "missing remotePort" }, { status: 422 });
        }
        const result = portForwards.start({
          namespace: body.namespace,
          service: body.service,
          remotePort: body.remotePort,
          localPort: body.localPort,
          context: body.context,
          targetKind: body.targetKind,
        });
        if (result.kind === "error") {
          return Response.json({ ok: false, error: result.message }, { status: result.status });
        }
        return Response.json({ ok: true, forward: result.forward });
      }

      return Response.json({ error: "unknown action" }, { status: 422 });
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
if (!passwordConfigured() && TOKEN === null) {
  console.warn(
    "⚠️  helmsman: NO AUTH configured — anyone who can reach this can run cluster-admin commands. " +
      "Set HELMSMAN_PASSWORD (browser login) before exposing it beyond a trusted/private network.",
  );
}

// Shutdown hook: kill every port-forward child so no zombie kubectl survives the
// server. SIGINT/SIGTERM both run stopAll() before exiting.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void portForwards.stopAll().finally(() => process.exit(0));
  });
}
