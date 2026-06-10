// @bun
var __require = import.meta.require;

// src/index.ts
import { homedir } from "os";

// src/kubeconfig.ts
import { join } from "path";
function resolveKubeconfigPath(env, home) {
  const fromEnv = env.KUBECONFIG?.trim();
  if (fromEnv)
    return fromEnv;
  return join(home, ".kube", "config");
}

// ../../packages/k8s/src/run.ts
function buildKubectlArgs(context, args) {
  return context ? ["--context", context, ...args] : args;
}
async function runProcess(bin, args) {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}
var kubectl = (context, args) => runProcess("kubectl", buildKubectlArgs(context, args));

// ../../packages/k8s/src/watch.ts
class WatchEventParser {
  buf = "";
  push(chunk, emit) {
    this.buf += chunk;
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0;i < this.buf.length; i++) {
      const c = this.buf[i];
      if (inStr) {
        if (esc)
          esc = false;
        else if (c === "\\")
          esc = true;
        else if (c === '"')
          inStr = false;
        continue;
      }
      if (c === '"')
        inStr = true;
      else if (c === "{") {
        if (depth === 0)
          start = i;
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          emit(JSON.parse(this.buf.slice(start, i + 1)));
          this.buf = this.buf.slice(i + 1);
          i = -1;
          start = -1;
        }
      }
    }
  }
}

// src/watchManager.ts
function applyEvent(cache, e) {
  const name = e.object?.metadata?.name;
  if (!name)
    return;
  if (e.type === "DELETED")
    cache.delete(name);
  else
    cache.set(name, e.object);
}
var subKey = (s) => `${s.kind}/${s.namespace}`;

class WatchManager {
  context;
  watches = new Map;
  constructor(context) {
    this.context = context;
  }
  subscribe(sub, onSnapshot, onDelta) {
    const key = subKey(sub);
    let w = this.watches.get(key);
    if (!w)
      w = this.start(sub, key);
    w.listeners.add(onDelta);
    onSnapshot([...w.cache.values()]);
    return () => {
      w.listeners.delete(onDelta);
      if (w.listeners.size === 0)
        this.stop(key);
    };
  }
  start(sub, key) {
    const nsArgs = sub.namespace === "*" ? ["--all-namespaces"] : ["-n", sub.namespace];
    const argv = [
      "kubectl",
      ...this.context ? ["--context", this.context] : [],
      "get",
      sub.kind,
      ...nsArgs,
      "--watch",
      "--output-watch-events",
      "-o",
      "json"
    ];
    const proc = Bun.spawn(argv, { stdout: "pipe" });
    const cache = new Map;
    const listeners = new Set;
    const parser = new WatchEventParser;
    const w = { proc, cache, listeners };
    this.watches.set(key, w);
    (async () => {
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder;
      for (;; ) {
        const { value, done } = await reader.read();
        if (done)
          break;
        parser.push(dec.decode(value), (e) => {
          applyEvent(cache, e);
          for (const l of listeners)
            l(e);
        });
      }
    })();
    return w;
  }
  stop(key) {
    this.watches.get(key)?.proc.kill();
    this.watches.delete(key);
  }
}

// src/claudeBridge.ts
var READ_ONLY_ALLOWLIST = [
  "Bash(kubectl get *)",
  "Bash(kubectl describe *)",
  "Bash(kubectl logs *)",
  "Bash(kubectl top *)",
  "Bash(kubectl events *)",
  "Bash(kubectl explain *)",
  "Bash(kubectl version*)",
  "Bash(kubectl cluster-info*)",
  "Bash(kubectl api-resources*)",
  "Bash(kubectl api-versions*)",
  "Bash(kubectl auth can-i *)",
  "Bash(kubectl config get-contexts*)",
  "Bash(kubectl config current-context*)",
  "Bash(kubectl config view*)"
];
async function* runClaude(prompt, context) {
  const argv = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose"];
  for (const tool of READ_ONLY_ALLOWLIST) {
    argv.push("--allowedTools", tool);
  }
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...context ? { KUBECONFIG_CONTEXT: context } : {} }
  });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder;
  let buf = "";
  for (;; ) {
    const { value, done } = await reader.read();
    if (done)
      break;
    buf += dec.decode(value);
    let nl;
    while ((nl = buf.indexOf(`
`)) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim())
        continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
        yield { type: "session", sessionId: ev.session_id };
      } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block.type === "text")
            yield { type: "text", text: block.text };
          else if (block.type === "thinking")
            yield { type: "thinking", text: block.thinking };
        }
      } else if (ev.type === "result") {
        yield { type: "done" };
      }
    }
  }
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    yield { type: "error", text: errText.trim() || `claude exited with code ${exitCode}` };
  }
}

