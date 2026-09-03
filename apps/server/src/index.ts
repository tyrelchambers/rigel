import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
import { serve } from "@hono/node-server";
import { serveStatic } from "./staticFiles";
import { WebSocketServer } from "ws";
import { resolveKubeconfigPath } from "./kubeconfig";
import { kubectl, onSpawnFailure, runProcess, buildKubectlArgs } from "@rigel/k8s/src/run";
import { WatchManager } from "./watchManager";
import { makeWsHandlers } from "./ws";
import { resolveRequestContext } from "./requestContext";
import { discoverAccess, seedFromKubeconfig, type Access } from "./access";
import { buildCommand, PurgeActionError, type ActionBlock } from "./actions";
import { applyManifest, deleteManifest, installHelm } from "./install";
import {
  buildHelmRollbackArgs,
  buildHelmUninstallArgs,
  validateHelmInstall,
  validateHelmTarget,
  isSafeHelmArg,
  isHttpRepoURL,
  type HelmChartSource,
} from "@rigel/k8s/src/helm";
import { browseArtifactHub } from "./artifactHub";
import { discover, handlePurge, type PurgeRequest } from "./purge";
import { planAdoption, relatedTo } from "./adopt";
import { discoverRecent, undoBatch } from "./recentDeploys";
import {
  loadSources, saveSources, diffSource, applySource, previewRepoFix, proposeRepoFix, parseProposeFixRequest,
  mergePullRequest,
  loadGithubToken, githubAccountStatus, connectGithub, disconnectGithub, listGithubRepos, listRepoTree, readRepoFile,
  linkRepo, resolveDeploymentLink, ClusterWriteError, githubPrStatus,
  loadPullRequests, recordChatPullRequest,
} from "./git";
import {
  sanitizeSourceName,
  normalizeManifestPath,
  resolveTarget,
  findByDeployment,
  upsertDeployment,
  parseRepoSlug,
  type GitSource,
  type GitDeployment,
} from "@rigel/k8s/src/gitSources";
import { getPodMetrics, getNodeMetrics, getNodeDisk } from "./metrics";
import { listContexts } from "./contexts";
import { detectClusterTools } from "./clusterTools";
import { requiredTools } from "./requiredTools";
import { toolForContext, buildKindDeleteArgs, buildK3dDeleteArgs } from "./clusterCreate";
import { backupKubeconfig } from "./kubeconfigBackup";
import {
  cloudCheck, cloudListClusters, cloudConnect, cloudHealth, importKubeconfig, cloudParamOptions,
} from "./cloudConnect";
import { disconnectContext } from "./disconnectContext";
import { canConnect, setEntitlement, canBeAutonomous, unlockedAuditsEnv, type ConnectTarget, type EntitlementPayload } from "./entitlements";
import { cloudGateResponse } from "./cloudGate";
import type { CloudCluster } from "@rigel/cloud-connect/src/index";
import { getUsageHistory, detectAllBackends, flavorForPort } from "./prometheusMetrics";
import { handleUpdates, type UpdatesRequest } from "./updates";
import { chatConfig, setClaudeToken } from "./chatConfig";
import { voiceStatus, voiceEnabled, setVoiceConfig, voiceConfig, missingVoiceFields } from "./voiceConfig";
import { failoverConfigView, failoverPatchFromBody, readFailoverDestination, writeFailoverPatch } from "./failoverConfig";
import {
  confirmEdge,
  planFailover,
  readFailoverLiveState,
  rewritesFromBody,
  scaleHome,
  selectionFromBody,
  teardownLeftBehind,
} from "./failoverRun";
import { loadFailoverJob, startFailoverJob, startRestoreJob } from "./failoverJob";
import { readIssueMutes, writeIssueMutes } from "./issuesConfig";
import { parseIssueMutes } from "@rigel/k8s/src/issues/mutes";
import { mintVoiceToken, agentConfigResponse, checkWorkerToken, isVoiceWorkerRequest, maskedVoiceConfig, voiceConfigPatch, VOICE_WORKER_HEADER, type VoiceRole } from "./voiceRoutes";
import { recordAiAction } from "./aiActionLedger";
import { buildAiActionEntry, summarizeActionDetail } from "@rigel/k8s/src/aiActionLedger";
import { agentsView, setAgentAuth, setActiveAgent } from "./agentConfig";
import { agentModels } from "./agentModels";
import { getAgent, type AgentAuthMethod } from "./agentRegistry";
import { buildSuggestions } from "./suggestions";
import { getClusterYamlSchema } from "./clusterSchema";
import { getApiResources } from "./apiResources";
import { runCanI, type Subject, type CanICheck, type CanIResult } from "./rbacCanI";
import { stripStatusBlock } from "@rigel/k8s/src/manifestClean";
import { handleAssistant, isAutonomyRequest, bumpAgentEntitlementRefresh, startRbacReconcileLoop, type AssistantRequest } from "./assistant";
import { handleSignal, type SignalRequest } from "./signal";
import { handleMatrix, type MatrixRequest } from "./matrix";
import { handleChannelTest, type ChannelTestRequest } from "./channels";
import { PortForwardManager, type TargetKind } from "./portForward";
import { makeFatalHandler } from "./fatalHandler";
import { checkSessionSecret } from "./sessionAuth";

const KUBECONFIG = resolveKubeconfigPath(process.env, homedir());
const PORT = Number(process.env.PORT ?? 8787);
// Electron sets 127.0.0.1 (loopback-only); Docker/Helm keep 0.0.0.0.
const HOST = process.env.HOST ?? "0.0.0.0"; // Electron pins 127.0.0.1; Docker/Helm keep 0.0.0.0
const SESSION_SECRET = process.env.RIGEL_SESSION_SECRET ?? "";
if (!SESSION_SECRET) console.warn("RIGEL_SESSION_SECRET not set — local /api/* + /ws access control is DISABLED");

