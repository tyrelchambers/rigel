# Parity Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic multi-agent `Workflow` that keeps the Swift app (`Sources/`) and the web app (`apps/`) implementing the same behavior, plus the minimal monorepo foundation and domain-context files it needs — then dogfood it.

**Architecture:** A manager produces one normative spec; domain sub-agents implement (porter mode: Swift extracts → web builds; feature mode: both implement); a verifier builds/tests and checks against the spec. Sub-agents are grounded by per-app `CLAUDE.md` files and a shared-contracts doc that the manager owns.

**Tech Stack:** pnpm workspaces, Vite + React 19 + TypeScript + Tailwind v4 + shadcn/ui + TanStack Query v5 + React Router v7 + Zustand (web), Bun (server), the `Workflow` tool (orchestrator script in JS).

**Spec:** `docs/superpowers/specs/2026-06-09-parity-orchestrator-design.md` (companion: `2026-06-09-rigel-web-rewrite-design.md`).

**Scope boundary:** This plan establishes the monorepo foundation, the orchestrator, and a validated dogfood run. Actually porting the 22 panels is the separate web-rewrite plan, executed *through* this orchestrator.

---

## File structure

| Path | Responsibility |
|---|---|
| `pnpm-workspace.yaml`, `package.json` | Monorepo workspace definition |
| `apps/web/` | React shell: Vite + Tailwind v4 + shadcn/ui + TanStack Query + router + Zustand store; nav + empty panel routes |
| `apps/server/` | Bun server skeleton: health route, WS endpoint, kubeconfig + context discovery |
| `packages/k8s/`, `packages/catalog/` | Empty typed stubs (write targets for ported logic) |
| `Sources/Rigel/CLAUDE.md` | Swift-domain conventions for the extractor/implementer agent |
| `apps/CLAUDE.md` | Web-domain conventions for the builder/implementer agent |
| `docs/parity/contracts.md` | Manager-owned shared contracts (action-block protocol, MCP tools, catalog schema) |
| `.claude/workflows/parity-feature.js` | The orchestrator Workflow script |

Note: `docs/` is gitignored in this repo but design/plan/parity docs are tracked via `git add -f` (established convention). Use `git add -f` for files under `docs/`.

---

## Task 1: pnpm monorepo workspace

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json`
- Create: `.npmrc`

- [ ] **Step 1: Create the workspace manifest**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 2: Create the root package.json**

`package.json`:
```json
{
  "name": "rigel-monorepo",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  },
  "packageManager": "pnpm@10.11.0"
}
```

- [ ] **Step 3: Pin pnpm behavior**

`.npmrc`:
```
auto-install-peers=true
strict-peer-dependencies=false
```

- [ ] **Step 4: Verify the workspace resolves**

Run: `pnpm install`
Expected: completes with "Done" and no workspace errors (no packages yet is fine).

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml package.json .npmrc pnpm-lock.yaml
git commit -m "chore: pnpm monorepo workspace"
```

---

## Task 2: Web app shell (Vite + React + Tailwind v4 + shadcn + TanStack Query)

**Files:**
- Create: `apps/web/` (Vite scaffold)
- Modify: `apps/web/package.json`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`
- Create: `apps/web/src/lib/queryClient.ts`, `apps/web/src/store/cluster.ts`

- [ ] **Step 1: Scaffold Vite React-TS app**

Run:
```bash
pnpm create vite@latest apps/web -- --template react-ts
cd apps/web && pnpm add @tanstack/react-query@latest react-router@latest zustand@latest && pnpm add -D tailwindcss@latest @tailwindcss/vite@latest && cd ../..
```
Expected: `apps/web` created; dependencies installed.

- [ ] **Step 2: Wire Tailwind v4 via the Vite plugin**

`apps/web/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: { proxy: { "/api": "http://localhost:8787", "/ws": { target: "ws://localhost:8787", ws: true } } },
});
```

`apps/web/src/index.css` (replace contents):
```css
@import "tailwindcss";
```

- [ ] **Step 3: Initialize shadcn/ui**

Run:
```bash
cd apps/web && pnpm dlx shadcn@latest init -d && pnpm dlx shadcn@latest add button table sheet dialog && cd ../..
```
Expected: `components.json` created, `src/components/ui/{button,table,sheet,dialog}.tsx` added.

- [ ] **Step 4: Create the React Query client**

`apps/web/src/lib/queryClient.ts`:
```ts
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } },
});
```

- [ ] **Step 5: Create the live-cluster Zustand store (WS-fed)**

`apps/web/src/store/cluster.ts`:
```ts
import { create } from "zustand";

