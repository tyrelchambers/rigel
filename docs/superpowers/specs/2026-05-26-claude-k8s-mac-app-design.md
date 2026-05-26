# Claude k8s Mac app — design

**Date:** 2026-05-26
**Status:** Design — not yet implementation
**Project root:** new repo (not in this k8s manifests repo)

## Goal

Build a native macOS app that wraps the `claude` CLI as a persistent conversational engine, surrounded by native UI panels for managing the k3s homelab cluster. The app's defining feature is **context handoff**: any panel selection (pod, log line, alert, node) can be sent to Claude with relevant kubectl output prefilled, so questions like "why is this pod crashing?" become a single right-click instead of a manual kubectl + paste workflow.

The Claude subscription auth is reused as-is by spawning the actual `claude` binary; the user's existing Claude Code config (skills, MCP servers, hooks, `~/.claude/CLAUDE.md`) is inherited for free.

## Non-goals

- **Not** a Claude Code replacement or competitor. The CLI does the agent work; this app organizes the surrounding context.
- **Not** cross-platform. Mac-only, signed with Developer ID, distributed personally — never the Mac App Store.
- **Not** multi-cluster federation. One kubeconfig at a time.
- **Not** a manifest editor. The git+CI flow remains the source of truth; an in-app editor invites drift.
- **Not** sandboxed. Subprocess execution and access to `~/.kube`, `~/.ssh`, `~/.claude` rule out App Sandbox.

## Scope (v1)

Four panels + chat:

1. **Pods panel** — live table from `kubectl get pods --watch -o json`, sortable, namespace filter, click-to-describe drawer.
2. **Logs panel** — multi-pod log tail (color-coded by source pod), filter/regex, pause/resume, pin-line affordance.
3. **Alerts panel** — live feed from Alertmanager `/api/v2/alerts`, ack/silence inline.
4. **Nodes panel** — three rows for the three nodes, cpu/mem requested vs allocatable vs actual, recent node-problem-detector events.
5. **Chat region** — persistent right pane (40% width), streaming markdown rendering from the `claude` subprocess, permission sheets, runbook menu.

Every panel exposes "Ask Claude about this" via right-click and a keyboard shortcut. Selection serializes through a single `ContextHandoffBuilder` into a prompt string sent to the chat.

## Layout

Single-window SwiftUI app, three regions left-to-right + a status bar:

```
┌──┬───────────────────────┬──────────────────────┐
│  │                       │                      │
│N │  Selected panel       │  Claude chat         │
│av│  (Pods/Logs/Alerts/   │  (always visible)    │
│  │   Nodes)              │                      │
│  │                       │                      │
│  │  ~60% width           │  ~40% width          │
├──┴───────────────────────┴──────────────────────┤
│ context · claude session state · kubectl ok     │
└──────────────────────────────────────────────────┘
```

Nav strip is icon-only (60 px). Status bar shows the active kubeconfig context, the claude session state (idle/streaming/awaiting-permission/error), and kubectl liveness.

## Architecture

Three decoupled planes:

### 1. Cluster data plane

For each visible panel, the app owns either a **long-lived `kubectl … --watch -o json` subprocess** (Pods, Events) or a **10 s polling timer** (Nodes). The Alerts panel is the exception: it talks HTTP to Alertmanager's REST API directly because kubectl has no native concept of "active alerts."

Watch processes emit a stream of JSON values; the `KubectlClient` consumes the stream via a streaming JSON tokenizer (since `kubectl --watch -o json` does *not* output JSONL by default — objects can span multiple lines), parses each value into a typed `WatchEvent<T>`, and exposes them as `AsyncThrowingStream`. Crash detection + exponential-backoff restart is built in. Verifying the exact streaming format is the **first** thing to confirm during implementation — fallback is 2 s polling if streaming proves unreliable.

### 2. Claude conversation plane

One `claude --output-format stream-json --input-format stream-json` subprocess per **active kubeconfig context**. Session IDs are persisted per context; switching contexts pauses the current subprocess (cleanly, preserving the session id) and resumes (or spawns) the one for the new context via `claude --resume <id>`.

Stream-json events flow through a Swift parser that emits typed values: `.textDelta`, `.toolCall`, `.permissionRequest`, `.assistantMessage`, `.userMessage`, `.completed`, `.error`. Permission requests trigger a native macOS sheet; the decision is written back to claude's stdin as a stream-json `permission_decision` event.

### 3. State plane

JSON-on-disk under `~/Library/Application Support/<bundle-id>/`. Four files, atomic writes via temp-file-and-rename:

- `sessions.json` — `{ contextName: claudeSessionId }`
- `runbooks.json` — prompt templates with `{slot}` substitution
- `ui-state.json` — last selected context, last selected panel, window geometry
- `pinned-logs.json` — pinned log lines per session

No database. No CoreData/SwiftData unless we hit pain.

### Cross-plane communication

The three planes have a single seam: **`ContextHandoffBuilder`**, a pure function that takes a `PanelSelection` and returns a prompt string with embedded kubectl output. This is the only place where panel data flows into the chat plane. Keeping that seam narrow means the chat plane never imports panel types and vice versa.

## Components