// Electron utilityProcess only; no-op (and inert) elsewhere.
(process as unknown as { parentPort?: { on(ev: string, cb: (e: { data?: unknown }) => void): void } }).parentPort?.on(
  "message",
  (e: { data?: unknown }) => {
    const m = e?.data as { type?: string; value?: EntitlementPayload | null } | undefined;
    if (m?.type === "entitlement") {
      const wasAutonomous = canBeAutonomous();
      setEntitlement(m.value ?? null);
      if (wasAutonomous !== canBeAutonomous()) {
        void bumpAgentEntitlementRefresh().then(
          (r) => console.log(`entitlement bump: refreshed ${r.bumped.length} agent(s)${r.failures.length ? `, ${r.failures.length} failed` : ""}`),
          (err) => console.error("entitlement bump failed:", err),
        );
      }
    }
  },
);

// Upstream metrics-server manifest (onboarding one-click install).
const METRICS_SERVER_URL =
  "https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml";

// Built web UI. Default resolves to apps/web/dist relative to this file, which
// holds whether running from source (apps/server/src) or in the container
// (/app/apps/server/src). Override with WEB_DIST if the layout differs.
const WEB_DIST = process.env.WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname;

const ctxRes = await kubectl(null, ["config", "current-context"]);
const bootContext = ctxRes.code === 0 ? ctxRes.stdout.trim() : null;

const mgr = new WatchManager(bootContext);

// Pre-warm the always-present built-in kinds so the first client subscribe is an
// instant warm hit (cache already populated, no LIST/spawn on the critical path).
// These are pinned watches: kept fresh from their delta streams and never
// idle-stopped. Deliberately excludes "events" (high volume) and any CRD
// (cert-manager / cnpg) — those stay on-demand.
const CORE_KINDS = [
  "pods",
  "deployments",
  "statefulsets",
  "daemonsets",
  "services",
  "ingresses",
  "configmaps",
  "secrets",
  "namespaces",
  "nodes",
];
const runKubectl = (args: string[]) => runProcess("kubectl", args);

const accessCache = new Map<string, Promise<Access>>();
function accessFor(ctx: string | null): Promise<Access> {
  const key = ctx ?? "";
  let p = accessCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const seed = await seedFromKubeconfig(ctx, runKubectl);
        const a = await discoverAccess({ context: ctx, seedNamespaces: seed, run: runKubectl });
        if (a.indeterminate) accessCache.delete(key);
        return a;
      } catch {
        accessCache.delete(key);
        return { mode: "cluster-wide", namespaces: [] } as Access;
      }
    })();
    accessCache.set(key, p);
  }
  return p;
}
const bootAccessReady = accessFor(bootContext).then((a) => {
  if (a.mode === "cluster-wide") mgr.prewarm(CORE_KINDS, "*");
  return a;
});

// Port-forward subprocess registry (docs/parity/portforward.md). One instance
// for the server's lifetime; killed wholesale on shutdown so no zombie kubectl
// survives. The forwards bind the SERVER's 127.0.0.1 — see the module caveat.
const portForwards = new PortForwardManager(bootContext);

