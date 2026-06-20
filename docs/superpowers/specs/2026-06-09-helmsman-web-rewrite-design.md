# Rigel Web — Design

**Date:** 2026-06-09
**Branch:** `feature/web-rewrite`
**Status:** Approved (brainstorm), pending implementation plan

## Goal

Make Rigel universal: a self-hostable web application that runs in a Docker
container, is handed a kubeconfig, and serves the full Rigel UI in a browser.
Each instance is single-user, run against the operator's own cluster; "sharing"
means other people run their own container. This removes the macOS-only
constraint (run on Linux/Windows, reach it from any device) and the Apple
Developer ID dependency.

The existing native macOS SwiftUI app (`Sources/`, `Rigel.app/`) is **kept
in-tree** as the reference implementation and remains the source of truth during
the port. Nothing Swift is deleted until the web app reaches parity.

## Why this is tractable

The Swift app already does everything by **shelling out to processes**:

- All cluster operations run `kubectl` via `ProcessAsync` / `KubectlClient`.
- The copilot runs the `claude` CLI and parses its streamed JSON.

Neither is Mac-specific — both are "spawn a process, stream its output," which a
Linux container reproduces identically. The copilot model *requires* a `kubectl`
binary in its environment anyway (Claude runs `Bash(kubectl get …)`), so a
container with `kubectl` + `claude` installed reproduces the exact execution
model with no rethinking.

A large fraction of the backend already exists in TypeScript under `agent/src/`
(`kubectl.ts`, `claude.ts`, `action.ts`, `classifier.ts`, `guardrails.ts`,
`executor.ts`, `sessionStore.ts`, `StreamJsonParser` logic). The monorepo absorbs
and shares these.

The cost is concentrated in one place: **re-implementing ~33k LOC of SwiftUI
panels in web tech.** SwiftUI does not run on Linux or in a browser, so the UI is
a genuine rebuild. The rebuild is faithful to the existing panels (end-state
goal), delivered incrementally (path).

## Stack

- **Monorepo:** pnpm workspaces.
- **Frontend (`apps/web`):** React 19 + Vite + TypeScript, Tailwind v4,
  shadcn/ui, TanStack Query v5, React Router v7, Zustand for the live-watch store.
  Latest stable versions of all packages.
- **Backend (`apps/server`):** Bun (native TS, fast). Node 22 is the documented
  fallback if Bun causes friction.
- **Shared packages:** `packages/k8s` (kubectl wrappers, output parsing, resource
  types — port of `Cluster/`), `packages/catalog` (`catalog.json` + install /
  update-resolver logic), `packages/agent` (the existing in-cluster agent moved
  from `/agent`, now sharing `packages/k8s`).

## Monorepo layout

```
rigel/
├── apps/
│   ├── web/         # React 19 + Vite + Tailwind v4 + shadcn/ui + TanStack Query v5
│   └── server/      # Bun backend: kubectl/claude orchestration, WS + REST
├── packages/
│   ├── k8s/         # shared kubectl wrappers, output parsing, resource types
│   ├── catalog/     # catalog.json + install/update-resolver logic
│   └── agent/       # existing in-cluster agent, moved from /agent
├── Sources/, Rigel.app/   # Swift app — kept untouched until web parity
└── catalog.json
```

## Backend (`apps/server`)

- **Process orchestration** — spawns `kubectl` / `helm` / `claude`, reusing the
  patterns in `agent/src/kubectl.ts` and `claude.ts`.
- **Watch manager** — maintains the *single set* of `kubectl get --watch -o json`
  streams (mirrors the Swift app's "one set of watches feeds every view"), holds
  an in-memory cluster cache, diffs, and pushes deltas to subscribed clients.
- **Transport** — WebSocket for live cluster state + chat token streaming; REST
  for one-shot actions (apply / delete / scale / port-forward / secret-edit).
- **Claude session** — long-lived `claude` CLI process per chat session,
  streaming events; port `StreamJsonParser` + the action-block protocol to TS.
- **Config** — kubeconfig from a mounted path / `KUBECONFIG`; Claude subscription
  auth via mounted `~/.claude` credentials (from `claude setup-token`). Optional
  single bearer-token / password gate in front (sufficient for one-user-per-
  instance).

## Frontend (`apps/web`)

- React Query owns request/response + mutations (actions, installs, catalog). A
  thin WebSocket client feeds the Zustand store for streaming cluster state and
  chat tokens. Panels read from the store; actions go through React Query
  mutations.
- shadcn primitives do the heavy lifting: data tables (panels), **sheets** (the
  guarded-action confirm sheet that shows the exact `kubectl` command before it
  runs), dialogs, command palette.
- One route per panel. All 22 panels to port: Overview, Namespaces, Deployments,
  Pods, Workloads, Right-sizing, Nodes, Ingresses, Services, Databases, Secrets,
  ConfigMaps, Storage, RBAC, Apps (catalog), Events, Logs, Connectivity, Purge,
  Assistant, Accounts, Settings.

## Data flow

1. Browser opens WS → server ensures watches running for the active
   context/namespace → sends snapshot + deltas.
2. Panels render live from the store.
3. Mutation → confirm sheet (shows exact command) → REST POST → server runs
   guarded kubectl → result.
4. Chat: prompt over WS → claude session → streamed thinking / text / `action`
   blocks → frontend renders markdown + action buttons → button → same confirm
   sheet → REST mutation. (Ports the existing chat action-block protocol.)

## Behaviors that change (not 1:1 ports)

- **Desktop notifications** → browser Notifications API + the existing webhook /
  Signal delivery path.
- **Port-forward** → the forward now lives on the *container*, not the operator's
  laptop. Fine for a local container on localhost; matters only if hosted
  remotely later.
- **macOS Keychain (`Accounts/`)** → secrets move to a mounted file / env / small
  encrypted local store.
- **Claude auth** → subscription credentials must be mounted into the container;
  documented in the Dockerfile / compose.

## Delivery phasing

Faithful end-state, incremental path. (When the parity-orchestrator is built
first — see the companion spec — these phases are executed panel-by-panel in
porter mode.)

- **P0 — Walking skeleton:** monorepo scaffold; server with kubeconfig + WS; web
  shell with nav + **Pods panel + chat** working end-to-end. Proves
  streaming/auth/claude.
- **P1 — Read-only panels:** the remaining live/read views.
- **P2 — Guarded mutations:** scale / restart / delete / edit / port-forward +
  confirm sheets + chat action blocks.
- **P3 — Catalog:** install wizard, Purge, Updates.
- **P4 — Assistant:** in-cluster agent tab, Settings, Accounts.
- **P5 — Packaging:** Dockerfile + compose, docs. Swift app retired only after
  verified parity (decision deferred to that point; default is to keep it).

## Out of scope

- Multi-tenant / multi-user accounts and cluster isolation (each instance is
  single-user against one kubeconfig).
- Tauri / native desktop wrapper (explicitly dropped).
- Hosted/remote deployment hardening beyond the optional single-token gate.
```
