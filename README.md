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
  - **Deployments** — replica status, rollout history, per-container resources
  - **Pods** — phase, restarts, CPU/memory sparklines, exec, logs
  - **Nodes** — capacity, conditions, pod counts, metrics
  - **Ingresses** — class, TLS, host/path → service routing, external address
  - **Databases** — detected CloudNativePG (CNPG) clusters
  - **Secrets** — view, create, edit, and move secrets
  - **Apps** — a catalog of installable apps with a guided install wizard
  - **Events** — recent warnings and normal events, filterable
  - **Logs** — multi-pod live tail, color-coded per pod, with probe-noise filtering
- **Claude copilot** — a chat pane that understands your cluster. Ask "what's broken?"
  and it investigates using structured, purpose-built MCP tools rather than guessing.
- **Context handoff** — right-click most resources to "Ask Claude," which sends the
  relevant `describe`/logs/events context straight into the chat.
- **Guarded actions** — restarts, scaling, deletes, and secret edits run through a
  confirmation sheet that shows the exact `kubectl` command before it executes.
- **Desktop notifications** — surfaces unhealthy pods and warning events.

## Architecture at a glance

- SwiftUI app targeting **macOS 14+**.
- `ClusterCache` owns one watch per resource type; panel view models read from it.
- `KubectlClient` wraps `kubectl` for one-shot gets, raw API calls, and long-lived watches.
- `ClaudeSession` runs the `claude` CLI in `stream-json` mode with a curated tool allowlist.
- **`HelmsmanMCP`** — a bundled MCP server that exposes structured cluster tools to Claude:
  `list_unhealthy_pods`, `list_degraded_deployments`, `recent_warning_events`, `get_pod_logs`.

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

## Getting started

Clone, then build and launch the app bundle:

```sh
make run
```

That compiles in debug, assembles `Helmsman.app` (ad-hoc signed with the bundled
entitlements so notifications and Dock behavior work), and opens it.

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
- All cluster mutations are surfaced and confirmed before they run — Helmsman never
  changes your cluster without an explicit click.