// Config writes land in a per-cluster Secret, so an unreachable cluster is the
// expected failure and must reach the UI as its own message, not a bare 500.
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function handler(req: Request): Promise<Response> {
  {
    const url = new URL(req.url);
    const context = resolveRequestContext(req.headers.get("x-rigel-context"), bootContext);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname.startsWith("/api/") && !checkSessionSecret(req.headers.get("x-rigel-session"), SESSION_SECRET)) {
      return new Response("unauthorized", { status: 401 });
    }

    // GET /api/contexts — all selectable kubeconfig contexts (for the cluster
    // rail). { contexts: ClusterContext[] }; the active one is current-context.
    if (url.pathname === "/api/contexts" && req.method === "GET") {
      return Response.json({ contexts: await listContexts() });
    }

    // GET /api/cluster-tools — are kind/k3d installed and is Docker running?
    // Drives the create-cluster modal's detect-and-guide UI. Always HTTP 200.
    if (url.pathname === "/api/cluster-tools" && req.method === "GET") {
      return Response.json(await detectClusterTools());
    }

    // POST /api/cluster/delete { context } — delete a LOCAL kind/k3d cluster Rigel
    // can identify (refused for any other context). Backs up the kubeconfig first.
    if (url.pathname === "/api/cluster/delete" && req.method === "POST") {
      let body: { context?: string };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      const target = typeof body.context === "string" ? toolForContext(body.context) : null;
      if (!target) {
        return Response.json({ error: "not a local kind/k3d cluster" }, { status: 422 });
      }
      const backupPath = await backupKubeconfig(KUBECONFIG);
      const argv = target.tool === "kind" ? buildKindDeleteArgs(target.name) : buildK3dDeleteArgs(target.name);
      const result = await runProcess(target.tool, argv);
      return Response.json({ ok: result.code === 0, backupPath, stdout: result.stdout, stderr: result.stderr });
    }

    // POST /api/cluster/disconnect { context } — remove a connected cluster's kubeconfig
    // context (disconnect). Does NOT touch the remote cluster. Backs up the kubeconfig first.
    if (url.pathname === "/api/cluster/disconnect" && req.method === "POST") {
      let body: { context?: string };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (typeof body.context !== "string") {
        return Response.json({ error: "context required" }, { status: 422 });
      }
      return Response.json(await disconnectContext(body.context, { kubeconfigPath: KUBECONFIG }));
    }

    // POST /api/cloud/check { provider } — is the provider CLI installed + logged in?
    // Read-only; always HTTP 200 with a status payload.
    if (url.pathname === "/api/cloud/check" && req.method === "POST") {
      let body: { provider?: string };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (typeof body.provider !== "string") {
        return Response.json({ error: "provider required" }, { status: 422 });
      }
      return Response.json(await cloudCheck(body.provider));
    }

    // POST /api/cloud/clusters { provider, params } — list the user's clusters. 200.
    if (url.pathname === "/api/cloud/clusters" && req.method === "POST") {
      let body: { provider?: string; params?: Record<string, string> };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (typeof body.provider !== "string") {
        return Response.json({ error: "provider required" }, { status: 422 });
      }
      return Response.json(await cloudListClusters(body.provider, body.params ?? {}));
    }

    // POST /api/cloud/param-options { provider, key } — dropdown options + default
    // for a required connect param (AWS region, GCP project). Read-only. 200.
    if (url.pathname === "/api/cloud/param-options" && req.method === "POST") {
      let body: { provider?: string; key?: string };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (typeof body.provider !== "string" || typeof body.key !== "string") {
        return Response.json({ error: "provider and key required" }, { status: 422 });
      }
      return Response.json(await cloudParamOptions(body.provider, body.key));
    }

    // POST /api/cloud/connect { provider, cluster, params } — write the kubeconfig
    // context (backs up first). The canConnect seam gates this (allow-all today).
    if (url.pathname === "/api/cloud/connect" && req.method === "POST") {
      let body: { provider?: string; cluster?: CloudCluster; params?: Record<string, string> };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (typeof body.provider !== "string" || !body.cluster?.id) {
        return Response.json({ error: "provider and cluster required" }, { status: 422 });
      }
      const gate = canConnect(body.provider as ConnectTarget);
      if (!gate.allowed) {
        return Response.json({ error: gate.reason ?? "upgrade required", gated: true }, { status: 402 });
      }
      return Response.json(
        await cloudConnect(body.provider, body.cluster, body.params ?? {}, { kubeconfigPath: KUBECONFIG }),
      );
    }

    // POST /api/cloud/health { provider, context } — probe a connected context. 200.
    if (url.pathname === "/api/cloud/health" && req.method === "POST") {
      let body: { provider?: string; context?: string };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (typeof body.provider !== "string" || typeof body.context !== "string") {
        return Response.json({ error: "provider and context required" }, { status: 422 });
      }
      return Response.json(await cloudHealth(body.provider, body.context));
    }

    // POST /api/cloud/import { kubeconfig } — merge a pasted kubeconfig (backs up first).
    if (url.pathname === "/api/cloud/import" && req.method === "POST") {
      let body: { kubeconfig?: string };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (typeof body.kubeconfig !== "string" || body.kubeconfig.trim() === "") {
        return Response.json({ error: "kubeconfig required" }, { status: 422 });
      }
      const gate = canConnect("import");
      if (!gate.allowed) {
        return Response.json({ error: gate.reason ?? "upgrade required", gated: true }, { status: 402 });
      }
      return Response.json(await importKubeconfig(body.kubeconfig, { kubeconfigPath: KUBECONFIG }));
    }

    // Monetization (HELM-16): on Free, block every context-scoped /api/* call
    // whose resolved context is a cloud provider — however it entered the
    // kubeconfig. Exempts health/contexts/cloud-connect/delete/disconnect so a
    // Free user can still see and remove a locked cloud cluster.
    const cloudGate = await cloudGateResponse(url.pathname, context);
    if (cloudGate) return cloudGate;

    // Serve the built web UI for everything that isn't an API or WS path.
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/ws") {
      return serveStatic(WEB_DIST, url.pathname);
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

    // GET  /api/chat-config — reports whether a Claude token is present. Chat
    // ENABLEMENT now follows the ACTIVE agent's connection (see /api/agents);
    // this route remains for the Claude-specific Settings/token surface.
    // POST /api/chat-config { token } — set it (empty clears); env-set tokens
    // take precedence and are not overwritten. Lets a self-hoster enable chat
    // from the Settings screen without an env restart.
    if (url.pathname === "/api/chat-config" && req.method === "GET") {
      return Response.json(await chatConfig(context));
    }
    if (url.pathname === "/api/chat-config" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { token?: unknown };
      try {
        await setClaudeToken(context, typeof body.token === "string" ? body.token : "");
      } catch (err) {
        return Response.json({ error: errorText(err) }, { status: 503 });
      }
      return Response.json(await chatConfig(context));
    }

    if (url.pathname === "/api/agents" && req.method === "GET") {
      return Response.json(await agentsView(context));
    }

    // POST /api/agents/active  { id } — switch the active agent.
    if (url.pathname === "/api/agents/active" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { id?: unknown };
      const id = typeof body.id === "string" ? body.id : "";
      const agent = getAgent(id);
      if (!agent) return Response.json({ error: "unknown agent" }, { status: 404 });
      if (agent.status === "comingSoon") {
        return Response.json({ error: "agent not available yet" }, { status: 409 });
      }
      try {
        return Response.json(await setActiveAgent(agent.id, context));
      } catch (err) {
        return Response.json({ error: errorText(err) }, { status: 503 });
      }
    }

    // POST /api/agents/<id>/auth  { authMethod, secret? }
    if (
      url.pathname.startsWith("/api/agents/") &&
      url.pathname.endsWith("/auth") &&
      req.method === "POST"
    ) {
      const id = url.pathname.split("/")[3] ?? "";
      const agent = getAgent(id);
      if (!agent) return Response.json({ error: "unknown agent" }, { status: 404 });
      if (agent.status === "comingSoon") {
        return Response.json({ error: "agent not available yet" }, { status: 409 });
      }
      const body = (await req.json().catch(() => ({}))) as {
        authMethod?: unknown;
        secret?: unknown;
      };
      const authMethod = body.authMethod === "apiKey" ? "apiKey" : "subscription";
      if (!agent.authMethods.includes(authMethod as AgentAuthMethod)) {
        return Response.json({ error: "unsupported auth method" }, { status: 400 });
      }
      const secret = typeof body.secret === "string" ? body.secret : "";
      if (authMethod === "apiKey" && !secret.trim()) {
        return Response.json({ error: "an API key is required" }, { status: 400 });
      }
      try {
        return Response.json(await setAgentAuth(agent.id, { authMethod, secret }, context));
      } catch (err) {
        return Response.json({ error: errorText(err) }, { status: 503 });
      }
    }

    // GET /api/agents/<id>/models — the models + efforts this agent can run, for
    // the composer's agent-aware model picker. claude/codex are static sets;
    // opencode is discovered live via `opencode models`. 404 for an unknown id.
    if (
      url.pathname.startsWith("/api/agents/") &&
      url.pathname.endsWith("/models") &&
      req.method === "GET"
    ) {
      const id = url.pathname.split("/")[3] ?? "";
      const agent = getAgent(id);
      if (!agent) return Response.json({ error: "unknown agent" }, { status: 404 });
      return Response.json(await agentModels(agent.id));
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

      // Execute mode: run kubectl and return the result. Preview returned
      // above, so only a command that actually ran reaches the ledger.
      const result = await kubectl(context, argv);
      const outcome = result.code === 0 ? "success" : "failure";
      void recordAiAction(
        context,
        buildAiActionEntry({
          action: body,
          source: isVoiceWorkerRequest(req) ? "voice" : "chat",
          command: ["kubectl", ...buildKubectlArgs(context, argv)].join(" "),
          outcome,
          detail: summarizeActionDetail(outcome, result.stdout, result.stderr),
        }),
      );
      return Response.json(result);
    }

    // POST /api/ai/unsupported — the operator asked for something no action
    // kind expresses. Recorded rather than dropped: a vocabulary gap nobody can
    // see is one that gets rediscovered one frustrating session at a time, and
    // this is the ledger the app already keeps of what its assistants did.
    if (url.pathname === "/api/ai/unsupported" && req.method === "POST") {
      let body: { request?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const request = (body.request ?? "").trim();
      if (!request) return Response.json({ error: "missing request" }, { status: 422 });
      await recordAiAction(
        context,
        buildAiActionEntry({
          action: { kind: "unsupported" },
          source: isVoiceWorkerRequest(req) ? "voice" : "chat",
          command: "",
          outcome: "unsupported",
          trigger: request,
        }),
      );
      return Response.json({ ok: true });
    }

    // GET /api/voice/status: is the voice feature flag on, and is it configured.
    if (url.pathname === "/api/voice/status" && req.method === "GET") {
      return Response.json(await voiceStatus(context));
    }

    // GET /api/voice/config: the Settings view of the credentials. Masked: the
    // renderer holds the session secret, and stored secrets never cross to it.
    // PUT /api/voice/config: a partial patch. An absent field is left alone, an
    // empty string clears it. Env-supplied fields still win in voiceConfig(),
    // so the panel reports them instead of offering them for edit.
    if (url.pathname === "/api/voice/config" && req.method === "GET") {
      return Response.json(await maskedVoiceConfig(context));
    }
    if (url.pathname === "/api/voice/config" && req.method === "PUT") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      try {
        await setVoiceConfig(context, voiceConfigPatch(body));
      } catch (err) {
        return Response.json({ error: errorText(err) }, { status: 503 });
      }
      return Response.json(await maskedVoiceConfig(context));
    }

    // GET /api/failover/config: destination with secrets as set/unset booleans.
    // PUT /api/failover/config: patch. Omitted secrets keep the stored value.
    if (url.pathname === "/api/failover/config" && req.method === "GET") {
      return Response.json(await failoverConfigView(context));
    }
    if (url.pathname === "/api/failover/config" && req.method === "PUT") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      try {
        return Response.json(await writeFailoverPatch(context, failoverPatchFromBody(body)));
      } catch (err) {
        const message = errorText(err);
        const status = /required/.test(message) ? 422 : 503;
        return Response.json({ error: message }, { status });
      }
    }

    if (url.pathname === "/api/failover/state" && req.method === "GET") {
      return Response.json(await readFailoverLiveState(context));
    }
    if (url.pathname === "/api/failover/plan" && req.method === "POST") {
      let body: unknown;
      try { body = await req.json(); }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      const selection = selectionFromBody(body);
      if (!selection) return Response.json({ error: "selection required" }, { status: 422 });
      const dest = await readFailoverDestination(context);
      const plan = await planFailover(context, selection, rewritesFromBody(body), dest?.nodeCount ?? 1);
      return Response.json(plan);
    }
    // POST /api/failover/run starts a job and returns at once. Provisioning,
    // dumping and restoring take many minutes, which is longer than any request
    // should be held open. Progress is read from /api/failover/run/status.
    if (url.pathname === "/api/failover/run" && req.method === "POST") {
      let body: unknown;
      try { body = await req.json(); }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      const selection = selectionFromBody(body);
      if (!selection) return Response.json({ error: "selection required" }, { status: 422 });
      try {
        const job = startFailoverJob(context, selection, rewritesFromBody(body));
        return Response.json(job, { status: 202 });
      } catch (err) {
        const status = (err as { status?: number }).status === 409 ? 409 : 503;
        return Response.json({ error: errorText(err) }, { status });
      }
    }
    if (url.pathname === "/api/failover/run/status" && req.method === "GET") {
      const job = await loadFailoverJob(context);
      if (!job) return Response.json({ status: "idle", steps: [] });
      return Response.json(job);
    }
    if (url.pathname === "/api/failover/confirm-edge" && req.method === "POST") {
      try { return Response.json(await confirmEdge(context)); }
      catch (err) { return Response.json({ error: errorText(err) }, { status: 409 }); }
    }
    if (url.pathname === "/api/failover/scale-home" && req.method === "POST") {
      try { return Response.json(await scaleHome(context)); }
      catch (err) {
        const status = (err as { status?: number }).status === 409 ? 409 : 503;
        return Response.json({ error: errorText(err) }, { status });
      }
    }
    if (url.pathname === "/api/failover/restore" && req.method === "POST") {
      let body: { localWriteAt?: string } = {};
      try { body = (await req.json()) as typeof body; } catch { /* empty body is fine */ }
      try {
        return Response.json(startRestoreJob(context, { localWriteAt: body.localWriteAt }), { status: 202 });
      } catch (err) {
        const status = (err as { status?: number }).status === 409 ? 409 : 503;
        return Response.json({ error: errorText(err) }, { status });
      }
    }
    // A teardown that failed during a restore leaves a cluster billing by the
    // hour. This is the way back to it.
    if (url.pathname === "/api/failover/teardown" && req.method === "POST") {
      const out = await teardownLeftBehind(context);
      return Response.json(out, { status: out.ok ? 200 : 409 });
    }

    // GET /api/issues/config: this cluster's issue mutes, keyed by fingerprint.
    // PUT /api/issues/config: replace the whole map.
    if (url.pathname === "/api/issues/config" && req.method === "GET") {
      return Response.json({ mutes: await readIssueMutes(context) });
    }
    if (url.pathname === "/api/issues/config" && req.method === "PUT") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const mutes = parseIssueMutes(JSON.stringify((body as { mutes?: unknown })?.mutes ?? {}));
      try {
        await writeIssueMutes(context, mutes);
      } catch (err) {
        return Response.json({ error: errorText(err) }, { status: 503 });
      }
      return Response.json({ mutes });
    }

    // POST /api/voice/token: mint a room JWT for the renderer (or a phone, for
    // the spike). The LiveKit API secret never leaves this process.
    if (url.pathname === "/api/voice/token" && req.method === "POST") {
      if (!voiceEnabled()) return Response.json({ error: "voice is disabled" }, { status: 404 });
      const body = (await req.json().catch(() => ({}))) as { role?: string };
      const role: VoiceRole = body.role === "phone" ? "phone" : "desktop";
      const minted = await mintVoiceToken(role, context);
      if (!minted) return Response.json({ error: "voice is not configured" }, { status: 409 });
      return Response.json(minted);
    }

    // GET /api/voice/agent-config: the worker's bootstrap, a room JWT + provider
    // keys. Gated by the worker token so the renderer (which holds only the
    // session secret) can never read provider keys.
    if (url.pathname === "/api/voice/agent-config" && req.method === "GET") {
      if (!voiceEnabled()) return Response.json({ error: "voice is disabled" }, { status: 404 });
      if (!checkWorkerToken(req.headers.get(VOICE_WORKER_HEADER))) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      const cfg = await agentConfigResponse(context);
      if (!cfg) {
        const { config } = await voiceConfig(context);
        return Response.json(
          { error: "voice is not configured", missing: missingVoiceFields(config) },
          { status: 409 },
        );
      }
      return Response.json(cfg);
    }

    // POST /api/apply — MANIFEST apply, used by the catalog wizard and the
    // Apply YAML panel. Feeds the multi-doc YAML to `kubectl apply -f -` via
    // STDIN (never shell-interpolated). `dryRun` runs --dry-run=server so the
    // apiserver validates without persisting. Returns { code, stdout, stderr }.
    if (url.pathname === "/api/apply" && req.method === "POST") {
      let body: { yaml?: string; dryRun?: boolean; source?: string };
      try {
        body = (await req.json()) as { yaml?: string; dryRun?: boolean; source?: string };
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.yaml !== "string" || body.yaml.trim() === "") {
        return Response.json({ error: "missing yaml" }, { status: 422 });
      }
      const result = await applyManifest(context, body.yaml, body.dryRun === true, body.source);
      return Response.json(result);
    }

    // POST /api/delete — MANIFEST delete (the uninstall counterpart of /api/apply).
    // Feeds the multi-doc YAML to `kubectl delete -f - --ignore-not-found` via
    // STDIN. Used to remove a backend set Rigel installed. Returns { code, stdout, stderr }.
    if (url.pathname === "/api/delete" && req.method === "POST") {
      let body: { yaml?: string };
      try {
        body = (await req.json()) as { yaml?: string };
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.yaml !== "string" || body.yaml.trim() === "") {
        return Response.json({ error: "missing yaml" }, { status: 422 });
      }
      const result = await deleteManifest(context, body.yaml);
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

    // GET /api/api-resources — distinct resource names + API groups for the
    // active context, for the RBAC role editor's rule autocompletion.
    if (url.pathname === "/api/api-resources" && req.method === "GET") {
      return Response.json(await getApiResources(context));
    }

    // POST /api/rbac/can-i — impersonated `kubectl auth can-i` for the RBAC
    // panel's inline access test. Read-only; no confirm gate.
    if (url.pathname === "/api/rbac/can-i" && req.method === "POST") {
      let subjects: Subject[] = [];
      let checks: CanICheck[] = [];
      try {
        const body = (await req.json()) as { subjects?: Subject[]; checks?: CanICheck[] };
        subjects = body.subjects ?? [];
        checks = body.checks ?? [];
      } catch {
        // empty/invalid body → empty result
      }
      // Bound the fan-out of sequential kubectl execs (client already caps).
      subjects = subjects.slice(0, 25);
      checks = checks.slice(0, 50);
      const run = (args: string[]) => kubectl(context, args);
      const results: Array<{ subject: Subject; checks: CanIResult[] }> = [];
      let note: string | undefined;
      for (const subject of subjects) {
        const r = await runCanI(subject, checks, run);
        if (r.note) note = r.note;
        results.push({ subject, checks: r.results });
      }
      return Response.json({ results, note });
    }

    // POST /api/install/metrics-server — one-click upstream metrics-server for
    // onboarding and the Overview empty state (enables `kubectl top` → live node
    // CPU/memory; right-sizing history is a separate Prometheus/VM backend).
    // Applies the official components.yaml, then best-effort adds
    // --kubelet-insecure-tls (the common homelab/k3s/kind fix for self-signed
    // kubelet certs). Always 200 with { code, stdout, stderr } from the apply.
    if (url.pathname === "/api/install/metrics-server" && req.method === "POST") {
      let kubeletInsecureTls = true;
      try {
        const body = (await req.json()) as { kubeletInsecureTls?: boolean };
        if (typeof body?.kubeletInsecureTls === "boolean") kubeletInsecureTls = body.kubeletInsecureTls;
      } catch {
        // no body → keep the default (true)
      }
      const apply = await kubectl(context, ["apply", "-f", METRICS_SERVER_URL]);
      if (apply.code === 0 && kubeletInsecureTls) {
        // Tolerate failure: not every cluster needs/accepts the flag.
        await kubectl(context, [
          "patch", "deployment", "metrics-server", "-n", "kube-system", "--type=json",
          "-p", '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]',
        ]);
      }
      return Response.json(apply);
    }

    // POST /api/uninstall/metrics-server — delete the upstream metrics-server manifest.
    if (url.pathname === "/api/uninstall/metrics-server" && req.method === "POST") {
      const del = await kubectl(context, ["delete", "-f", METRICS_SERVER_URL, "--ignore-not-found"]);
      return Response.json(del);
    }

    // POST /api/helm — catalog wizard HELM install. Runs repo add (idempotent)
    // → repo update → upgrade --install in sequence. Returns { code, stdout, stderr }.
    if (url.pathname === "/api/helm" && req.method === "POST") {
      let body: { repoName?: string; repoURL?: string; chart?: string; version?: string | null; releaseName?: string; namespace?: string; values?: string };
      try {
        body = (await req.json()) as typeof body;
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
      const source: HelmChartSource = {
        kind: "repo",
        repoName: body.repoName,
        repoURL: body.repoURL,
        chart: body.chart,
        version: body.version ?? null,
      };
      const invalid = validateHelmInstall(source, body.releaseName, body.namespace);
      if (invalid) return Response.json({ error: invalid }, { status: 422 });
      const result = await installHelm(context, {
        source,
        releaseName: body.releaseName,
        namespace: body.namespace,
        values: body.values,
      });
      return Response.json(result);
    }

    // POST /api/helm/install — custom-chart install/upgrade (repo | oci | local).
    if (url.pathname === "/api/helm/install" && req.method === "POST") {
      let body: { source?: HelmChartSource; releaseName?: string; namespace?: string; values?: string };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (!body.source || !body.releaseName || !body.namespace || typeof body.values !== "string") {
        return Response.json({ error: "missing required fields (source, releaseName, namespace, values)" }, { status: 422 });
      }
      const invalid = validateHelmInstall(body.source, body.releaseName, body.namespace);
      if (invalid) return Response.json({ error: invalid }, { status: 422 });
      const result = await installHelm(context, {
        source: body.source, releaseName: body.releaseName, namespace: body.namespace, values: body.values,
      });
      return Response.json(result);
    }

    // POST /api/helm/rollback — { release, revision, namespace }
    if (url.pathname === "/api/helm/rollback" && req.method === "POST") {
      let body: { release?: string; revision?: number; namespace?: string };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (!body.release || typeof body.revision !== "number" || !body.namespace) {
        return Response.json({ error: "missing required fields (release, revision, namespace)" }, { status: 422 });
      }
      const invalid = validateHelmTarget(body.release, body.namespace);
      if (invalid) return Response.json({ error: invalid }, { status: 422 });
      const result = await runProcess("helm", buildHelmRollbackArgs(body.release, body.revision, body.namespace, context));
      return Response.json(result);
    }

    // POST /api/helm/uninstall — { release, namespace }
    if (url.pathname === "/api/helm/uninstall" && req.method === "POST") {
      let body: { release?: string; namespace?: string };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (!body.release || !body.namespace) {
        return Response.json({ error: "missing required fields (release, namespace)" }, { status: 422 });
      }
      const invalid = validateHelmTarget(body.release, body.namespace);
      if (invalid) return Response.json({ error: invalid }, { status: 422 });
      const result = await runProcess("helm", buildHelmUninstallArgs(body.release, body.namespace, context));
      return Response.json(result);
    }

    // GET /api/helm/browse?q=&sort=&official=&verified=&offset=&limit= — Artifact Hub chart browse/search
    if (url.pathname === "/api/helm/browse" && req.method === "GET") {
      const sp = url.searchParams;
      const sortParam = sp.get("sort");
      const result = await browseArtifactHub({
        query: sp.get("q") ?? undefined,
        sort: sortParam === "stars" || sortParam === "relevance" ? sortParam : undefined,
        official: sp.get("official") === "true",
        verified: sp.get("verified") === "true",
        // Builder owns defaults/clamping; absent → undefined, invalid → NaN, both fall back there.
        offset: sp.has("offset") ? Number(sp.get("offset")) : undefined,
        limit: sp.has("limit") ? Number(sp.get("limit")) : undefined,
      });
      return Response.json(result);
    }

    // GET /api/helm/show-values?ref=&version= — default chart values for the install form
    if (url.pathname === "/api/helm/show-values" && req.method === "GET") {
      const ref = url.searchParams.get("ref");
      const version = url.searchParams.get("version");
      // For a repo chart, --repo lets `helm show values <chart>` resolve without
      // a prior `helm repo add`. OCI refs and local paths resolve on their own.
      const repo = url.searchParams.get("repo");
      if (!ref) return Response.json({ error: "missing ref" }, { status: 422 });
      if (!isSafeHelmArg(ref)) return Response.json({ error: "invalid ref" }, { status: 422 });
      if (repo && !isHttpRepoURL(repo)) return Response.json({ error: "repo must be an http(s) URL" }, { status: 422 });
      if (version && !isSafeHelmArg(version)) return Response.json({ error: "invalid version" }, { status: 422 });
      const args = [
        "show",
        "values",
        ...(repo ? ["--repo", repo] : []),
        ...(version ? ["--version", version] : []),
        "--",
        ref,
      ];
      const result = await runProcess("helm", args);
      return Response.json(result);
    }

    // ── GitOps: deploy manifests from a GitHub repo ───────────────────────────
    // GET /api/git/account — GitHub connection status (connected + login).
    if (url.pathname === "/api/git/account" && req.method === "GET") {
      return Response.json(await githubAccountStatus(context));
    }

    // POST /api/git/account — { token }. Validates against the GitHub API and
    // stores it (with the login) in the rigel-github Secret.
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

    // GET /api/git/pr-status?url=<prUrl> — one PR's number + state (open/merged/closed).
    if (url.pathname === "/api/git/pr-status" && req.method === "GET") {
      const prUrl = url.searchParams.get("url");
      if (!prUrl) return Response.json({ error: "missing url" }, { status: 422 });
      const token = await loadGithubToken(context);
      if (!token) return Response.json({ error: "GitHub not connected" }, { status: 409 });
      const status = await githubPrStatus(token, prUrl);
      if (!status) return Response.json({ error: "could not read PR" }, { status: 422 });
      return Response.json(status);
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

    // GET /api/git/link?namespace=&deployment= — per-project link status. Resolves
    // the Deployment's rigel.dev/source-repo annotation against rigel-git-sources
    // → { linked, link: { source, repo: "owner/name", repoURL, branch, path } | null }.
    if (url.pathname === "/api/git/link" && req.method === "GET") {
      const namespace = url.searchParams.get("namespace");
      const deployment = url.searchParams.get("deployment");
      if (!namespace || !deployment) {
        return Response.json({ error: "missing namespace or deployment" }, { status: 422 });
      }
      return Response.json(
        await resolveDeploymentLink(context, namespace, deployment, url.searchParams.get("kind") ?? undefined),
      );
    }

    // POST /api/git/link — bind a running Deployment to a GitOps source (the
    // "Link to repo" flow). Body: { namespace, deployment, repoURL, branch?, path? }.
    // Creates/extends a rigel-git-sources entry AND stamps the live Deployment
    // with the provenance annotations (no redeploy).
    if (url.pathname === "/api/git/link" && req.method === "POST") {
      let body: { namespace?: string; deployment?: string; repoURL?: string; branch?: string; path?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!body.namespace || !body.deployment || !body.repoURL) {
        return Response.json({ error: "missing namespace, deployment, or repoURL" }, { status: 422 });
      }
      try {
        const result = await linkRepo(context, {
          namespace: body.namespace,
          deployment: body.deployment,
          repoURL: body.repoURL,
          branch: body.branch,
          path: body.path,
        });
        return Response.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A cluster WRITE failure (saveSources / annotate) is infra, not bad
        // input — surface it as 5xx so callers can distinguish it from a
        // validation/collision error (422).
        const status = err instanceof ClusterWriteError ? 500 : 422;
        return Response.json({ error: msg }, { status });
      }
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
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const parsed = parseProposeFixRequest(raw);
      if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 422 });
      const sources = await loadSources(context);
      // `source` is the deployment's provenance id (the value of the
      // rigel.dev/source-repo annotation stamped on the workload).
      const found = findByDeployment(sources, parsed.source);
      if (!found) return Response.json({ error: "unknown source" }, { status: 404 });
      const token = await loadGithubToken(context);
      const origin = isVoiceWorkerRequest(req) ? ("voice" as const) : ("chat" as const);
      const target = resolveTarget(found.repo, found.dep);
      // Adoption resolves to files here rather than in the repo-fix core,
      // because it reads the CLUSTER: discovery, export and cleaning are all
      // kubectl work, and the core's job starts once there are files to commit.
      let change: Record<string, unknown> = parsed.change as Record<string, unknown>;
      let included: string[] = [];
      if ("adopt" in parsed.change) {
        const plan = await planAdoption(context, parsed.change.adopt, normalizeManifestPath(target.path));
        if (!plan.ok) return Response.json({ ok: false, message: plan.message }, { status: 200 });
        change = { files: plan.files };
        included = plan.included ?? [];
      }
      const input = {
        source: target,
        token,
        title: parsed.title,
        body: parsed.body,
        origin,
        ...change,
      };
      if (parsed.dryRun) return Response.json({ ...(await previewRepoFix(input)), included });
      const result = await proposeRepoFix(input);
      if (result.ok && result.prUrl) {
        const slug = parseRepoSlug(input.source.repoURL);
        await recordChatPullRequest(context, {
          id: randomUUID(),
          prUrl: result.prUrl,
          number: result.number ?? 0,
          repoSlug: slug ? `${slug.owner}/${slug.repo}` : input.source.repoURL,
          repoName: found.repo.name,
          source: parsed.source,
          title: parsed.title,
          branch: result.branch ?? "",
          filePath: (result.filePaths ?? []).join(", "),
          createdAt: new Date().toISOString(),
          origin,
        });
      }
      return Response.json({ ...result, included });
    }

    // POST /api/git/merge — merge one pull request Rigel opened. Click-only:
    // the action kind is excluded from AUTO_RUNNABLE_KINDS, because the review a
    // pull request forces is exactly what makes opening one safe unattended.
    if (url.pathname === "/api/git/merge" && req.method === "POST") {
      let body: { prUrl?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!body.prUrl) return Response.json({ error: "missing prUrl" }, { status: 422 });
      const token = await loadGithubToken(context);
      if (!token) return Response.json({ error: "GitHub is not connected in Rigel" }, { status: 409 });
      return Response.json(await mergePullRequest(token, body.prUrl));
    }

    // GET /api/git/pull-requests — chat-opened PRs (the Pending PRs card).
    if (url.pathname === "/api/git/pull-requests" && req.method === "GET") {
      return Response.json({ pullRequests: await loadPullRequests(context) });
    }

    // GET /api/discover?name=&namespace=&kind= — what belongs to one workload.
    //
    // Follows what the objects state about themselves: the Service whose
    // selector matches the workload's pod labels, the Ingress whose backend
    // names that Service, and everything the pod template reads or mounts. The
    // same closure adoption commits, so what the assistant reports and what a
    // pull request would carry can never disagree.
    //
    // Deliberately NOT purge's discovery, which adds a name-prefix pass: right
    // for a removal flow the operator confirms, wrong here, where it answered a
    // question about reddex-deploy with a different app that shared a prefix.
    // Purge is still asked for the one thing it alone knows.
    if (url.pathname === "/api/discover" && req.method === "GET") {
      const name = url.searchParams.get("name");
      if (!name) return Response.json({ error: "missing name" }, { status: 422 });
      const namespace = url.searchParams.get("namespace") || "default";
      const kind = url.searchParams.get("kind") || "deployment";
      const [resources, purgeView] = await Promise.all([
        relatedTo(context, { kind, name, namespace }),
        discover(context, namespace, name),
      ]);
      return Response.json({
        name,
        namespace,
        resources,
        ...(purgeView.helmRelease ? { helmRelease: purgeView.helmRelease } : {}),
        ...(purgeView.blockedReason ? { blockedReason: purgeView.blockedReason } : {}),
      });
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

    // GET /api/deployments/recent — apply batches within the 14-day window.
    if (url.pathname === "/api/deployments/recent" && req.method === "GET") {
      return Response.json(await discoverRecent(context, Date.now()));
    }

    // POST /api/deployments/undo — delete every resource a batch created. Body:
    // { batchId, namespace } (namespace = the ledger ConfigMap's own namespace).
    if (url.pathname === "/api/deployments/undo" && req.method === "POST") {
      let body: { batchId?: string; namespace?: string };
      try {
        body = (await req.json()) as { batchId?: string; namespace?: string };
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.batchId !== "string" || body.batchId === "" || typeof body.namespace !== "string" || body.namespace === "") {
        return Response.json({ error: "missing batchId or namespace" }, { status: 422 });
      }
      return Response.json(await undoBatch(context, body.batchId, body.namespace));
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
      // Monetization (HELM-16): turning the agent autonomous requires Rigel Pro.
      // Mirrors the cloud-connect 402 { gated: true } shape the client reads.
      if (isAutonomyRequest(body) && !canBeAutonomous()) {
        return Response.json({ error: "Autonomous agent actions require Rigel Pro.", gated: true }, { status: 402 });
      }
      try {
        const result = await handleAssistant(context, body);
        if (result.code !== 0) {
          return Response.json(
            { error: result.stderr.trim() || result.stdout.trim() || `exit ${result.code}` },
            { status: 500 },
          );
        }
        return Response.json({ success: true, stdout: result.stdout, stderr: result.stderr });
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

    // POST /api/matrix — Matrix connect proxy for the desktop wizard. Outbound
    // HTTP to the user's homeserver only (no kubectl). Dispatches on `action`:
    //   login → { accessToken, userId } | validate → { userId } | createRoom → { roomId }
    if (url.pathname === "/api/matrix" && req.method === "POST") {
      let body: MatrixRequest;
      try {
        body = (await req.json()) as MatrixRequest;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.action !== "string") {
        return Response.json({ error: "missing action" }, { status: 422 });
      }
      const result = await handleMatrix(body);
      if (result.kind === "error") {
        return Response.json({ error: result.message }, { status: result.status });
      }
      return Response.json(result.body);
    }

    // POST /api/channels — Discord/Slack test-send proxy. Outbound HTTP to the
    // pasted webhook URL only (no kubectl). Dispatches on `action`:
    //   sendTest → posts the channel's test payload, returns { ok: true }.
    if (url.pathname === "/api/channels" && req.method === "POST") {
      let body: ChannelTestRequest;
      try {
        body = (await req.json()) as ChannelTestRequest;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.action !== "string") {
        return Response.json({ error: "missing action" }, { status: 422 });
      }
      const result = await handleChannelTest(body);
      if (result.kind === "error") {
        return Response.json({ error: result.message }, { status: result.status });
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
          context: body.context ?? context ?? undefined,
          targetKind: body.targetKind,
        });
        if (result.kind === "error") {
          return Response.json({ ok: false, error: result.message }, { status: result.status });
        }
        return Response.json({ ok: true, forward: result.forward });
      }

      return Response.json({ error: "unknown action" }, { status: 422 });
    }

    // Real /ws upgrades are intercepted at the HTTP layer below (before this
    // handler runs); a plain GET to /ws reaching here is not a WebSocket.
    if (url.pathname === "/ws") {
      return new Response("expected websocket", { status: 426 });
    }

    return new Response("not found", { status: 404 });
  }
}

