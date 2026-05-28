# claude-k8s — Future Features Roadmap

Captures the unbuilt feature ideas so a fresh agent can pick any one up after context compaction. Grounded in the current codebase shape; each feature lists what to build, which existing files/types to reuse, and the rough order of operations.

---

## Current state (cheat sheet)

**Architecture:**
- `ClusterCache` (`Sources/ClaudeK8s/Cluster/ClusterCache.swift`) — single owner of all kubectl watches: pods, deployments, statefulsets, nodes, CNPG clusters. Polls metrics-server every 5s. Exposes `pods(matchingLabels:in:)` helper.
- Each tab has a thin `@Observable` ViewModel that reads from `ClusterCache` and holds only UI state (filters, expanded sets). VMs live as `@State` on `MainWindow` so they survive tab switches.
- `KubectlClient` (`Sources/ClaudeK8s/Cluster/KubectlClient.swift`) — actor with `getList(...)`, `watch(...)`, `getRaw(...)`. `runProcess` (`Util/ProcessAsync.swift`) honors Task cancellation (SIGTERMs subprocesses).
- `ClaudeSession` (`Sources/ClaudeK8s/Chat/ClaudeSession.swift`) — runs `claude --output-format stream-json` with a system prompt and pre-approved `Bash(kubectl get *)` etc. allowlist.
- `Theme.swift` — design tokens (Surface/Foreground/Border/Accent/Status/Pod.palette/Font helpers).
- `MarkdownTheme.swift` — MarkdownUI theme for assistant replies (tables, code blocks).

**Existing panels:** Deployments, Pods, Nodes, Databases, Logs. Wired in `Shell/MainWindow.swift` `panelView` switch + `Panels/PanelKind.swift`.

**Chat plane:** `ChatViewModel` + `ChatView`, `MessageBubble`, `ToolCard`, `PermissionSheet` (destructive-confirm modal). Context-handoff prompts built by `ContextHandoffBuilder` from `PanelSelection`.

**Goal-rated patterns:**
- New tab → add `PanelKind` case, build `PanelXViewModel(cache:)`, build `PanelXPanel`, route in `MainWindow.panelView`.
- New action → add to `PodAction`/`DeploymentAction` enums (`Panels/Actions/*` if it exists, otherwise next to the relevant panel), extend `PanelSelection`, extend `ContextHandoffBuilder.build(...)`.
- New resource type → add Codable in `Cluster/KubeTypes.swift`, add a watch in `ClusterCache`, expose `cache.<resource>`.

---

## Feature 1 — Events tab

**Why:** Rolling cluster heartbeat. Warning events flag broken things before the user notices them in the resource tabs.

**Build sketch:**
1. **Codable type** in `Cluster/KubeTypes.swift`:
   ```swift
   struct K8sEvent: Codable, Identifiable, Hashable {
       let metadata: ObjectMeta
       let type: String?              // "Normal" | "Warning"
       let reason: String?
       let message: String?
       let count: Int?
       let lastTimestamp: Date?
       let firstTimestamp: Date?
       let involvedObject: InvolvedObject?
       var id: String { metadata.uid }
   }
   struct InvolvedObject: Codable, Hashable {
       let kind: String?
       let name: String?
       let namespace: String?
   }
   ```
2. **In `ClusterCache.start`** add a watch task: `watchTask("events", c: c, into: \.events, applyEvent: applyEvent)`. Add `var events: [K8sEvent] = []` and `applyEvent(_:)`.
3. **`Panels/Events/EventsViewModel.swift`** — UI state: `typeFilter: EventType?` (all/warning/normal), `namespaceFilter: String?`, computed `filteredEvents` sorted by `lastTimestamp` desc, capped at ~500.
4. **`Panels/Events/EventsPanel.swift`** — table or LazyVStack with columns: time-ago, type pill (red for Warning, grey for Normal), reason chip, involved object, message (mono, line-limited).
5. **`PanelKind.events`** added; nav icon `exclamationmark.bubble.fill`.
6. **MainWindow** routes to it; right-click an event → "Ask Claude about this event" → new handoff case.

**Risks:**
- Events are noisy; cap to ~500, expire after 1h via `lastTimestamp`.
- `kubectl get events --watch` works fine; same shape as pods.

---

## Feature 2 — Desktop notifications (unhealthy-state alerts)

**Why:** Surface a problem the moment it appears without needing the app foreground.

**Build sketch:**
1. **`Util/NotificationCenter.swift`** — wraps `UNUserNotificationCenter`. Methods: `requestPermission()`, `post(title:body:identifier:)`.
2. On `ClaudeK8sApp.applicationDidFinishLaunching`: request permission.
3. **In `ClusterCache`** add a `watchEventsForAlerts` task or hook into `applyPod`/`applyDeployment`:
   - Pod transitions to `phase == "Failed"` or `CrashLoopBackOff`: notify "Pod <name> is crash-looping".
   - Deployment `readyReplicas < replicas` for > 60s: notify "Deployment <name> degraded".
   - Use an in-memory `Set<String>` of already-notified ids so we don't spam.
