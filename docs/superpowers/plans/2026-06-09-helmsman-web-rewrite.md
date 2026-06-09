# Helmsman Web Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the full Helmsman UI from a Docker container against a mounted kubeconfig — a TypeScript monorepo web app at behavioral parity with the Swift app.

**Architecture:** Two natures of work. (1) Hand-built deterministic server infra — a kubectl watch manager that streams live cluster state over WebSocket, a Claude-CLI bridge that streams chat, REST routes for guarded mutations, and packaging. Much of this adapts the existing TypeScript in `agent/src/kubectl.ts` and `agent/src/claude.ts`. (2) The 22 UI panels, ported one at a time *through* the parity orchestrator (`.claude/workflows/parity-feature.js`, porter mode) with the Swift app as source of truth.

**Tech Stack:** Bun + WebSocket (server), React 19 + Vite + Tailwind v4 + shadcn/ui + TanStack Query v5 + Zustand (web), `kubectl`/`claude`/`helm` CLIs in-container, Docker.

**Specs:** `docs/superpowers/specs/2026-06-09-helmsman-web-rewrite-design.md`.

**Prerequisite:** The parity-orchestrator plan (`2026-06-09-parity-orchestrator.md`) is fully executed and its dogfood run (Task 9) reached `parity: true`. This plan reuses that monorepo foundation, domain-context files, and contracts doc.

---

## File structure

| Path | Responsibility |
|---|---|
| `packages/k8s/src/run.ts` | Spawn `kubectl`/`helm` via `Bun.spawn` (no shell); capture stdout/stderr/exit (adapts `agent/src/kubectl.ts`) |
| `packages/k8s/src/watch.ts` | Parse `--output-watch-events` JSON stream into typed events |
| `apps/server/src/watchManager.ts` | One watch per (kind, namespace); cache; diff; broadcast |
| `apps/server/src/ws.ts` | WS protocol: subscribe/unsubscribe + chat; routes messages |
| `apps/server/src/claudeBridge.ts` | Spawn `claude` stream-json; parse to events (adapts `agent/src/claude.ts`) |
| `apps/server/src/actions.ts` | REST mutation routes; builds the exact kubectl command per action-block `kind` |
| `apps/server/src/auth.ts` | Optional bearer-token gate |
| `apps/web/src/lib/ws.ts` | WS client → Zustand store; chat stream consumer |
| `apps/web/src/lib/api.ts` | REST client + TanStack Query hooks for mutations |
| `apps/web/src/components/ConfirmSheet.tsx` | Guarded-action confirm sheet (shows exact command) |
| `apps/web/src/panels/<name>/` | One folder per ported panel |
| `Dockerfile`, `compose.yaml` | Container image + run config (kubeconfig + ~/.claude mounts) |

All process spawning uses `Bun.spawn([...argv])` with an explicit argv array —
never a shell string — so cluster/user input can never be shell-interpreted.

---

# Phase A — Server infrastructure (hand-built, TDD)

## Task 1: kubectl/helm process wrapper (`packages/k8s/src/run.ts`)

**Files:**
- Create: `packages/k8s/src/run.ts`
- Test: `packages/k8s/src/run.test.ts`
- Reference: `agent/src/kubectl.ts` (existing TS to adapt), `Sources/Helmsman/Util/ProcessAsync.swift`

- [ ] **Step 1: Write the failing test**

`packages/k8s/src/run.test.ts`:
```ts
import { test, expect } from "bun:test";
import { buildKubectlArgs } from "./run";

test("prepends --context when provided", () => {
  expect(buildKubectlArgs("kind-test", ["get", "pods", "-n", "default"]))
    .toEqual(["--context", "kind-test", "get", "pods", "-n", "default"]);
});

test("omits --context when null", () => {
  expect(buildKubectlArgs(null, ["get", "pods"])).toEqual(["get", "pods"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/k8s && bun test`
Expected: FAIL — `buildKubectlArgs` not exported.

