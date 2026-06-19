# Rigel

A Kubernetes control center with a built-in Claude copilot, available as a **macOS desktop app** (Electron).

Rigel gives you a fast, read-at-a-glance view of your cluster across purpose-built
panels, and pairs it with a persistent Claude chat that can investigate problems and
run changes for you — every mutation gated behind an explicit confirmation.

> Rigel is one of the brightest stars in the night sky — a fixed point to navigate by.

## What it does

- **Live cluster panels** — a single set of `kubectl` watches feeds every view, so
  state stays current without manual refreshes:
  - **Overview** — cluster health at a glance
  - **Assistant** — install and steer the autonomous remediation agent (see below)
  - **Namespaces** — list, create, delete, and scope other panels by namespace
  - **Deployments** — replica status, rollout history, per-container resources
  - **Pods** — phase, restarts, CPU/memory sparklines, exec, logs
  - **Workloads** — StatefulSets, DaemonSets, Jobs, and CronJobs in one place
  - **Right-sizing** — compares requests/limits against real usage and suggests fits
  - **Nodes** — capacity, conditions, pod counts, metrics
  - **Ingresses** — class, TLS, host/path → service routing, external address
  - **Services** — type, ports, endpoints, with one-click `kubectl port-forward`
  - **Databases** — detected CloudNativePG (CNPG) clusters
  - **Secrets** — view, create, edit, and move secrets
  - **ConfigMaps** — view, create, and edit config maps
  - **Storage** — PersistentVolumeClaims, PersistentVolumes, and StorageClasses
  - **RBAC** — roles, bindings, and service accounts
  - **Apps** — a catalog of installable apps with a guided install wizard
  - **Events** — recent warnings and normal events, filterable
  - **Logs** — multi-pod live tail, color-coded per pod, with probe-noise filtering
  - **Settings** — deploy the Signal notification bridge and link your phone (see below)
- **Claude copilot** — a chat pane that understands your cluster. Ask "what's broken?"
  and it investigates using structured, purpose-built MCP tools rather than guessing.
  Copy the whole conversation to the clipboard from the chat header.
- **Context handoff** — right-click most resources to "Ask Claude," which sends the
  relevant `describe`/logs/events context straight into the chat.
- **Guarded actions** — restarts, scaling, deletes, and secret edits run through a
  confirmation sheet that shows the exact `kubectl` command before it executes.
- **Notifications** — webhook and Signal delivery from the in-cluster assistant (see below).

## The Assistant — autonomous remediation

The **Assistant** is an optional agent that runs **inside** your cluster, detects
incidents, has Claude diagnose them, and auto-remediates only the **safe tier** under
deterministic guardrails. Destructive actions are blocked by RBAC and instead surface
in Rigel as suggestions for you to approve. It authenticates with your **Claude
subscription** — no API key — via a token from `claude setup-token`.

- **Guided install** — the Assistant tab installs the agent's RBAC cage, ConfigMaps,
  Secret (your OAuth token), and Deployment for you; uninstall is one click. Token
  expiry is tracked so you can refresh before it lapses.
- **Autonomy modes** — **Auto** (run safe fixes), **Advisory** (queue everything for
  approval), or **Quiet-hours** (auto during the day, queue overnight on a window).
- **Guardrails, always on** — an RBAC cage (never touches Secrets), a circuit breaker
  (per-resource/hour, nightly total, per-incident attempt caps), a spend cap, a
  **kill-switch** for an instant stop, backup-before-mutate, and fail-closed on any
  model or exec error.
- **Full visibility in Rigel** — live incidents, an audit timeline, the queue of
  suggested fixes you can run, one-click revert from automatic backups, namespace
  scoping, and a silence list — all read from the agent's `assistant-state` /
  `assistant-config` ConfigMaps.

The agent itself lives in [`agent/`](agent/README.md) (TypeScript); its image is built
and pushed to GHCR by CI.

## Notifications

- **Webhook** — point the assistant at a **Slack / Discord / ntfy** URL (Assistant tab)
  to get pushed about incidents and the actions it takes.
