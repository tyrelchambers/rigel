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
- `swift build` — compile. `swift test` — run `Tests/HelmsmanTests`.
- `make app` assembles the `.app` bundle (not needed for parity checks).