- [ ] **Step 3: Implement (argv array, no shell)**

`packages/k8s/src/run.ts`:
```ts
/** Prepend `--context <ctx>` to kubectl args when a context is set. */
export function buildKubectlArgs(context: string | null, args: string[]): string[] {
  return context ? ["--context", context, ...args] : args;
}

export interface RunResult { code: number; stdout: string; stderr: string }

/** Run a binary to completion via Bun.spawn (argv array — no shell). */
export async function runProcess(bin: string, args: string[]): Promise<RunResult> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

export const kubectl = (context: string | null, args: string[]) =>
  runProcess("kubectl", buildKubectlArgs(context, args));
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd packages/k8s && bun test`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/k8s
git commit -m "feat(k8s): kubectl/helm process wrapper (Bun.spawn, no shell)"
```

---

## Task 2: Watch-event stream parser (`packages/k8s/src/watch.ts`)

**Files:**
- Create: `packages/k8s/src/watch.ts`
- Test: `packages/k8s/src/watch.test.ts`

`kubectl get <kind> --watch --output-watch-events -o json` emits a stream of
JSON objects `{"type":"ADDED|MODIFIED|DELETED","object":{…}}`, concatenated
(pretty-printed, not newline-delimited). The parser must handle objects split
across chunks.

- [ ] **Step 1: Write the failing test**

`packages/k8s/src/watch.test.ts`:
```ts
import { test, expect } from "bun:test";
import { WatchEventParser } from "./watch";