| Component | Responsibility |
|---|---|
| `ClusterContextManager` | Parses `~/.kube/config`, lists contexts, publishes active context |
| `KubectlClient` | Wraps `Process` for one-shot and watch kubectl invocations |
| `AlertmanagerClient` | `URLSession`-based HTTP polling of `/api/v2/alerts` |
| `ClaudeSession` | Owns the `claude` subprocess; stream-json parsing; permission ack |
| `ContextHandoffBuilder` | The seam — pure function from `PanelSelection` to prompt string |
| `SessionStore` | JSON-on-disk persistence |
| `PodsPanel`, `LogsPanel`, `AlertsPanel`, `NodesPanel` | SwiftUI view + view model per panel |
| `ChatView` | Streaming markdown, permission sheets, input field |
| `RunbookMenu` | Popover off chat input; runbook templates from `SessionStore` |

## Data flows

### A. "Ask Claude about this pod"

1. Right-click pod row → "Ask Claude"
2. View model fetches `kubectl describe pod` + scoped events (one-shot)
3. `ContextHandoffBuilder.build(.pod(...))` → prompt string
4. `ClaudeSession.send(prompt)` → stream-json input on stdin
5. `ChatView` (already subscribed) renders streaming response
6. If a tool call comes through, permission sheet appears
7. Approve/deny → `permission_decision` written to stdin

### B. Live pod table

1. `PodsPanel` mounts → `KubectlClient.watch(.pods, namespace:)`
2. Spawn `kubectl get pods --watch -o json`
3. Each newline = `WatchEvent`, decoded into typed value
4. View model applies the diff to `@Published var pods`
5. SwiftUI re-renders

### C. Context switch

1. User picks new context in nav
2. `ClusterContextManager` publishes change
3. Active watch processes cancelled and respawned with `--context=<new>`
4. `ClaudeSession` terminates current subprocess cleanly, spawns new one with `--resume <id-for-new-context>` (or fresh if first time)
5. `ChatView` clears and resubscribes; transcript replays from claude's saved session

## Error handling

| Failure | Behavior |
|---|---|
| `kubectl` missing | Startup-blocker screen with install hint |
| `claude` not authed | Probe at launch; show "run `claude /login` in Terminal" with a button to open Terminal.app |
| Watch subprocess crash | Exponential backoff (1s → 2s → 4s, max 30s); "reconnecting" overlay; toast after 3 consecutive crashes |
| Claude subprocess crash | Same backoff; chat shows "Claude disconnected, retrying"; session id preserved |
| Cluster unreachable | KubectlClient detects via stderr; panels grey out; chat still functions |
| Alertmanager unreachable | Alerts panel shows offline; other panels unaffected |
| kubectl exec creds prompt | v1 limitation: surface error and ask user to refresh creds in a terminal first; do not try to handle exec creds in-app |
| Claude requests destructive tool | Permission sheet shows command + red "destructive" badge for regex match on `delete\|drain\|rm -rf\|reset\|destroy`; user must check "I understand" before approve activates |

Crash isolation: each subprocess (4 panel watches + 1 claude) runs independently via `Task`. A hung kubectl in one panel doesn't block any other.

## Testing

| Tier | Coverage |
|---|---|
| Unit | `StreamJsonParser` against captured claude fixtures; `KubectlOutputDecoder` against canned `kubectl … -o json`; `WatchEvent` JSONL varieties; **`ContextHandoffBuilder` snapshot tests on every selection variant** |
| Integration | Run against the live homelab cluster — not kind/minikube. Verify `KubectlClient.watch` emits events when the cluster changes. Manual, not CI. |
| Manual | Chat + tool-use flow; permission UX edge cases (destructive detection, denial); real-world latency for 4-pod log tail |

Explicitly skipped: SwiftUI snapshot/UI tests. The testing story is rough and this is personal-use software.

## Risks and open questions

- **Keychain prompt on first claude spawn.** macOS scopes keychain entries by code-signing identity; the OAuth token Claude Code stored when run from Terminal.app may be readable by a child `claude` process spawned from this app, but might prompt the user once to allow. Worst case fallback: a "Run claude /login from this app" button that pipes through.
- **Permission UX for tool calls is the trickiest part of the chat plane.** Budget a full day for getting the approve/deny round-trip right, including the destructive-command detection.
- **`SessionStore` schema migrations.** v1 commits to JSON; if the schema evolves, hand-write migrations. Don't pre-design a migration framework.
- **Long log streams may overwhelm SwiftUI.** A 4-pod merged tail can hit hundreds of lines per second. The Logs panel needs a virtualized text view (a `NSTextView`-backed view, not SwiftUI `Text` in a `ScrollView`) — confirm before implementation.
- **Alertmanager endpoint discovery.** v1 hardcodes the tailnet URL. v2 could discover it from the cluster via the Service object.

## Future (not v1)

- Resource headroom panel (the Sentry capacity check, persistent)
- Manifest drift detector
- Tailscale-aware host list
- SigNoz embed for service-level metrics
- CNPG status panel
- Saved runbooks as one-click prompts (the data structure exists in v1; the UI is v2)
- Image freshness vs GHCR
- Action history viewer