4. Tap on a notification → open the app to the relevant panel + filter to that resource. SwiftUI `OpenWindow` or `NSApp.activate` + a `notificationTarget` `@State` in MainWindow.

**Risks:**
- Permission dialog UX. Show a one-time onboarding strip in StatusBar if denied.
- Cooldown logic: don't notify the same pod twice in 5min.

---

## Feature 3 — ⌘K command palette

**Why:** ~30+ deployments × 5 tabs = too much navigating. Fuzzy-find any resource and jump.

**Build sketch:**
1. **`Shell/CommandPalette.swift`** — a SwiftUI `.sheet` triggered by global `Command + K` keyboard shortcut on MainWindow.
2. **Items:** flat list of `Command` structs derived from `ClusterCache`:
   ```swift
   enum Command: Identifiable {
       case openDeployment(Deployment)
       case openPod(Pod)
       case openNode(Node)
       case tailLogs(Deployment)
       case askClaudeAbout(Pod)        // shortcut to the existing handoff
       case switchContext(KubeContext)
       case action(label: String, system: String, run: () -> Void)
   }
   ```
3. Fuzzy matching: trivial substring-rank for v1 (lowercased substring + position bias). Skip a library.
4. Selected command → either changes `selectedPanel`, or pushes a "focus" intent to that panel (e.g., select deployment X). Add `var focusTarget: FocusTarget?` to `MainWindow` and have panels react to it.
5. Recent commands cached in `SessionStore`.

**Risks:**
- Focus-passing between palette and panel needs a clean signal — use a small `@Observable PanelFocus` injected as env.
- Keyboard event handling on macOS SwiftUI from SPM is finicky; may need an `NSEvent.addLocalMonitor` from `AppDelegate`.

---

## Feature 4 — Port-forward manager

**Why:** Easy local access to in-cluster services for dev/debugging.

**Build sketch:**
1. **`Cluster/PortForwardManager.swift`** — actor that owns a `[Forward.ID: Process]` map. `Forward` struct: `id`, `target` (service/pod/deployment ref), `remotePort`, `localPort`, `state: starting|running|failed`.
2. Spawns `kubectl port-forward <kind>/<name> <local>:<remote> -n <ns>` via `Process`; captures stderr to surface readiness ("Forwarding from 127.0.0.1:8080 ...").
3. **`Panels/PortForwards/PortForwardsPanel.swift`** — table of active forwards with Start/Stop buttons. Plus a "New Forward..." sheet that lets you pick a service, set local port.
4. Status bar (`Shell/StatusBar.swift`) shows a count of active forwards as a small chip.
5. Tear all down on app quit.

**Risks:**
- Process lifecycle: ensure SIGTERM on app quit (already handled in `runProcess` for one-shot; long-running needs explicit hook).
- Port collisions: detect EADDRINUSE in stderr, surface in the row.

---

## Feature 5 — Workload actions (restart / scale / delete pod / drain)

**Why:** Common admin operations without dropping to the terminal.

**Build sketch:**
1. **`Panels/Actions/WorkloadAction.swift`**:
   ```swift
   enum WorkloadAction { case restart(Deployment), scale(Deployment, to: Int),
                              deletePod(Pod), cordon(Node), uncordon(Node), drain(Node) }
   ```
2. **`Cluster/WorkloadCommander.swift`** — runs the kubectl command via `runProcess(...)`. Returns stdout+stderr. Doesn't bypass the chat's PermissionSheet because these are direct UI actions; instead show a local in-app confirm sheet matching `PermissionSheet` styling.
3. Wire `…` menu buttons on Deployment rows and Node cards.
4. After action: invalidate nothing; the watch will reflect changes naturally.

**Risks:**
- Scale needs an integer input field — small `.alert(...)`-style sheet.
- Drain blocks until pods evicted — show progress, don't freeze UI. Stream the command's stdout into a small in-row drawer.

---

## Feature 6 — Per-pod CPU/Mem sparklines

**Why:** Spot runaway pods at a glance instead of opening a chart elsewhere.

**Build sketch:**
1. **Codable** in `KubeTypes.swift`: `PodMetrics`, `PodMetricsList` (same shape as `NodeMetrics` but per-pod).
2. **`ClusterCache`** add another poll task hitting `/apis/metrics.k8s.io/v1beta1/pods`. Keep last N (60) samples per pod uid in a ring buffer: `var podMetricsHistory: [String: [PodMetricsSample]]`.
3. **`Shell/Sparkline.swift`** — `Canvas` view that draws ~60 points as a polyline in a 60×16 area.
4. Render two sparklines on each `PodsPanel` row (CPU and mem). Same for the children pods inside Deployment expansion.

**Risks:**
- 60 samples × ~150 pods × 2 metrics = 18k floats. Trivial memory but watch the redraw cost — only redraw on poll, not on every body re-eval.

---

## Feature 7 — Cluster overview tab (landing dashboard)