test("emits one event per complete JSON object across chunk boundaries", () => {
  const p = new WatchEventParser();
  const events: { type: string; name: string }[] = [];
  const sink = (e: any) => events.push({ type: e.type, name: e.object.metadata.name });

  p.push('{"type":"ADDED","object":{"metadata":{"name":"a"', sink);
  p.push('}}{"type":"MODIFIED","object":{"metadata":{"name":"b"}}}', sink);

  expect(events).toEqual([
    { type: "ADDED", name: "a" },
    { type: "MODIFIED", name: "b" },
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/k8s && bun test watch`
Expected: FAIL — `WatchEventParser` not found.

- [ ] **Step 3: Implement (brace-depth framing over a buffer)**

`packages/k8s/src/watch.ts`:
```ts
export interface WatchEvent { type: "ADDED" | "MODIFIED" | "DELETED"; object: any }

/** Frames concatenated JSON objects from a kubectl --output-watch-events stream. */
export class WatchEventParser {
  private buf = "";

  push(chunk: string, emit: (e: WatchEvent) => void): void {
    this.buf += chunk;
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") { if (depth === 0) start = i; depth++; }
      else if (c === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          emit(JSON.parse(this.buf.slice(start, i + 1)));
          this.buf = this.buf.slice(i + 1);
          i = -1; start = -1;
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd packages/k8s && bun test watch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/k8s
git commit -m "feat(k8s): watch-event stream parser"
```

---

## Task 3: Watch manager + WS subscription protocol

**Files:**
- Create: `apps/server/src/watchManager.ts`
- Create: `apps/server/src/ws.ts`
- Test: `apps/server/src/watchManager.test.ts`
- Modify: `apps/server/src/index.ts` (wire WS to the manager)

Protocol (client↔server JSON over `/ws`):
- client → `{"type":"subscribe","kind":"pods","namespace":"default"}`
- client → `{"type":"unsubscribe","kind":"pods","namespace":"default"}`
- server → `{"type":"snapshot","kind":"pods","namespace":"default","items":[…]}`
- server → `{"type":"delta","kind":"pods","namespace":"default","event":"ADDED|MODIFIED|DELETED","object":{…}}`

- [ ] **Step 1: Write the failing test for the cache reducer**

`apps/server/src/watchManager.test.ts`:
```ts
import { test, expect } from "bun:test";
import { applyEvent } from "./watchManager";

test("ADDED then MODIFIED upserts; DELETED removes", () => {
  const cache = new Map<string, any>();
  applyEvent(cache, { type: "ADDED", object: { metadata: { name: "a" }, spec: 1 } });
  applyEvent(cache, { type: "MODIFIED", object: { metadata: { name: "a" }, spec: 2 } });
  expect(cache.get("a").spec).toBe(2);
  applyEvent(cache, { type: "DELETED", object: { metadata: { name: "a" } } });
  expect(cache.has("a")).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/server && bun test watchManager`
Expected: FAIL — `applyEvent` not found.

- [ ] **Step 3: Implement the manager**

`apps/server/src/watchManager.ts`:
```ts
import { WatchEventParser, type WatchEvent } from "@helmsman/k8s/src/watch";

export function applyEvent(cache: Map<string, any>, e: WatchEvent): void {
  const name = e.object?.metadata?.name;
  if (!name) return;
  if (e.type === "DELETED") cache.delete(name);
  else cache.set(name, e.object);
}

type Sub = { kind: string; namespace: string };
const subKey = (s: Sub) => `${s.kind}/${s.namespace}`;

export class WatchManager {
  private context: string | null;
  private watches = new Map<string, { proc: Bun.Subprocess; cache: Map<string, any>; listeners: Set<(e: WatchEvent) => void> }>();

  constructor(context: string | null) { this.context = context; }

  subscribe(sub: Sub, onSnapshot: (items: any[]) => void, onDelta: (e: WatchEvent) => void): () => void {
    const key = subKey(sub);
    let w = this.watches.get(key);
    if (!w) w = this.start(sub, key);
    w.listeners.add(onDelta);
    onSnapshot([...w.cache.values()]);
    return () => { w!.listeners.delete(onDelta); if (w!.listeners.size === 0) this.stop(key); };
  }

  private start(sub: Sub, key: string) {
    const nsArgs = sub.namespace === "*" ? ["--all-namespaces"] : ["-n", sub.namespace];
    const argv = ["kubectl", ...(this.context ? ["--context", this.context] : []),
      "get", sub.kind, ...nsArgs, "--watch", "--output-watch-events", "-o", "json"];
    const proc = Bun.spawn(argv, { stdout: "pipe" });
    const cache = new Map<string, any>();
    const listeners = new Set<(e: WatchEvent) => void>();
    const parser = new WatchEventParser();
    const w = { proc, cache, listeners };
    this.watches.set(key, w);
    (async () => {
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(dec.decode(value), (e) => { applyEvent(cache, e); for (const l of listeners) l(e); });
      }
    })();
    return w;
  }

  private stop(key: string) { this.watches.get(key)?.proc.kill(); this.watches.delete(key); }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/server && bun test watchManager`
Expected: PASS.

- [ ] **Step 5: Wire WS routing**

`apps/server/src/ws.ts`:
```ts
import type { ServerWebSocket } from "bun";
import { WatchManager } from "./watchManager";

export function makeWsHandlers(mgr: WatchManager) {
  const unsubs = new WeakMap<ServerWebSocket<any>, Map<string, () => void>>();
  return {
    open(ws: ServerWebSocket<any>) { unsubs.set(ws, new Map()); },
    close(ws: ServerWebSocket<any>) { unsubs.get(ws)?.forEach((u) => u()); },
    message(ws: ServerWebSocket<any>, raw: string | Buffer) {
      const m = JSON.parse(String(raw));
      const map = unsubs.get(ws)!;
      if (m.type === "subscribe") {
        const key = `${m.kind}/${m.namespace}`;
        if (map.has(key)) return;
        const un = mgr.subscribe(
          { kind: m.kind, namespace: m.namespace },
          (items) => ws.send(JSON.stringify({ type: "snapshot", kind: m.kind, namespace: m.namespace, items })),
          (e) => ws.send(JSON.stringify({ type: "delta", kind: m.kind, namespace: m.namespace, event: e.type, object: e.object })),
        );
        map.set(key, un);
      } else if (m.type === "unsubscribe") {
        const key = `${m.kind}/${m.namespace}`;
        map.get(key)?.(); map.delete(key);
      }
    },
  };
}
```
Then in `apps/server/src/index.ts`, construct `new WatchManager(context)` (discover current context via `kubectl config current-context`) and pass `makeWsHandlers(mgr)` as the `websocket` config.

- [ ] **Step 6: Manual smoke test against a real cluster**

Start the server (`cd apps/server && bun src/index.ts`), then from another shell
send a subscribe frame with `websocat ws://localhost:8787/ws` (if installed).
Expected: a `snapshot` frame with current pods when the cluster is reachable.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat(server): kubectl watch manager + WS subscription protocol"
```

---

## Task 4: Live store wiring (web WS client)

**Files:**
- Create: `apps/web/src/lib/ws.ts`
- Modify: `apps/web/src/store/cluster.ts` (already has upsert/remove from orchestrator Task 2)

- [ ] **Step 1: Write the WS client that feeds the store**

`apps/web/src/lib/ws.ts`:
```ts
import { useCluster } from "@/store/cluster";

let socket: WebSocket | null = null;

export function connectCluster(): void {
  socket = new WebSocket(`ws://${location.host}/ws`);
  const store = useCluster.getState();
  socket.onopen = () => store.setConnected(true);
  socket.onclose = () => store.setConnected(false);
  socket.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "snapshot") for (const o of m.items) store.upsert(m.kind, o.metadata.name, o);
    else if (m.type === "delta") {
      if (m.event === "DELETED") store.remove(m.kind, m.object.metadata.name);
      else store.upsert(m.kind, m.object.metadata.name, m.object);
    }
  };
}

export function subscribe(kind: string, namespace = "default"): void {
  socket?.send(JSON.stringify({ type: "subscribe", kind, namespace }));
}
export function unsubscribe(kind: string, namespace = "default"): void {
  socket?.send(JSON.stringify({ type: "unsubscribe", kind, namespace }));
}
```

- [ ] **Step 2: Call `connectCluster()` once on app mount**

In `apps/web/src/App.tsx`, add a `useEffect(() => { connectCluster(); }, [])` at the top of the component.

- [ ] **Step 3: Verify build + typecheck**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "feat(web): WebSocket client feeding the live cluster store"
```

---

## Task 5: Claude bridge (chat streaming over WS)

**Files:**
- Create: `apps/server/src/claudeBridge.ts`
- Test: `apps/server/src/actionParse.test.ts`
- Modify: `apps/server/src/ws.ts` (handle `chat` messages)
- Reference: `agent/src/claude.ts`, `Sources/Helmsman/Chat/{ClaudeSession,StreamJsonParser,SuggestedAction}.swift`, `docs/parity/contracts.md`

- [ ] **Step 1: Write the failing test for action-block extraction**

`apps/server/src/actionParse.test.ts`:
```ts
import { test, expect } from "bun:test";
import { extractActionBlocks } from "./claudeBridge";

test("extracts fenced action blocks as parsed objects", () => {
  const md = 'Restarting now.\n```action\n{"label":"Restart memos","kind":"restart","name":"memos","namespace":"default"}\n```\nDone.';
  expect(extractActionBlocks(md)).toEqual([
    { label: "Restart memos", kind: "restart", name: "memos", namespace: "default" },
  ]);
});

test("ignores non-action fences", () => {
  expect(extractActionBlocks("```bash\nls\n```")).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/server && bun test actionParse`
Expected: FAIL — `extractActionBlocks` not found.

- [ ] **Step 3: Implement the bridge + extractor**

`apps/server/src/claudeBridge.ts`:
```ts
/** Pull fenced action JSON blocks out of an assistant message. */
export function extractActionBlocks(markdown: string): any[] {
  const out: any[] = [];
  const re = /```action\s*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    try { out.push(JSON.parse(m[1].trim())); } catch { /* skip malformed */ }
  }
  return out;
}

const READ_ONLY_ALLOWLIST = [
  "Bash(kubectl get *)", "Bash(kubectl describe *)", "Bash(kubectl logs *)",
  "Bash(kubectl top *)", "Bash(kubectl events *)", "Bash(kubectl explain *)",
  "Bash(kubectl version*)", "Bash(kubectl cluster-info*)", "Bash(kubectl api-resources*)",
  "Bash(kubectl api-versions*)", "Bash(kubectl auth can-i *)",
  "Bash(kubectl config get-contexts*)", "Bash(kubectl config current-context*)",
  "Bash(kubectl config view*)",
];

export interface ChatEvent { type: "thinking" | "text" | "done" | "error"; text?: string }

/**
 * Spawn the `claude` CLI in streaming mode and yield parsed events.
 * Mirrors agent/src/claude.ts; mutations surface as action blocks in the text
 * (the web client renders buttons), never auto-run. Spawned via Bun.spawn with
 * an argv array — no shell.
 */
export async function* runClaude(prompt: string, _context: string | null): AsyncGenerator<ChatEvent> {
  const argv = [
    "claude", "-p", prompt,
    "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
    "--allowedTools", READ_ONLY_ALLOWLIST.join(","),
  ];
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.type === "assistant" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === "text") yield { type: "text", text: block.text };
          else if (block.type === "thinking") yield { type: "thinking", text: block.thinking };
        }
      } else if (ev.type === "result") yield { type: "done" };
    }
  }
  if ((await proc.exited) !== 0) yield { type: "error", text: await new Response(proc.stderr).text() };
}
```
Note: confirm the exact stream-json event shape against `agent/src/claude.ts` and
adjust the `ev.type`/`content` mapping to match what already works there.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/server && bun test actionParse`
Expected: PASS.