const httpServer = serve({ fetch: handler, port: PORT, hostname: HOST }, (info) => {
  console.log(`rigel server on :${info.port} (kubeconfig=${KUBECONFIG})`);
});

// Self-heal the assistant ClusterRole back to each cluster's stored RBAC policy
// on start and on an interval, so out-of-band edits can't leave the operator's
// saved policy as anything but the source of truth.
const stopRbacReconcile = startRbacReconcileLoop();

// WebSocket upgrade wiring. node-server hands us the underlying Node http.Server,
// so we intercept the HTTP `upgrade` event ourselves and drive the `ws` server.
const wss = new WebSocketServer({ noServer: true });
const wsHandlers = makeWsHandlers(mgr, bootContext, KUBECONFIG, accessFor);
httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      if (!checkSessionSecret(url.searchParams.get("s"), SESSION_SECRET)) {
        socket.destroy();
        return;
      }
      // HELM-16: cloud-cluster gating happens per-frame in the WS handlers, not at
      // upgrade — the boot context is not the app's active context, so rejecting
      // the upgrade would brick every cluster for a Free user whose default is cloud.
      wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client));
    } catch {
      try { socket.destroy(); } catch { /* already gone */ }
    }
  })();
});
wss.on("error", (err) => console.error("websocket server error:", err));