type ResourceMap = Record<string, Record<string, unknown>>; // kind -> name -> object

interface ClusterState {
  connected: boolean;
  resources: ResourceMap;
  setConnected: (c: boolean) => void;
  upsert: (kind: string, name: string, obj: unknown) => void;
  remove: (kind: string, name: string) => void;
}

export const useCluster = create<ClusterState>((set) => ({
  connected: false,
  resources: {},
  setConnected: (connected) => set({ connected }),
  upsert: (kind, name, obj) =>
    set((s) => ({ resources: { ...s.resources, [kind]: { ...s.resources[kind], [name]: obj } } })),
  remove: (kind, name) =>
    set((s) => {
      const next = { ...s.resources[kind] };
      delete next[name];
      return { resources: { ...s.resources, [kind]: next } };
    }),
}));
```

- [ ] **Step 6: Wire providers + router shell**

`apps/web/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { queryClient } from "./lib/queryClient";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

`apps/web/src/App.tsx`:
```tsx
import { NavLink, Routes, Route } from "react-router";

const PANELS = ["overview", "pods", "deployments", "services"]; // grows as panels are ported

export default function App() {
  return (
    <div className="flex h-screen">
      <nav className="w-48 border-r p-2 space-y-1">
        {PANELS.map((p) => (
          <NavLink key={p} to={`/${p}`} className="block rounded px-2 py-1 hover:bg-muted capitalize">
            {p}
          </NavLink>
        ))}
      </nav>
      <main className="flex-1 overflow-auto p-4">
        <Routes>
          <Route path="/" element={<div>Rigel Web</div>} />
          {PANELS.map((p) => (
            <Route key={p} path={`/${p}`} element={<div className="capitalize">{p} panel (not yet ported)</div>} />
          ))}
        </Routes>
      </main>
    </div>
  );
}
```

- [ ] **Step 7: Add typecheck + build scripts**

In `apps/web/package.json` `scripts`, ensure:
```json
"build": "tsc -b && vite build",
"typecheck": "tsc --noEmit",
"test": "vitest run --passWithNoTests"
```
Then: `cd apps/web && pnpm add -D vitest@latest && cd ../..`

- [ ] **Step 8: Verify it builds**

Run: `pnpm --filter web build`
Expected: Vite build succeeds, `apps/web/dist` produced.

- [ ] **Step 9: Commit**

```bash
git add apps/web package.json pnpm-lock.yaml
git commit -m "feat(web): app shell — Vite/React/Tailwind v4/shadcn/TanStack Query"
```

---

## Task 3: Server skeleton (Bun: health + WS + kubeconfig)

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`
- Create: `apps/server/src/index.ts`, `apps/server/src/kubeconfig.ts`
- Test: `apps/server/src/kubeconfig.test.ts`

- [ ] **Step 1: Create the package**

`apps/server/package.json`:
```json
{
  "name": "@rigel/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "build": "bun build src/index.ts --target=bun --outdir=dist",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "devDependencies": { "@types/bun": "latest", "typescript": "latest" }
}
```

`apps/server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 2: Write the failing test for kubeconfig resolution**

`apps/server/src/kubeconfig.test.ts`:
```ts
import { test, expect } from "bun:test";
import { resolveKubeconfigPath } from "./kubeconfig";

test("prefers KUBECONFIG env over default", () => {
  expect(resolveKubeconfigPath({ KUBECONFIG: "/mnt/kc" }, "/home/u")).toBe("/mnt/kc");
});

test("falls back to ~/.kube/config", () => {
  expect(resolveKubeconfigPath({}, "/home/u")).toBe("/home/u/.kube/config");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/server && bun test`
Expected: FAIL — `resolveKubeconfigPath` not exported / module missing.

- [ ] **Step 4: Implement kubeconfig resolution**

`apps/server/src/kubeconfig.ts`:
```ts
import { join } from "node:path";

/** Resolve the kubeconfig path: explicit KUBECONFIG wins, else ~/.kube/config. */
export function resolveKubeconfigPath(env: Record<string, string | undefined>, home: string): string {
  const fromEnv = env.KUBECONFIG?.trim();
  if (fromEnv) return fromEnv;
  return join(home, ".kube", "config");
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd apps/server && bun test`
Expected: PASS (2 tests).