- [ ] **Step 5: Route `chat` messages over WS**

In `apps/server/src/ws.ts` `message`, add: when `m.type === "chat"`, iterate
`runClaude(m.prompt, context)` and `ws.send` each event as
`{"type":"chat","event":<ChatEvent>}`. On a `text` event, the client also runs
`extractActionBlocks` to render action buttons.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(server): claude bridge — chat streaming + action-block extraction"
```

---

## Task 6: Guarded mutation routes + confirm contract

**Files:**
- Create: `apps/server/src/actions.ts`
- Test: `apps/server/src/actions.test.ts`
- Create: `apps/web/src/components/ConfirmSheet.tsx`, `apps/web/src/lib/api.ts`
- Reference: `Sources/Helmsman/Chat/SuggestedActionResolver.swift`, `Sources/Helmsman/Panels/Actions/`, `docs/parity/contracts.md`

The server is the single place that turns an action-block `kind` into a concrete
kubectl command. The client shows that exact command in a confirm sheet BEFORE
posting it for execution.

- [ ] **Step 1: Write the failing test for command building**

`apps/server/src/actions.test.ts`:
```ts
import { test, expect } from "bun:test";
import { buildCommand } from "./actions";

test("restart maps to rollout restart deployment", () => {
  expect(buildCommand({ kind: "restart", name: "memos", namespace: "default" }))
    .toEqual(["rollout", "restart", "deployment/memos", "-n", "default"]);
});