// Missing kubectl/helm: probe once at boot, let any ENOENT from a real command
// flip it thereafter, and push every change to every connected client.
onSpawnFailure((bin, stderr) => requiredTools.noteSpawnFailure(bin, stderr));
requiredTools.subscribe((missing) => {
  const frame = JSON.stringify({ type: "tools.status", missing });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(frame);
  }
});
void requiredTools.probeAll();
wss.on("connection", (client) => {
  client.on("error", () => { try { client.close(); } catch { /* already gone */ } });
  const pending: any[] = [];
  let ready = false;
  let closed = false;
  client.on("message", (data) => {
    if (!ready) { pending.push(data); return; }
    wsHandlers.message(client, data as any);
  });
  client.on("close", () => { closed = true; wsHandlers.close(client); });
  void bootAccessReady.then((access) => {
    if (closed) return;
    wsHandlers.open(client, access);
    ready = true;
    for (const d of pending) wsHandlers.message(client, d as any);
  });
});

// Shutdown hook: kill every port-forward child so no zombie kubectl survives the
// server. SIGINT/SIGTERM both run stopAll() before exiting.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopRbacReconcile();
    void portForwards.stopAll().finally(() => process.exit(0));
  });
}

// Last-resort crash guard: log, reap port-forward children, and exit non-zero so
// the desktop supervisor restarts a clean server (the web client reconnects).
const onFatal = makeFatalHandler(
  () => portForwards.stopAll(),
  (code) => process.exit(code),
  (...args) => console.error(...args),
);
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);