- **Signal** — for self-hosted push to your phone, the **Settings** tab deploys a
  self-hosted `signal-cli-rest-api` bridge into the cluster, shows an in-app QR code to
  link your device, and sends a test message. Recipients default to your own number
  (send-to-self); the assistant then messages you over Signal.
- **Signal, two-way** — flip on two-way in **Settings** and you can text the assistant
  back: ask anything to get a **read-only diagnosis** ("why is payments crashlooping?"),
  reply `queue` to list pending fixes, and `approve N` to run one through the same
  guardrails as the autonomous loop. Only your linked recipients are obeyed; texting a
  question never mutates the cluster.

## Architecture at a glance

Rigel is a **pnpm monorepo** written in TypeScript:

- **`apps/web`** — React 19 + Vite SPA. All cluster panels, the chat copilot, the
  catalog wizard, and the Assistant UI live here.
- **`apps/server`** — Node.js backend using `@hono/node-server` and `ws`. Runs the
  guarded `kubectl` commands, streams the `claude` CLI for chat (in `stream-json` mode
  with a curated tool allowlist), and manages interactive PTY sessions via `node-pty`.
- **`apps/desktop`** — Electron shell. Forks the Node server (auth disabled, loopback
  only) and loads the built SPA in a `BrowserWindow`. Produces `.app` / `.dmg`
  distributables via `electron-builder`.
- **`packages/k8s`** — shared Kubernetes client utilities (watch helpers, resource
  types).
- **`packages/catalog`** — the installable-apps catalog (also bundled into the server).
- **`agent/`** — the in-cluster Assistant agent (TypeScript); coordinates with Rigel
  entirely through ConfigMaps (`assistant-state`, `assistant-config`,
  `assistant-backups`), keeping the UI a thin, observable control surface.
- **`apps/CONTRACTS.md`** — the chat action-block contract between the server and the
  web UI (action blocks, question blocks, suggested actions).

The **Signal bridge** is a `signal-cli-rest-api` Deployment/Service applied by
Rigel. The UI reaches it over a short-lived `kubectl port-forward`; the agent
reaches it in-cluster via its service FQDN. See
[`agent/README.md`](agent/README.md#two-way-signal-texting-the-assistant).

## Prerequisites

- **`kubectl`** on your `PATH`, with a working kubeconfig (Rigel uses your current
  context and all contexts from `~/.kube/config`)
- **`claude` CLI** on your `PATH` — required for the chat copilot. The panels work
  without it; only the chat needs it.

Optional, for richer data:

- **metrics-server** — enables CPU/memory sparklines for pods and nodes
- **CloudNativePG** — enables the Databases panel

For the **Assistant** agent and **Signal** notifications:

- **A Claude subscription token** — run `claude setup-token` (on a machine signed into
  your plan) and paste it into the Assistant tab's install wizard. No API key required.
- **A default StorageClass** — the Signal bridge requests a small PersistentVolume so
  the device link survives pod restarts.

To **build from source**, you also need:

- **Node.js 20+** and **pnpm 9+**

## Getting started

### Desktop app (macOS)

Install dependencies, then run in development mode:

```sh
pnpm install
pnpm --filter desktop dev
```

To build a distributable `.dmg`:

```sh
pnpm --filter desktop dist
```

This produces unsigned arm64 and x64 DMGs under `apps/desktop/release/`. Code-signing
and notarization require an Apple Developer certificate and are a documented follow-up —
not yet implemented.

### Develop

Run the web UI and server in parallel during development:

```sh
# React SPA (Vite dev server, hot-reload)
pnpm --filter web dev

# Node backend (restarts on file changes)
pnpm --filter @helmsman/server dev   # uses tsx watch internally
```

Run tests and type-checks across the monorepo:

```sh
pnpm -r test       # vitest
pnpm -r typecheck
```

## Notes

- All cluster mutations from the app are surfaced and confirmed before they run —
  Rigel never changes your cluster without an explicit click.
- The **Assistant** agent is the one exception by design: in **Auto** mode it applies
  safe-tier fixes on its own, within the guardrails above. Use **Advisory** mode or the
  kill-switch if you'd rather approve everything.
- The `claude` CLI keeps its own state (sessions, OAuth token) under `~/.claude`.