// src/logStream.ts
function buildLogsArgs(target, tailLines) {
  const args = [
    "logs",
    "-f",
    "--timestamps",
    "--prefix=true",
    "--all-containers=true",
    "-n",
    target.namespace
  ];
  if (target.labelSelector) {
    args.push("-l", target.labelSelector);
  } else if (target.pod) {
    args.push(target.pod);
  }
  args.push("--max-log-requests=20", `--tail=${tailLines}`);
  return args;
}
var PREFIX_RE = /^\[pod\/([^/\]]+)\/([^\]]+)\]\s+/;

class LogStreamManager {
  ws;
  context;
  spawnFn;
  procs = [];
  constructor(ws, context, spawnFn = Bun.spawn) {
    this.ws = ws;
    this.context = context;
    this.spawnFn = spawnFn;
  }
  start(targets, tailLines = 200) {
    this.stop();
    for (const target of targets) {
      this.spawnOne(target, tailLines);
    }
  }
  spawnOne(target, tailLines) {
    const argv = buildKubectlArgs(this.context, buildLogsArgs(target, tailLines));
    let proc;
    try {
      proc = this.spawnFn(["kubectl", ...argv], { stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      this.sendError(target.namespace, err instanceof Error ? err.message : String(err));
      return;
    }
    const entry = { proc };
    this.procs.push(entry);
    this.pumpStdout(target, proc.stdout);
    this.pumpStderr(target, proc.stderr);
  }
  async pumpStdout(target, stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder;
    let buf = "";
    try {
      for (;; ) {
        const { value, done } = await reader.read();
        if (done)
          break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf(`
`)) >= 0) {
          const raw = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (raw.length > 0)
            this.forward(target, raw);
        }
      }
      if (buf.length > 0)
        this.forward(target, buf);
    } catch {}
  }
  async pumpStderr(target, stream) {
    try {
      const text = await new Response(stream).text();
      const msg = text.trim();
      if (msg)
        this.sendError(target.namespace, msg);
    } catch {}
  }
  forward(target, raw) {
    let pod = target.pod ?? "";
    let container = target.container ?? "";
    const m = PREFIX_RE.exec(raw);
    if (m) {
      pod = m[1];
      container = m[2];
    }
    this.ws.send(JSON.stringify({
      type: "logs",
      namespace: target.namespace,
      pod,
      container,
      line: raw
    }));
  }
  sendError(namespace, message) {
    this.ws.send(JSON.stringify({ type: "logs.error", namespace, message }));
  }
  stop() {
    for (const { proc } of this.procs) {
      try {
        proc.kill();
      } catch {}
    }
    this.procs = [];
  }
  get activeCount() {
    return this.procs.length;
  }
}