- [ ] **Step 6: Write the server entrypoint**

`apps/server/src/index.ts`:
```ts
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

console.log(`rigel server on :${server.port} (kubeconfig=${KUBECONFIG})`);
```

- [ ] **Step 7: Verify it boots and serves health**

Run: `cd apps/server && (bun src/index.ts &) && sleep 1 && curl -s localhost:8787/api/health && echo && kill %1 2>/dev/null; cd ../..`
Expected: JSON like `{"ok":true,"kubeconfig":"…/.kube/config"}`.

- [ ] **Step 8: Commit**

```bash
git add apps/server pnpm-lock.yaml
git commit -m "feat(server): Bun skeleton — health, WS echo, kubeconfig resolution"
```

---

## Task 4: Package stubs (`packages/k8s`, `packages/catalog`)

**Files:**
- Create: `packages/k8s/package.json`, `packages/k8s/src/index.ts`
- Create: `packages/catalog/package.json`, `packages/catalog/src/index.ts`

- [ ] **Step 1: Create k8s stub**

`packages/k8s/package.json`:
```json
{
  "name": "@rigel/k8s",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "build": "tsc --noEmit", "typecheck": "tsc --noEmit", "test": "bun test" }
}
```
`packages/k8s/src/index.ts`:
```ts
// kubectl wrappers, output parsing, and resource types are ported here
// from Sources/Rigel/Cluster/ via the parity orchestrator.
export {};
```

- [ ] **Step 2: Create catalog stub**

`packages/catalog/package.json`:
```json
{
  "name": "@rigel/catalog",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "build": "tsc --noEmit", "typecheck": "tsc --noEmit", "test": "bun test" }
}
```
`packages/catalog/src/index.ts`:
```ts
// catalog.json schema + install/update-resolver logic ported here from
// Sources/Rigel/Catalog/ and Sources/Rigel/Updates/.
export {};
```

- [ ] **Step 3: Verify workspace still resolves**

Run: `pnpm install && pnpm -r typecheck`
Expected: install OK; typecheck passes (stubs are empty).

- [ ] **Step 4: Commit**

```bash
git add packages pnpm-lock.yaml
git commit -m "chore: package stubs for k8s + catalog logic"
```

---

## Task 5: Swift-domain context (`Sources/Rigel/CLAUDE.md`)

**Files:**
- Create: `Sources/Rigel/CLAUDE.md`

- [ ] **Step 1: Write the Swift conventions doc**

`Sources/Rigel/CLAUDE.md`:
```markdown
# Swift app — domain notes (for the parity extractor/implementer)

Native macOS SwiftUI app (SwiftPM, `Package.swift`, macOS 14+). This is the
SOURCE OF TRUTH during the web port.

## Layout
- `Panels/<Name>/` — one folder per UI panel (Overview, Pods, Deployments, …).
  A panel is a SwiftUI `View` + a `@MainActor` view model (`ObservableObject`).
- `Cluster/` — `KubectlClient`, resource types (`KubeTypes`, `Service`,
  `Ingress`, `Secret`, `ConfigMap`, …), `ResourceQuantity` parsing.
- `Chat/` — `ClaudeSession` (actor wrapping the `claude` CLI), `StreamJsonParser`,
  `SuggestedAction` (action-block model), message rendering (MarkdownUI).
- `Shell/`, `Util/ProcessAsync.swift` — process spawning + pipe drainage.
- `State/` — `SessionStore`, `SelfHostDefaults`.

## How cluster I/O works
- ALL cluster reads/writes shell out to `kubectl` via `ProcessAsync` /
  `KubectlClient`. There is no client library. Commands carry `--context`.
- Live views are fed by `kubectl get … --watch -o json` streams; one set of
  watches feeds every panel from a shared cache.
- Mutations never run inline from chat — Claude emits an action block, the app
  renders a button, and a confirm sheet shows the exact `kubectl` command
  before running it (see `docs/parity/contracts.md`).

## When EXTRACTING a panel for the web port, report:
- Every column/field shown and where its value comes from (which kubectl
  command / JSON path).
- Every user action (buttons, context menu / "Ask Claude" handoff, port-forward)
  and the exact kubectl command each runs.
- Empty/loading/error states and any filtering (e.g. namespace scope, probe-noise
  filtering in Logs).
- Polling/watch cadence and which resource kinds the panel subscribes to.
Do NOT write code in extractor mode.

## Build / test
- `swift build` — compile. `swift test` — run `Tests/RigelTests`.
- `make app` assembles the `.app` bundle (not needed for parity checks).
```