**Why:** "What's the cluster doing right now?" answer in one screen.

**Build sketch:**
1. **`Panels/Overview/OverviewPanel.swift`** — grid of summary cards:
   - Pods: total / running / pending / failed (counts + bars).
   - Nodes: ready/total, pressure conditions count.
   - Recent warning events (last 10).
   - Databases health (from `DatabasesViewModel.instances`, count unhealthy).
   - Deployments: total / unhealthy.
2. All data computed from `ClusterCache` — no new watches.
3. Make it the default panel on first launch (replace Deployments as default).

**Risks:** None really; this is a derived-view-only panel.

---

## Feature 8 — Claude "Investigate cluster" button

**Why:** Leverages the Claude integration for proactive health checks. One-click "tell me what's wrong".

**Build sketch:**
1. Button lives in StatusBar (or Overview tab when built).
2. On click, send a fixed prompt to the chat:
   > "Investigate the cluster's current health. Run kubectl read-only checks across nodes, pods, recent events, deployment status, and CNPG cluster health. Identify any issues — focus on things that are broken, broken-soon, or unusual. Be concise."
3. The system prompt + allowlist (already in `ClaudeSession`) handles the rest.
4. Optionally: collect a snapshot of `ClusterCache` state and prepend it to the prompt as context so Claude doesn't re-fetch obvious things.

**Risks:** None; piggybacks on existing infrastructure.

---

## Feature 9 — Slash commands in chat

**Why:** Faster than typing prompts for common actions.

**Build sketch:**
1. **`Chat/SlashCommand.swift`** — parse leading `/word ...` from input. Registry:
   - `/restart <deployment>` → handoff with restart action prompt
   - `/scale <deployment> <n>` → handoff with explicit kubectl scale command
   - `/logs <deployment>` → switch tab to Logs and select that deployment
   - `/describe <pod>` → run kubectl describe and inject into chat
2. **`ChatView.inputBar`** — when input starts with `/`, show a suggestion popover with matching commands and an inline description.
3. Resolution: when a slash-command is sent, intercept before `viewModel.send(text)` and route to the appropriate handler.

**Risks:**
- Argument parsing — keep it dumb (split on whitespace) and let the user retry if they fat-finger.
- Naming collisions across namespaces — when the user types `/logs blog`, if multiple match, show a disambiguation chip.

---

## Feature 10 — Image-tag display on deployments

**Why:** User deploys `:latest` everywhere; knowing which sha is actually live matters.

**Build sketch:**
1. Already have `deployment.spec?.template?.spec?.containers` from the cache (after the recent `PodTemplate` addition).
2. **`DeploymentsPanel.DeploymentRow`** — add a small chip showing `image.tag` (e.g. `sha-7ce8a31` or `latest`). Truncate at 16 chars.
3. For richer info: parse the `ghcr.io/...:<tag>@sha256:...` form; show the `:tag` and tooltip the digest.
4. For pods running under a deployment: pull the actual running image from `pod.status?.containerStatuses?.first?.imageID` — that has the real digest, not just `:latest`. Show in expanded child rows.

**Risks:** None; pure presentation.

---

## Priority order (recommendation)

If picking off the top, in roughly this order:

1. **Events tab + Notifications** (Features 1 + 2 together) — same data spine. High operational value.
2. **⌘K palette** (Feature 3) — biggest QoL win for a multi-app cluster.
3. **Cluster overview tab** (Feature 7) — natural fit as the new landing screen; cheap because it's all derived data.
4. **"Investigate cluster" button** (Feature 8) — small change, big perceived value.
5. **Image-tag display** (Feature 10) — small, useful, easy.
6. **Per-pod sparklines** (Feature 6) — adds polish.
7. **Slash commands** (Feature 9) — power-user.
8. **Workload actions** (Feature 5) — useful but introduces destructive UI complexity.
9. **Port-forward manager** (Feature 4) — useful but lifecycle management is the most involved piece.

---

## Files referenced by this plan

- `Sources/ClaudeK8s/Cluster/ClusterCache.swift` — watches/cache; add new resources here.
- `Sources/ClaudeK8s/Cluster/KubectlClient.swift` — `getList`, `watch`, `getRaw`.
- `Sources/ClaudeK8s/Cluster/KubeTypes.swift` — Codable types; new resources go here.
- `Sources/ClaudeK8s/Chat/ClaudeSession.swift` — has the system prompt + allowlist to extend.
- `Sources/ClaudeK8s/Chat/ContextHandoffBuilder.swift` — extend with new selection cases.
- `Sources/ClaudeK8s/Handoff/PanelSelection.swift` — selection enum to extend.
- `Sources/ClaudeK8s/Panels/PanelKind.swift` — new tab kinds.
- `Sources/ClaudeK8s/Shell/MainWindow.swift` — VMs + routing.
- `Sources/ClaudeK8s/Shell/Theme.swift` — design tokens.
- `Sources/ClaudeK8s/Shell/StatusBar.swift` — global status / "Investigate" button host.