test("scale maps to scale --replicas", () => {
  expect(buildCommand({ kind: "scale", name: "web", namespace: "default", replicas: 3 }))
    .toEqual(["scale", "deployment/web", "--replicas=3", "-n", "default"]);
});

test("command kind passes args through verbatim", () => {
  expect(buildCommand({ kind: "command", args: ["cnpg", "destroy", "pg-1", "-n", "default"] }))
    .toEqual(["cnpg", "destroy", "pg-1", "-n", "default"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/server && bun test actions`
Expected: FAIL — `buildCommand` not found.

- [ ] **Step 3: Implement `buildCommand` for each action-block `kind`**

`apps/server/src/actions.ts` — implement a switch over every `kind` in the
contracts doc (`restart`, `scale`, `rollback`, `setEnv`, `setImage`,
`setResources`, `pause`, `resume`, `deletePod`, `deleteWorkload`, `cordon`,
`uncordon`, `drain`, `suspendCronJob`, `resumeCronJob`, `triggerCronJob`,
`createNamespace`, `deleteNamespace`, `deleteResource`, `command`). `purge` is
NOT a kubectl command — it returns a sentinel that the client maps to the purge
flow. Mirror `SuggestedActionResolver.swift` exactly. Start with the three tested
kinds, then extend; each kind gets its own test case before implementation.

```ts
export interface ActionBlock { kind: string; name?: string; deployment?: string; namespace?: string; replicas?: number; pod?: string; node?: string; container?: string; image?: string; requests?: string; limits?: string; resourceKind?: string; args?: string[]; env?: Record<string, string>; destructive?: boolean }

const target = (a: ActionBlock) => a.name ?? a.deployment ?? "";

export function buildCommand(a: ActionBlock): string[] {
  const ns = a.namespace ? ["-n", a.namespace] : [];
  switch (a.kind) {
    case "restart": return ["rollout", "restart", `deployment/${target(a)}`, ...ns];
    case "scale": return ["scale", `deployment/${target(a)}`, `--replicas=${a.replicas}`, ...ns];
    case "command": return a.args ?? [];
    // … extend for every remaining kind, each TDD'd ahead of implementation.
    default: throw new Error(`unsupported action kind: ${a.kind}`);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/server && bun test actions`
Expected: PASS.

- [ ] **Step 5: Add the POST route + client confirm sheet**

Add `POST /api/action` to `index.ts`: the client first requests a preview
(`{ command: ["kubectl", ...buildCommand(body)] }`) to display, then on confirm
the server runs it via `kubectl(context, buildCommand(body))`. `ConfirmSheet.tsx`
(shadcn `sheet`) renders the exact command string and an Execute button.
`lib/api.ts` exposes a `useAction()` TanStack Query mutation.

- [ ] **Step 6: Commit**

```bash
git add apps/server apps/web
git commit -m "feat: guarded mutation routes + confirm sheet (exact command shown)"
```

---

## Task 7: Optional auth gate

**Files:**
- Create: `apps/server/src/auth.ts`
- Test: `apps/server/src/auth.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/server/src/auth.test.ts`:
```ts
import { test, expect } from "bun:test";
import { checkAuth } from "./auth";

test("open when no token configured", () => {
  expect(checkAuth(undefined, null)).toBe(true);
});
test("requires matching bearer when token set", () => {
  expect(checkAuth("Bearer s3cret", "s3cret")).toBe(true);
  expect(checkAuth("Bearer wrong", "s3cret")).toBe(false);
  expect(checkAuth(undefined, "s3cret")).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/server && bun test auth`
Expected: FAIL — `checkAuth` not found.

- [ ] **Step 3: Implement**

`apps/server/src/auth.ts`:
```ts
/** When HELMSMAN_TOKEN is set, require `Authorization: Bearer <token>`. */
export function checkAuth(authHeader: string | undefined, token: string | null): boolean {
  if (!token) return true;
  return authHeader === `Bearer ${token}`;
}
```
Wire it in `index.ts`: read `process.env.HELMSMAN_TOKEN ?? null`; reject non-health
HTTP + WS upgrades that fail `checkAuth`.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/server && bun test auth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): optional bearer-token gate"
```

---

# Phase B — Panel ports (via the parity orchestrator)

Each panel is one porter-mode run of the `parity-feature` Workflow. For every
run: invoke the `Workflow` tool with `{ "mode": "porter", "feature": "<name>",
"request": "<scope>" }`, then confirm `parity: true`, review the diff +
`docs/parity/<name>.md`, and commit. If a verifier flags issues, fix and re-run
before moving on. Panels read live state from the store (Task 4); mutations go
through the confirm sheet (Task 6); chat uses the bridge (Task 5).

## Task 8: P0 — Pods panel + chat (proves the full path)

- [ ] **Step 1:** Run `Workflow` `parity-feature` with `feature: "pods"`,
  `request: "Port the Pods panel: phase, restarts, CPU/memory sparklines, exec, logs, and the Ask-Claude handoff. Subscribe to pods (and pod metrics). Match columns and the exact kubectl commands."`
- [ ] **Step 2:** Run `Workflow` `parity-feature` with `feature: "chat"`,
  `request: "Port the chat pane: prompt composer, streamed thinking/text rendering (markdown), and action-block buttons that open the confirm sheet. Use the WS chat protocol and the claude bridge."`
- [ ] **Step 3:** Verify `pnpm --filter web build` passes and both runs reported `parity: true`.
- [ ] **Step 4:** Manual: run `pnpm --filter web dev` + the server, open the app, confirm live pods render and a chat prompt streams a reply.
- [ ] **Step 5:** Commit (`git add apps/ -A && git add -f docs/parity/pods.md docs/parity/chat.md`).

## Task 9: P1 — Read-only panels

One orchestrator run per panel, in this order (commit after each):
- [ ] Overview · [ ] Namespaces · [ ] Deployments · [ ] Nodes · [ ] Services
- [ ] Ingresses · [ ] Workloads · [ ] Storage · [ ] ConfigMaps · [ ] RBAC
- [ ] Events · [ ] Logs · [ ] Databases · [ ] Right-sizing · [ ] Connectivity

For each, the `request` says: "Port the <name> panel — match every column/field,
empty/error states, namespace scoping, and the exact kubectl commands the Swift
panel uses." Confirm `parity: true` and `pnpm --filter web build` after each.

## Task 10: P2 — Guarded mutations across panels

- [ ] **Step 1:** Run `parity-feature` `feature: "panel-actions"`,
  `request: "Wire each panel's mutating actions (scale/restart/rollback/pause/resume/delete/cordon/uncordon/drain/cronjob suspend-resume-trigger/secret edit/namespace create-delete) to the confirm sheet and POST /api/action. Match the Swift confirm-then-kubectl behavior; cover every action-block kind in docs/parity/contracts.md."`
- [ ] **Step 2:** Confirm `parity: true`; manually exercise a restart + a scale through the UI.
- [ ] **Step 3:** Commit.

## Task 11: P3 — Catalog, Purge, Updates

- [ ] Run `parity-feature` `feature: "catalog"` — install wizard over
  `catalog.json` (template-var substitution, manifest/helm install via server).
- [ ] Run `parity-feature` `feature: "purge"` — typed-name purge confirm sheet +
  discovery + delete/helm-uninstall (the `purge` action kind).
- [ ] Run `parity-feature` `feature: "updates"` — installed-app update detection
  (port `Updates/` resolver logic into `packages/catalog`).
- [ ] Confirm `parity: true` for each; commit.

## Task 12: P4 — Assistant, Settings, Accounts

- [ ] Run `parity-feature` `feature: "assistant"` — install/steer the in-cluster
  agent (RBAC cage, ConfigMaps, token Secret, Deployment; autonomy modes;
  kill-switch). The agent code already lives in `packages/agent`.
- [ ] Run `parity-feature` `feature: "settings"` — Signal bridge deploy + phone
  link.
- [ ] Run `parity-feature` `feature: "accounts"` — registry accounts; replace the
  macOS Keychain store with a mounted-file/env secret store (see design "behaviors
  that change").
- [ ] Confirm `parity: true` for each; commit.

---

# Phase C — Packaging

## Task 13: Dockerfile + compose

**Files:**
- Create: `Dockerfile`, `compose.yaml`, `.dockerignore`

- [ ] **Step 1: Write the Dockerfile**

`Dockerfile`:
```dockerfile
# --- build web ---
FROM oven/bun:1 AS web
WORKDIR /app
COPY pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages ./packages
RUN bun install
COPY apps/web ./apps/web
RUN cd apps/web && bun run build

# --- runtime ---
FROM oven/bun:1
RUN apt-get update && apt-get install -y curl ca-certificates \
 && curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
 && install -m 0755 kubectl /usr/local/bin/kubectl && rm kubectl \
 && curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash \
 && curl -fsSL https://claude.ai/install.sh | bash || true
WORKDIR /app
COPY pnpm-workspace.yaml package.json .npmrc ./
COPY packages ./packages
COPY apps/server ./apps/server
RUN bun install --production
COPY --from=web /app/apps/web/dist ./apps/web/dist
ENV PORT=8787 NODE_ENV=production
EXPOSE 8787
CMD ["bun", "apps/server/src/index.ts"]
```
Confirm the `claude` install method against current docs (`claude-api` skill);
adjust the install line if the URL differs.

- [ ] **Step 2: Write compose with the mounts**

`compose.yaml`:
```yaml
services:
  helmsman:
    build: .
    ports: ["8787:8787"]
    environment:
      - KUBECONFIG=/kube/config
      - HELMSMAN_TOKEN=${HELMSMAN_TOKEN:-}
    volumes:
      - ${HOME}/.kube/config:/kube/config:ro
      - ${HOME}/.claude:/root/.claude:ro   # Claude subscription auth (claude setup-token)
```

- [ ] **Step 3: Add `.dockerignore`**

```
node_modules
**/node_modules
**/dist
.build
Helmsman.app
.git
```

- [ ] **Step 4: Build and smoke-test the image**

Build the image (`docker build -t helmsman-web .`), run it with the kubeconfig
mounted (`docker run --rm -p 8787:8787 -v $HOME/.kube/config:/kube/config:ro -e
KUBECONFIG=/kube/config helmsman-web`), then `curl -s localhost:8787/api/health`.
Expected: image builds; health returns `{"ok":true,...}`. Open `localhost:8787`
and confirm the served UI lists live pods.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile compose.yaml .dockerignore
git commit -m "feat: containerize — kubectl/helm/claude + bun server serving built web"
```

## Task 14: Docs + parity sign-off

- [ ] **Step 1:** Update `README.md` with a "Run in Docker" section (the compose
  command, required mounts, optional `HELMSMAN_TOKEN`).
- [ ] **Step 2:** Walk every panel in the running container against a real cluster;
  record any parity gaps as follow-up `parity-feature` runs.
- [ ] **Step 3:** Per the design, the Swift app stays in-tree by default — note the
  retirement decision here only once parity is confirmed across all panels.
- [ ] **Step 4:** Commit docs.

---

## Self-review notes

- **Spec coverage:** container + kubeconfig + browser UI → Tasks 1–13; single set
  of watches feeds every view → Task 3 (WatchManager shares one watch per
  kind/ns); WS live + chat / REST actions split → Tasks 3–6; guarded actions show
  exact command → Task 6; chat action-block protocol → Tasks 5–6 + contracts doc;
  all 22 panels → Tasks 8–12; behaviors that change (notifications/port-forward/
  keychain/claude auth) → Task 12 (accounts) + Task 13 (compose mounts) + README;
  packaging → Task 13; phasing P0–P5 → Tasks 8–14.
- **Type/name consistency:** WS frame shapes (`subscribe`/`unsubscribe`/`snapshot`/
  `delta`/`chat`) match between server `ws.ts` (Task 3/5) and web `ws.ts` (Task 4);
  `applyEvent`/`WatchEventParser.push`/`buildKubectlArgs`/`buildCommand`/`checkAuth`
  signatures are consistent across their defining and calling tasks; store API
  (`upsert`/`remove`/`setConnected`) matches the orchestrator-plan Task 2 store.
- **Placeholder check:** Task 6 `buildCommand` and Task 9 panel list intentionally
  enumerate work done incrementally/by the orchestrator; each item carries a
  concrete request string + parity gate rather than a TODO.
- **Out of scope:** multi-tenant accounts, Tauri, remote-hosting hardening
  (per design "out of scope").
```
