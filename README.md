# Helmsman

A native macOS control center for Kubernetes, with a built-in Claude copilot.

Helmsman gives you a fast, read-at-a-glance view of your cluster across purpose-built
panels, and pairs it with a persistent Claude chat that can investigate problems and
run changes for you — every mutation gated behind an explicit confirmation.

> The name comes from *kubernetes* — Greek for "helmsman," the one who steers the ship.

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
- **Notifications** — desktop alerts for unhealthy pods and warning events, plus
  optional webhook and Signal delivery from the in-cluster assistant (see below).

## The Assistant — autonomous remediation

The **Assistant** is an optional agent that runs **inside** your cluster, detects
incidents, has Claude diagnose them, and auto-remediates only the **safe tier** under
deterministic guardrails. Destructive actions are blocked by RBAC and instead surface
in Helmsman as suggestions for you to approve. It authenticates with your **Claude
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
- **Full visibility in Helmsman** — live incidents, an audit timeline, the queue of
  suggested fixes you can run, one-click revert from automatic backups, namespace
  scoping, and a silence list — all read from the agent's `assistant-state` /
  `assistant-config` ConfigMaps.

The agent itself lives in [`agent/`](agent/README.md) (TypeScript); its image is built
and pushed to GHCR by CI.

## Notifications

- **Desktop** — Helmsman surfaces unhealthy pods and warning events as macOS
  notifications while it's running.
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

- SwiftUI app targeting **macOS 14+**.
- `ClusterCache` owns one watch per resource type; panel view models read from it.
- `KubectlClient` wraps `kubectl` for one-shot gets, raw API calls, and long-lived watches.
- `ClaudeSession` runs the `claude` CLI in `stream-json` mode with a curated tool allowlist.
- **`HelmsmanMCP`** — a bundled MCP server that exposes structured cluster tools to Claude:
  `list_unhealthy_pods`, `list_degraded_deployments`, `recent_warning_events`, `get_pod_logs`.
- **Assistant agent** (`agent/`) — a standalone TypeScript service that runs in-cluster,
  driven by `claude -p`. It coordinates with Helmsman entirely through ConfigMaps
  (`assistant-state`, `assistant-config`, `assistant-backups`), so the app stays a thin,
  observable control surface over it.
- **Signal bridge** — Helmsman applies a `signal-cli-rest-api` Deployment/Service and
  talks to it over a short-lived `kubectl port-forward` to fetch the link QR and send
  test messages; the agent reaches it in-cluster via its service FQDN. With two-way
  enabled (`signalInbound`), the agent also polls the bridge for inbound messages and
  answers diagnosis questions / `approve` commands — see
  [`agent/README.md`](agent/README.md#two-way-signal-texting-the-assistant).

## Prerequisites

- **macOS 14 (Sonoma) or later**
- **Swift toolchain** (Xcode 16+ / Swift 6)
- **`kubectl`** on your `PATH`, with a working kubeconfig (Helmsman uses your current
  context and contexts from `~/.kube/config`)
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

## Getting started

Clone, then build and launch the app bundle:

```sh
make run
```

That compiles in debug, assembles `Helmsman.app` (ad-hoc signed with the bundled
entitlements so notifications and Dock behavior work), and opens it.

## Run in Docker / Kubernetes (web)

A self-hostable web version of Helmsman lives in this repo as a TypeScript
monorepo (`apps/web` React UI + `apps/server` Bun backend). It runs anywhere
Docker does and is viewed in a browser — no macOS or Apple signing required.

```sh
HELMSMAN_PASSWORD=changeme docker compose up --build
# then open http://localhost:8787
```

See **[WEB.md](WEB.md)** for full installation (Docker + Helm), setup
(cluster access, auth, AI token), and configuration reference.

### Make targets

| Target          | What it does                                              |
| --------------- | -------------------------------------------------------- |
| `make build`    | `swift build` (debug)                                    |
| `make app`      | Build + assemble & sign `Helmsman.app`                   |
| `make run`      | `make app`, then open the app                            |
| `make release`  | Release build                                            |
| `make release-app` / `make release-run` | Release `.app` / build + open    |
| `make clean`    | Clean SwiftPM artifacts and the `.app` bundle            |

You can also run directly via SwiftPM during development:

```sh
swift build
swift run Helmsman
```

(`make run` is recommended — it produces a properly signed bundle, which some macOS
features such as notifications require.)

### Running tests

```sh
swift test
```

## Notes

- Helmsman stores chat sessions and its generated MCP config under
  `~/Library/Application Support/com.tyrelchambers.helmsman/`.
- All cluster mutations from the app are surfaced and confirmed before they run —
  Helmsman never changes your cluster without an explicit click.
- The **Assistant** agent is the one exception by design: in **Auto** mode it applies
  safe-tier fixes on its own, within the guardrails above. Use **Advisory** mode or the
  kill-switch if you'd rather approve everything.