// src/ws.ts
function makeWsHandlers(mgr, context = null) {
  const unsubs = new WeakMap;
  const logStreams = new WeakMap;
  return {
    open(ws) {
      unsubs.set(ws, new Map);
      logStreams.set(ws, new LogStreamManager(ws, context));
    },
    close(ws) {
      unsubs.get(ws)?.forEach((u) => u());
      logStreams.get(ws)?.stop();
    },
    message(ws, raw) {
      const m = JSON.parse(String(raw));
      const map = unsubs.get(ws);
      if (m.type === "subscribe") {
        const key = `${m.kind}/${m.namespace}`;
        if (map.has(key))
          return;
        const un = mgr.subscribe({ kind: m.kind, namespace: m.namespace }, (items) => ws.send(JSON.stringify({
          type: "snapshot",
          kind: m.kind,
          namespace: m.namespace,
          items
        })), (e) => ws.send(JSON.stringify({
          type: "delta",
          kind: m.kind,
          namespace: m.namespace,
          event: e.type,
          object: e.object
        })));
        map.set(key, un);
      } else if (m.type === "unsubscribe") {
        const key = `${m.kind}/${m.namespace}`;
        map.get(key)?.();
        map.delete(key);
      } else if (m.type === "logs.start" && Array.isArray(m.targets)) {
        const targets = m.targets;
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
    }
  };
}

// src/actions.ts
class PurgeActionError extends Error {
  constructor(name) {
    super(`purge is handled by the dedicated app-removal sheet (target: ${name ?? "unknown"})`);
    this.name = "PurgeActionError";
  }
}
var target = (a) => a.name ?? a.deployment ?? "";
var workloadKind = (a) => a.resourceKind ?? "deployment";
function resolveDeleteResource(a) {
  const rk = (a.resourceKind ?? "").toLowerCase();
  const name = target(a);
  const ns = a.namespace;
  const clusterScoped = new Set(["pv", "persistentvolume", "clusterrole", "clusterrolebinding"]);
  if (clusterScoped.has(rk)) {
    return ["delete", rk === "persistentvolume" ? "pv" : rk, name];
  }
  let kubectl_kind = rk;
  if (rk === "svc")
    kubectl_kind = "service";
  if (rk === "ing")
    kubectl_kind = "ingress";
  if (rk === "cm")
    kubectl_kind = "configmap";
  if (rk === "persistentvolumeclaim")
    kubectl_kind = "pvc";
  const nsFlags = ns ? ["-n", ns] : [];
  return ["delete", kubectl_kind, name, ...nsFlags];
}
function buildCommand(a) {
  const ns = a.namespace ? ["-n", a.namespace] : [];
  switch (a.kind) {
    case "restart": {
      const wk = workloadKind(a);
      return ["rollout", "restart", `${wk}/${target(a)}`, ...ns];
    }
    case "rollback":
      return ["rollout", "undo", `deployment/${target(a)}`, ...ns];
    case "pause":
      return ["rollout", "pause", `deployment/${target(a)}`, ...ns];
    case "resume":
      return ["rollout", "resume", `deployment/${target(a)}`, ...ns];
    case "scale": {
      const wk = workloadKind(a);
      return ["scale", `${wk}/${target(a)}`, `--replicas=${a.replicas}`, ...ns];
    }
    case "setEnv": {
      const pairs = Object.entries(a.env ?? {}).map(([k, v]) => `${k}=${v}`).sort();
      return ["set", "env", `deployment/${target(a)}`, ...ns, ...pairs];
    }
    case "setImage": {
      const wk = workloadKind(a);
      return [
        "set",
        "image",
        `${wk}/${target(a)}`,
        `${a.container}=${a.image}`,
        ...ns
      ];
    }
    case "setResources": {
      const wk = workloadKind(a);
      const args = ["set", "resources", `${wk}/${target(a)}`, "-c", a.container ?? ""];
      if (a.requests && a.requests !== "")
        args.push(`--requests=${a.requests}`);
      if (a.limits && a.limits !== "")
        args.push(`--limits=${a.limits}`);
      args.push(...ns);
      return args;
    }
    case "deletePod":
      return ["delete", "pod", a.pod ?? "", ...ns];
    case "deleteWorkload": {
      const wk = workloadKind(a);
      return ["delete", wk, target(a), ...ns];
    }
    case "cordon":
      return ["cordon", a.node ?? ""];
    case "uncordon":
      return ["uncordon", a.node ?? ""];
    case "drain": {
      const args = ["drain", a.node ?? ""];
      args.push("--ignore-daemonsets");
      args.push("--delete-emptydir-data");
      return args;
    }
    case "suspendCronJob":
      return [
        "patch",
        "cronjob",
        target(a),
        ...ns,
        "--type=merge",
        "-p",
        '{"spec":{"suspend":true}}'
      ];
    case "resumeCronJob":
      return [
        "patch",
        "cronjob",
        target(a),
        ...ns,
        "--type=merge",
        "-p",
        '{"spec":{"suspend":false}}'
      ];
    case "triggerCronJob":
      return [
        "create",
        "job",
        a.pod ?? `${target(a)}-manual`,
        `--from=cronjob/${target(a)}`,
        ...ns
      ];
    case "createNamespace":
      return ["create", "namespace", target(a)];
    case "deleteNamespace":
      return ["delete", "namespace", target(a)];
    case "deleteResource":
      return resolveDeleteResource(a);
    case "command":
      return (a.args ?? []).filter((s) => s !== "");
    case "purge":
      throw new PurgeActionError(target(a));
    default:
      throw new Error(`unsupported action kind: ${a.kind}`);
  }
}

// src/install.ts
function buildApplyArgs(context) {
  return buildKubectlArgs(context, ["apply", "-f", "-"]);
}
async function applyManifest(context, yaml) {
  const args = buildApplyArgs(context);
  try {
    const proc = Bun.spawn(["kubectl", ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(yaml);
    await proc.stdin.end();
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text()
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: -1, stdout: "", stderr: `kubectl not found: ${message}` };
  }
}
function buildHelmArgs(req, context, valuesFile) {
  const ctx = context ? ["--kube-context", context] : [];
  const version = req.version ? ["--version", req.version] : [];
  return {
    repoAdd: ["repo", "add", req.repoName, req.repoURL],
    repoUpdate: ["repo", "update", req.repoName],
    upgrade: [
      "upgrade",
      "--install",
      req.releaseName,
      `${req.repoName}/${req.chart}`,
      ...version,
      "-n",
      req.namespace,
      "--create-namespace",
      "-f",
      valuesFile,
      ...ctx
    ]
  };
}
async function runHelm(args) {
  const proc = Bun.spawn(["helm", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}
function isAlreadyExists(result) {
  return /already exists/i.test(result.stderr) || /already exists/i.test(result.stdout);
}
async function installHelm(context, req) {
  let valuesFile = null;
  try {
    valuesFile = `${process.env.TMPDIR ?? "/tmp"}/helmsman-values-${req.releaseName}-${Date.now()}.yaml`;
    await Bun.write(valuesFile, req.values);
    const args = buildHelmArgs(req, context, valuesFile);
    let combinedOut = "";
    let combinedErr = "";
    const add = await runHelm(args.repoAdd);
    combinedOut += add.stdout;
    combinedErr += add.stderr;
    if (add.code !== 0 && !isAlreadyExists(add)) {
      return { code: add.code, stdout: combinedOut, stderr: combinedErr };
    }
    const update = await runHelm(args.repoUpdate);
    combinedOut += update.stdout;
    combinedErr += update.stderr;
    if (update.code !== 0) {
      return { code: update.code, stdout: combinedOut, stderr: combinedErr };
    }
    const upgrade = await runHelm(args.upgrade);
    combinedOut += upgrade.stdout;
    combinedErr += upgrade.stderr;
    return { code: upgrade.code, stdout: combinedOut, stderr: combinedErr };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: -1, stdout: "", stderr: `helm not found: ${message}` };
  } finally {
    if (valuesFile) {
      try {
        const { unlink } = await import("fs/promises");
        await unlink(valuesFile);
      } catch {}
    }
  }
}

// ../../packages/k8s/src/purge.ts
var DISCOVERY_KINDS = [
  "deployments",
  "statefulsets",
  "daemonsets",
  "services",
  "ingresses",
  "configmaps",
  "secrets",
  "persistentvolumeclaims",
  "jobs",
  "cronjobs",
  "serviceaccounts"
];
function canonicalKind(rawKind) {
  switch (rawKind.toLowerCase()) {
    case "deployment":
      return "deployment";
    case "statefulset":
      return "statefulset";
    case "daemonset":
      return "daemonset";
    case "service":
      return "service";
    case "ingress":
      return "ingress";
    case "configmap":
      return "configmap";
    case "secret":
      return "secret";
    case "persistentvolumeclaim":
      return "persistentvolumeclaim";
    case "job":
      return "job";
    case "cronjob":
      return "cronjob";
    case "serviceaccount":
      return "serviceaccount";
    default:
      return null;
  }
}
var WORKLOAD_KINDS = new Set([
  "deployment",
  "statefulset",
  "daemonset"
]);
function kubectlDeleteKind(kind) {
  return kind === "persistentvolumeclaim" ? "pvc" : kind;
}
var PROTECTED_NAMESPACES = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "default-system",
  "cert-manager",
  "cnpg-system"
]);
var PROTECTED_NAMESPACE_PREFIXES = [
  "kube-",
  "cattle-",
  "fleet-",
  "tigera-",
  "calico-"
];
var SHARED_INFRA_WORKLOADS = new Set([
  "postgres",
  "mysql",
  "mariadb",
  "redis",
  "postgres-pooler"
]);
function isProtectedNamespace(namespace) {
  if (PROTECTED_NAMESPACES.has(namespace))
    return true;
  return PROTECTED_NAMESPACE_PREFIXES.some((p) => namespace.startsWith(p));
}
function blockedNamespaceReason(namespace) {
  if (!isProtectedNamespace(namespace))
    return null;
  return `${namespace} is a protected system namespace`;
}
function isSharedInfraWorkload(name) {
  if (SHARED_INFRA_WORKLOADS.has(name))
    return true;
  const c = core(name);
  return SHARED_INFRA_WORKLOADS.has(c) || SHARED_INFRA_WORKLOADS.has(name.toLowerCase());
}
var ROLE_TOKENS = new Set([
  "staging",
  "stg",
  "production",
  "prod",
  "dev",
  "test",
  "web",
  "api",
  "server",
  "client",
  "app",
  "svc",
  "service",
  "worker",
  "deploy",
  "deployment",
  "frontend",
  "backend",
  "ui",
  "site"
]);
var MIN_CORE_LEN = 4;
function core(name) {
  const tokens = name.toLowerCase().split(/[-_]/).filter((t) => t.length > 0);
  if (tokens.length === 0)
    return name.toLowerCase();
  const kept = tokens.filter((t) => !ROLE_TOKENS.has(t));
  const final = kept.length > 0 ? kept : tokens;
  return final.join("");
}
function isRelated(candidate, instance) {
  const rootCore = core(instance);
  const candCore = core(candidate);
  if (rootCore.length < MIN_CORE_LEN) {
    return candCore === rootCore;
  }
  return candCore.startsWith(rootCore) || rootCore.startsWith(candCore);
}
var HELM_SECRET_RE = /^sh\.helm\.release\.v1\.(.+)\.v\d+$/;
function helmReleaseFromSecretName(secretName) {
  const m = HELM_SECRET_RE.exec(secretName);
  return m ? m[1] : null;
}
function detectHelmRelease(secretNames, instance) {
  for (const name of secretNames) {
    const release = helmReleaseFromSecretName(name);
    if (release && isRelated(release, instance))
      return release;
  }
  return null;
}
function filterDiscovered(raw, instance, namespace) {
  const out = [];
  for (const r of raw) {
    const kind = canonicalKind(r.kind);
    if (!kind)
      continue;
    const name = r.metadata.name;
    if (kind === "secret" && helmReleaseFromSecretName(name) !== null)
      continue;
    if (!isRelated(name, instance))
      continue;
    if (WORKLOAD_KINDS.has(kind) && isSharedInfraWorkload(name))
      continue;
    out.push({ kind, name, namespace });
  }
  return out;
}
function discoveryArgs(instance, namespace) {
  return [
    "get",
    DISCOVERY_KINDS.join(","),
    "-l",
    `app.kubernetes.io/instance=${instance}`,
    "-n",
    namespace,
    "-o",
    "json"
  ];
}
function fallbackDiscoveryArgs(namespace) {
  return ["get", DISCOVERY_KINDS.join(","), "-n", namespace, "-o", "json"];
}
function deleteArgs(kind, name, namespace) {
  return ["delete", kubectlDeleteKind(kind), name, "-n", namespace];
}
function helmUninstallArgs(release, namespace) {
  return ["uninstall", release, "-n", namespace];
}

// src/purge.ts
var defaultRunners = {
  kubectlRun: kubectl,
  helmRun: (args) => runProcess("helm", args)
};
function parseItems(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}
async function discover(context, namespace, instance, runners = defaultRunners) {
  const blockedReason = blockedNamespaceReason(namespace);
  if (blockedReason) {
    return { ok: true, discovered: [], blockedReason };
  }
  const labelRes = await runners.kubectlRun(context, discoveryArgs(instance, namespace));
  let raw = labelRes.code === 0 ? parseItems(labelRes.stdout) : [];
  if (raw.length === 0) {
    const fallback = await runners.kubectlRun(context, fallbackDiscoveryArgs(namespace));
    if (fallback.code === 0)
      raw = parseItems(fallback.stdout);
  }
  const discovered = filterDiscovered(raw, instance, namespace);
  const secretNames = raw.filter((r) => canonicalKind(r.kind) === "secret").map((r) => r.metadata.name);
  const helmRelease = detectHelmRelease(secretNames, instance) ?? undefined;
  return helmRelease ? { ok: true, discovered, helmRelease } : { ok: true, discovered };
}
async function execute(context, req, runners = defaultRunners) {
  const results = [];
  const namespace = req.namespace;
  if (isProtectedNamespace(namespace)) {
    return {
      ok: false,
      results: [
        {
          resource: `namespace/${namespace}`,
          ok: false,
          detail: "skipped \u2014 protected system namespace"
        }
      ]
    };
  }
  if (req.helmRelease) {
    const helmRes = await runners.helmRun([...context ? ["--kube-context", context] : [], ...helmUninstallArgs(req.helmRelease, namespace)]);
    const ok = helmRes.code === 0;
    results.push({
      resource: `helm/${req.helmRelease}`,
      ok,
      detail: ok ? "uninstalled" : helmRes.stderr.trim() || `exit ${helmRes.code}`
    });
    if (!ok) {
      return { ok: false, results };
    }
  }
  for (const r of req.resources ?? []) {
    if (isProtectedNamespace(r.namespace)) {
      results.push({
        resource: `${r.kind}/${r.name}`,
        ok: false,
        detail: "skipped \u2014 protected system namespace"
      });
      continue;
    }
    const isWorkload = r.kind === "deployment" || r.kind === "statefulset" || r.kind === "daemonset";
    if (isWorkload && isSharedInfraWorkload(r.name)) {
      results.push({
        resource: `${r.kind}/${r.name}`,
        ok: false,
        detail: "skipped \u2014 protected shared-infra workload"
      });
      continue;
    }
    const delRes = await runners.kubectlRun(context, deleteArgs(r.kind, r.name, r.namespace));
    const ok = delRes.code === 0;
    results.push({
      resource: `${r.kind}/${r.name}`,
      ok,
      detail: ok ? "deleted" : delRes.stderr.trim() || `exit ${delRes.code}`
    });
  }
  if (req.dropDatabase && req.databaseHint) {
    results.push({
      resource: `database/${req.databaseHint}`,
      ok: false,
      detail: `DB drop requested \u2014 run manually inside the shared server (drop database "${req.databaseHint}").`
    });
  }
  const allOk = results.every((r) => r.ok);
  return { ok: allOk, results };
}
async function handlePurge(context, body, runners = defaultRunners) {
  if (body.dryRun) {
    return discover(context, body.namespace, body.instance, runners);
  }
  return execute(context, body, runners);
}

// src/metrics.ts
function normalizeQuantity(value, unit) {
  const v = value.trim();
  if (v === "" || v === "<unknown>")
    return 0;
  if (unit === "cpu") {
    if (v.endsWith("m")) {
      const n2 = Number(v.slice(0, -1));
      return Number.isFinite(n2) ? n2 : 0;
    }
    if (v.endsWith("n")) {
      const n2 = Number(v.slice(0, -1));
      return Number.isFinite(n2) ? n2 / 1e6 : 0;
    }
    if (v.endsWith("u")) {
      const n2 = Number(v.slice(0, -1));
      return Number.isFinite(n2) ? n2 / 1000 : 0;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n * 1000 : 0;
  }
  const binary = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5
  };
  const decimal = {
    k: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
    P: 1000 ** 5
  };
  const biMatch = v.match(/^(\d+(?:\.\d+)?)([KMGTP]i)$/);
  if (biMatch) {
    return Number(biMatch[1]) * binary[biMatch[2]];
  }
  const decMatch = v.match(/^(\d+(?:\.\d+)?)([kMGTP])$/);
  if (decMatch) {
    return Number(decMatch[1]) * decimal[decMatch[2]];
  }
  const plain = Number(v);
  return Number.isFinite(plain) ? plain : 0;
}
function bytesToMi(bytes) {
  return `${Math.round(bytes / (1024 * 1024))}Mi`;
}
function parseKubectlTopLine(line, defaultNamespace) {
  const cols = line.trim().split(/\s+/).filter((c) => c !== "");
  if (cols.length === 4) {
    const [namespace, name, cpu, memory] = cols;
    return {
      namespace,
      name,
      cpu: String(normalizeQuantity(cpu, "cpu")),
      memory: bytesToMi(normalizeQuantity(memory, "memory"))
    };
  }
  if (cols.length === 3 && defaultNamespace) {
    const [name, cpu, memory] = cols;
    return {
      namespace: defaultNamespace,
      name,
      cpu: String(normalizeQuantity(cpu, "cpu")),
      memory: bytesToMi(normalizeQuantity(memory, "memory"))
    };
  }
  return null;
}
function parseKubectlTopNodeLine(line) {
  const cols = line.trim().split(/\s+/).filter((c) => c !== "");
  if (cols.length < 4)
    return null;
  const name = cols[0];
  const cpu = cols[1];
  const memory = cols.length >= 5 ? cols[3] : cols[2];
  return {
    name,
    cpu: String(normalizeQuantity(cpu, "cpu")),
    memory: bytesToMi(normalizeQuantity(memory, "memory"))
  };
}
function parseKubectlTopPods(stdout, defaultNamespace) {
  return stdout.split(`
`).map((l) => parseKubectlTopLine(l, defaultNamespace)).filter((r) => r !== null);
}
function parseKubectlTopNodes(stdout) {
  return stdout.split(`
`).map((l) => parseKubectlTopNodeLine(l)).filter((r) => r !== null);
}
async function getPodMetrics(context, namespace) {
  const all = !namespace || namespace === "*";
  const nsArgs = all ? ["--all-namespaces"] : ["-n", namespace];
  try {
    const res = await kubectl(context, ["top", "pods", ...nsArgs, "--no-headers"]);
    if (res.code !== 0) {
      console.warn(`[metrics] kubectl top pods unavailable: ${res.stderr.trim()}`);
      return { available: false, items: [] };
    }
    return {
      available: true,
      items: parseKubectlTopPods(res.stdout, all ? undefined : namespace)
    };
  } catch (err) {
    console.warn(`[metrics] kubectl top pods failed: ${String(err)}`);
    return { available: false, items: [] };
  }
}
async function getNodeMetrics(context) {
  try {
    const res = await kubectl(context, ["top", "nodes", "--no-headers"]);
    if (res.code !== 0) {
      console.warn(`[metrics] kubectl top nodes unavailable: ${res.stderr.trim()}`);
      return { available: false, items: [] };
    }
    return { available: true, items: parseKubectlTopNodes(res.stdout) };
  } catch (err) {
    console.warn(`[metrics] kubectl top nodes failed: ${String(err)}`);
    return { available: false, items: [] };
  }
}

// src/auth.ts
function checkAuth(authHeader, token) {
  if (!token)
    return true;
  return authHeader === `Bearer ${token}`;
}

// src/index.ts
var KUBECONFIG = resolveKubeconfigPath(process.env, homedir());
var PORT = Number(process.env.PORT ?? 8787);
var TOKEN = process.env.HELMSMAN_TOKEN ?? null;
var WEB_DIST = process.env.WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname;
async function serveStatic(pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const safe = rel.split("/").filter((s) => s !== "..").join("/");
  const direct = Bun.file(`${WEB_DIST}/${safe}`);
  if (await direct.exists())
    return new Response(direct);
  const index = Bun.file(`${WEB_DIST}/index.html`);
  if (await index.exists())
    return new Response(index);
  return new Response("web UI not built (run `pnpm --filter web build`)", { status: 404 });
}
var ctxRes = await kubectl(null, ["config", "current-context"]);
var context = ctxRes.code === 0 ? ctxRes.stdout.trim() : null;
var mgr = new WatchManager(context);
var server = Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, kubeconfig: KUBECONFIG });
    }
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/ws") {
      return serveStatic(url.pathname);
    }
    if (!checkAuth(req.headers.get("authorization") ?? undefined, TOKEN)) {
      return new Response("unauthorized", { status: 401 });
    }
    if (url.pathname === "/api/metrics/pods" && req.method === "GET") {
      const ns = url.searchParams.get("namespace") ?? "*";
      const result = await getPodMetrics(context, ns);
      return Response.json(result);
    }
    if (url.pathname === "/api/metrics/nodes" && req.method === "GET") {
      const result = await getNodeMetrics(context);
      return Response.json(result);
    }
    if (url.pathname === "/api/action" && req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (body.kind === "purge") {
        return Response.json({
          purge: true,
          name: body.name ?? body.deployment ?? null,
          namespace: body.namespace ?? "default"
        });
      }
      let argv;
      try {
        argv = buildCommand(body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, { status: 422 });
      }
      if (url.searchParams.get("preview") === "1") {
        const fullCommand = ["kubectl", ...context ? ["--context", context] : [], ...argv];
        return Response.json({ command: fullCommand });
      }
      const result = await kubectl(context, argv);
      return Response.json(result);
    }
    if (url.pathname === "/api/apply" && req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.yaml !== "string" || body.yaml.trim() === "") {
        return Response.json({ error: "missing yaml" }, { status: 422 });
      }
      const result = await applyManifest(context, body.yaml);
      return Response.json(result);
    }
    if (url.pathname === "/api/helm" && req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!body.repoName || !body.repoURL || !body.chart || !body.releaseName || !body.namespace || typeof body.values !== "string") {
        return Response.json({ error: "missing required helm fields (repoName, repoURL, chart, releaseName, namespace, values)" }, { status: 422 });
      }
      const result = await installHelm(context, {
        repoName: body.repoName,
        repoURL: body.repoURL,
        chart: body.chart,
        version: body.version ?? null,
        releaseName: body.releaseName,
        namespace: body.namespace,
        values: body.values
      });
      return Response.json(result);
    }
    if (url.pathname === "/api/purge" && req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.namespace !== "string" || typeof body.instance !== "string") {
        return Response.json({ error: "missing namespace or instance" }, { status: 422 });
      }
      const result = await handlePurge(context, body);
      return Response.json(result);
    }
    if (url.pathname === "/ws") {
      if (srv.upgrade(req))
        return;
      return new Response("expected websocket", { status: 426 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: makeWsHandlers(mgr, context)
});
console.log(`helmsman server on :${server.port} (kubeconfig=${KUBECONFIG})`);