- [ ] **Step 2: Commit**

```bash
git add -f Sources/Rigel/CLAUDE.md
git commit -m "docs(swift): domain context for parity orchestrator"
```

---

## Task 6: Web-domain context (`apps/CLAUDE.md`)

**Files:**
- Create: `apps/CLAUDE.md`

- [ ] **Step 1: Write the web conventions doc**

`apps/CLAUDE.md`:
```markdown
# Web app — domain notes (for the parity web builder/implementer)

TypeScript monorepo. `apps/web` (frontend), `apps/server` (Bun backend),
shared `packages/k8s` + `packages/catalog`.

## Stack & conventions
- React 19 + Vite + TypeScript. Tailwind v4 (via `@tailwindcss/vite`, `@import
  "tailwindcss"` in `index.css`). shadcn/ui for primitives — add components with
  `pnpm dlx shadcn@latest add <name>`; do not hand-roll what shadcn provides.
- **TanStack Query v5** owns request/response + mutations (one-shot reads,
  actions, installs). Query keys: `[kind, namespace?, name?]`.
- **Zustand store** (`src/store/cluster.ts`) holds live cluster state, fed by the
  WebSocket. Panels read live lists from the store, not from polling queries.
- **React Router v7** — one route per panel under `src/panels/<name>/`.
- Path alias `@/` → `apps/web/src`.

## Transport split (talk to the server, never kubectl directly)
- **WebSocket `/ws`** — subscribe to live resource watches (snapshot + deltas)
  and stream chat tokens/thinking/action-blocks.
- **REST `/api/*`** — one-shot mutations (scale/restart/delete/edit/port-forward)
  and catalog installs. The server runs the guarded kubectl.

## Guarded actions (MUST match the Swift behavior)
- Every mutation goes through a confirm **Sheet** (shadcn `sheet`) that shows the
  EXACT kubectl command before it runs. Never mutate without it.
- Chat action blocks render as buttons that open the same confirm sheet. The
  action-block JSON schema is fixed — see `docs/parity/contracts.md`. Do not
  invent new `kind` values.

## When BUILDING from a parity spec
- Implement to the normative spec in `docs/parity/<feature>.md` exactly — same
  columns, actions, edge cases, and kubectl commands the extractor recorded.
- Put panel UI in `apps/web/src/panels/<name>/`, server routes in
  `apps/server/src/`, shared parsing/types in `packages/k8s`.

## Build / test
- `pnpm --filter web build`, `pnpm --filter web test` (vitest),
  `pnpm --filter web typecheck`.
- `pnpm --filter @rigel/server test` (bun test), `… build`.
```

- [ ] **Step 2: Commit**

```bash
git add apps/CLAUDE.md
git commit -m "docs(web): domain context for parity orchestrator"
```

---

## Task 7: Shared contracts doc (`docs/parity/contracts.md`)

**Files:**
- Create: `docs/parity/contracts.md`

- [ ] **Step 1: Write the contracts doc with the real, current contracts**

`docs/parity/contracts.md` (content below is extracted from
`Sources/Rigel/Chat/SuggestedAction.swift`, `ClaudeSession.swift`,
`Sources/RigelMCP/main.swift`, and `Sources/Rigel/Resources/catalog.json`):

````markdown
# Shared contracts (manager-owned — handed identically to both apps)

These three surfaces MUST be byte-identical across the Swift and web apps.
Neither sub-agent may re-derive or extend them per app.

## 1. Chat action-block protocol

Claude never runs mutations itself. For any cluster change it appends a fenced
```` ```action ```` block; the app hides the raw block, renders a one-click
button, and runs the change through its own confirm sheet (exact kubectl shown
first). Prose still explains what/why.

Action JSON (`SuggestedAction`):
- `label` (string, required) — button text.
- `kind` (string, required) — one of:
  `restart`, `scale`, `rollback`, `setEnv`, `setImage`, `setResources`,
  `pause`, `resume`, `deletePod`, `deleteWorkload`, `cordon`, `uncordon`,
  `drain`, `suspendCronJob`, `resumeCronJob`, `triggerCronJob`,
  `createNamespace`, `deleteNamespace`, `deleteResource`, `purge`, `command`.
- Target fields (presence depends on kind):
  - `name` — controller / cronjob / namespace / resource target.
    (`deployment` is accepted as a back-compat alias; `target = name ?? deployment`.)
  - `pod`, `node`, `namespace`.
  - `replicas` (int) — scale.
  - `env` (object string→string) — setEnv.
  - `container`, `image` — setImage. `container`, `requests`, `limits` — setResources
    (kubectl quantity strings, e.g. `cpu=250m,memory=512Mi`).
  - `resourceKind` — deleteResource (e.g. `service`, `configmap`, `secret`,
    `pvc`, `pv`, `ingress`, `clusterrole`).
  - `args` (string[]) — `command` only: literal kubectl args WITHOUT the `kubectl`
    binary or `--context` (app prepends both), e.g. `["cnpg","destroy","pg","pg-1","-n","default"]`.
  - `destructive` (bool) — `command` only: Claude's hint. App also infers from
    destructive verbs in `args` and takes the STRICTER of the two (a `false` can
    never downgrade an obviously destructive command).

Special kinds:
- `purge` — full app removal. Emit `{"kind":"purge","name":<root-deployment>,"namespace":<ns>}`.
  Opens the typed-name purge confirm sheet (discovery against the live cache).
  Never list resources to delete one-by-one for a full removal.
- `command` — escape hatch for kubectl (incl. plugins like `cnpg`) the typed
  kinds don't model.

Examples:
```action
{"label":"Set MEMOS_PORT=5230 & restart memos","kind":"setEnv","name":"memos","namespace":"default","env":{"MEMOS_PORT":"5230"}}
```
```action
{"label":"Right-size web to req cpu=250m,memory=512Mi","kind":"setResources","name":"web","namespace":"default","container":"web","requests":"cpu=250m,memory=512Mi","limits":"cpu=500m,memory=1Gi"}
```
```action
{"label":"Drain node worker-3","kind":"drain","node":"worker-3"}
```

## 2. MCP tools (`rigel` server)

The copilot reads the cluster through purpose-built MCP tools (plus the
read-only kubectl allowlist). Current tools (`Sources/RigelMCP/main.swift`):
- `list_unhealthy_pods` — pods not Running/Ready, with reasons.
- `list_degraded_deployments` — deployments with unavailable replicas.
- `recent_warning_events` — recent Warning events.
- `get_pod_logs` — logs for a named pod (requires `name`).

Tool names/shapes are part of the contract — keep identical names and input
schemas across apps.

## 3. catalog.json schema

`Sources/Rigel/Resources/catalog.json` — top level `{ "apps": [ … ] }`
(54 entries). Each app:
- `id`, `name`, `tagline`, `description`, `category`, `iconSystemName`.
- `docsURL`, `repoURL`, `homepageURL`, `tags`.
- `install` — `{ "mode": "manifest" | "helm", … }`. For `manifest`, an inline
  multi-doc YAML `manifest` string with template vars `{{instance}}`,
  `{{namespace}}`, `{{storage}}` (and others a panel may substitute).
- `matchImages` — image refs used to detect an installed instance.
- `requirements`, `persistence` (bool/int), `exposesIngress` (bool), `notes`,
  `installPromptTemplate`.

When porting catalog logic, preserve the exact key names and template-var syntax.
````

- [ ] **Step 2: Commit**

```bash
git add -f docs/parity/contracts.md
git commit -m "docs(parity): shared contracts — action blocks, MCP tools, catalog schema"
```

---

## Task 8: The parity-orchestrator Workflow script

**Files:**
- Create: `.claude/workflows/parity-feature.js`

- [ ] **Step 1: Write the workflow script**

`.claude/workflows/parity-feature.js`:
```js
export const meta = {
  name: 'parity-feature',
  description: 'Keep the Swift and web Rigel apps in parity for one change',
  whenToUse: 'Porting a Swift panel to web (mode=porter) or adding a feature to both apps (mode=feature)',
  phases: [
    { title: 'Spec' },
    { title: 'Implement' },
    { title: 'Verify' },
  ],
}

// args: { mode: 'porter' | 'feature', feature: string, request: string }
const mode = (args && args.mode) || 'porter'
const feature = (args && args.feature) || 'unnamed-feature'
const request = (args && args.request) || ''

const CONTRACTS = 'docs/parity/contracts.md'
const SWIFT_CTX = 'Sources/Rigel/CLAUDE.md'
const WEB_CTX = 'apps/CLAUDE.md'
const SPEC_PATH = `docs/parity/${feature}.md`

const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'behavior', 'acceptance'],
  properties: {
    title: { type: 'string' },
    behavior: { type: 'string', description: 'Columns/fields, user actions, edge cases, EXACT kubectl commands' },
    contracts: { type: 'string', description: 'Shared-contract touchpoints (action-block kinds, MCP tools, catalog keys)' },
    acceptance: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['parity', 'issues'],
  properties: {
    parity: { type: 'boolean' },
    buildPassed: { type: 'boolean' },
    testsPassed: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

log(`parity-feature: mode=${mode} feature=${feature}`)

// ---- Phase 1: Spec --------------------------------------------------------
phase('Spec')
let spec
if (mode === 'porter') {
  spec = await agent(
    `You are the SWIFT-DOMAIN EXTRACTOR. Read ${SWIFT_CTX} and ${CONTRACTS}. ` +
    `Then read the Swift implementation of "${feature}" under Sources/Rigel/ (panels live in Sources/Rigel/Panels/). ` +
    `Produce a normative behavior spec for porting it to web. Write the FULL spec to ${SPEC_PATH} (use git add -f if committing later), ` +
    `then return the structured summary. Record every column/field and its kubectl source, every user action and the exact ` +
    `kubectl command it runs, edge/empty/error states, and which resource kinds it watches. DO NOT write any application code. ` +
    `Request context: ${request}`,
    { label: `extract:${feature}`, phase: 'Spec', schema: SPEC_SCHEMA, agentType: 'Explore' },
  )
} else {
  spec = await agent(
    `You are the PARITY MANAGER. Read ${CONTRACTS}. Author a normative behavior spec for this NEW feature, to be implemented ` +
    `identically in both apps. Write the FULL spec to ${SPEC_PATH}, then return the structured summary. Define behavior, ` +
    `shared-contract touchpoints, and acceptance criteria. Request: ${request}`,
    { label: `spec:${feature}`, phase: 'Spec', schema: SPEC_SCHEMA },
  )
}

if (!spec) {
  log('Spec phase produced no spec — aborting.')
  return { mode, feature, error: 'no-spec' }
}

// ---- Phase 2: Implement ---------------------------------------------------
phase('Implement')
const specJson = JSON.stringify(spec)
let implementation
if (mode === 'porter') {
  const web = await agent(
    `You are the WEB BUILDER. Read ${WEB_CTX} and ${CONTRACTS}. Implement the feature specified in ${SPEC_PATH} in the web ` +
    `monorepo (apps/web panel under src/panels/, apps/server routes, shared logic in packages/k8s). Match the extracted behavior ` +
    `EXACTLY — same columns, actions, edge cases, and kubectl commands. Follow the web stack conventions. Spec summary: ${specJson}`,
    { label: `build-web:${feature}`, phase: 'Implement' },
  )
  implementation = { web }
} else {
  const [swiftImpl, webImpl] = await parallel([
    () => agent(
      `You are the SWIFT IMPLEMENTER. Read ${SWIFT_CTX} and ${CONTRACTS}. Implement ${SPEC_PATH} in Sources/Rigel/ following ` +
      `existing panel/view-model patterns. Match the spec exactly. Spec summary: ${specJson}`,
      { label: `build-swift:${feature}`, phase: 'Implement' },
    ),
    () => agent(
      `You are the WEB IMPLEMENTER. Read ${WEB_CTX} and ${CONTRACTS}. Implement ${SPEC_PATH} in apps/ (+ packages/). ` +
      `Match the spec exactly. Spec summary: ${specJson}`,
      { label: `build-web:${feature}`, phase: 'Implement' },
    ),
  ])
  implementation = { swift: swiftImpl, web: webImpl }
}

// ---- Phase 3: Verify ------------------------------------------------------
phase('Verify')
const targets = mode === 'porter' ? ['web'] : ['web', 'swift']
const verdicts = (await parallel(targets.map((t) => () =>
  agent(
    t === 'web'
      ? `You are the WEB VERIFIER. Run: pnpm --filter web typecheck && pnpm --filter web build && pnpm --filter web test, ` +
        `and pnpm --filter @rigel/server test. Then check the implementation against the acceptance criteria in ${SPEC_PATH}. ` +
        `Return the verdict (parity true only if build+tests pass AND acceptance criteria are met).`
      : `You are the SWIFT VERIFIER. Run: swift build && swift test. Then check against the acceptance criteria in ${SPEC_PATH}. ` +
        `Return the verdict (parity true only if build+tests pass AND acceptance criteria are met).`,
    { label: `verify:${t}`, phase: 'Verify', schema: VERDICT_SCHEMA },
  ).then((v) => (v ? { target: t, ...v } : { target: t, parity: false, issues: ['verifier returned null'] })),
))).filter(Boolean)

const allParity = verdicts.length > 0 && verdicts.every((v) => v.parity)
log(`parity-feature done: parity=${allParity}`)
return { mode, feature, specPath: SPEC_PATH, spec, implementation, verdicts, parity: allParity }
```

- [ ] **Step 2: Verify the script parses as a module**

Run: `node --input-type=module --check < .claude/workflows/parity-feature.js && echo "SYNTAX OK"`
Expected: `SYNTAX OK` (syntax check only — the `agent`/`phase`/`parallel` globals are provided by the Workflow runtime at execution time, not by Node).

- [ ] **Step 3: Commit**

```bash
git add -f .claude/workflows/parity-feature.js
git commit -m "feat(parity): orchestrator workflow — manager/extractor + builder + verifier"
```

---

## Task 9: Dogfood validation run

This validates the orchestrator end-to-end on a tiny, low-risk target before the
web-rewrite plan uses it for all 22 panels.

**Files:** none created by this task directly; the run produces
`docs/parity/health-probe.md` and a web `health` route via the builder agent.

- [ ] **Step 1: Run the orchestrator in porter mode on a trivial slice**

Invoke the `Workflow` tool:
- `name`: `parity-feature`
- `args`: `{ "mode": "porter", "feature": "health-probe", "request": "Port only the cluster-reachability/health indicator: extract how the Swift Overview panel determines the cluster is reachable (which kubectl command, e.g. kubectl version / cluster-info) and reproduce it as a tiny web panel route /health that calls the server and shows reachable/unreachable." }`

Expected: a `<task-notification>` on completion; the returned object has
`specPath: "docs/parity/health-probe.md"`, an `implementation.web` summary, and
`verdicts` with `parity: true`.

- [ ] **Step 2: Confirm the spec artifact exists**

Run: `cat docs/parity/health-probe.md | head -30`
Expected: a normative spec with behavior + acceptance criteria (not empty).

- [ ] **Step 3: Confirm the web build still passes**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: both succeed.

- [ ] **Step 4: Review the diff, then commit if acceptable**

Run: `git status && git --no-pager diff --stat`
Then (after human review of the generated panel + spec):
```bash
git add -f docs/parity/health-probe.md
git add apps/
git commit -m "feat(web): health-probe panel via parity orchestrator (dogfood)"
```

- [ ] **Step 5: Record the outcome**

If `parity` was false or the verifier flagged issues, note them and adjust the
orchestrator prompts in `.claude/workflows/parity-feature.js` (Task 8) before the
web-rewrite plan relies on it. If parity was true, the orchestrator is ready to
drive the web-rewrite plan.

---

## Self-review notes

- **Spec coverage:** core rule (spec-first) → Tasks 7+8; two modes → Task 8 (`mode` branch); domain knowledge → Tasks 5/6; shared contracts → Task 7; Workflow structure (manager/extract-implement/verify) → Task 8; verification commands → Task 8 verifier prompts; minimal monorepo foundation → Tasks 1–4; build-order step 4 (dogfood P0-ish) → Task 9.
- **Type/name consistency:** workflow returns `{ mode, feature, specPath, spec, implementation, verdicts, parity }`; `SPEC_PATH = docs/parity/${feature}.md` used consistently; store API (`upsert`/`remove`/`setConnected`) matches between Task 2 step 5 and the web context doc.
- **Out of scope (here):** porting the 22 panels (web-rewrite plan); kubectl watch manager + claude session in the server (web-rewrite plan P0/P2) — the server here is only a health+WS-echo skeleton.
```
