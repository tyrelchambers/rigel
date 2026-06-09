# Logs Panel — Normative Behavior Spec

## Overview

The Logs panel tails pod logs in real-time, with multi-pod support, per-pod color coding, probe-noise filtering, and live follow/pause controls. This spec documents the exact behavior of the Swift implementation for web porting.

## Data Model

### LogLine
Each log line produced has:
- `id`: UUID (unique per line instance)
- `sourcePod`: string (pod name, e.g. `"memos-abc123-def45"`, extracted from kubectl prefix `[pod/<name>/<container>]`)
- `timestamp`: Date | null (parsed from ISO8601 in `kubectl logs --timestamps` output; may be null if unparseable)
- `text`: string (the log message itself, after prefix and timestamp removed)
- `colorIndex`: int (0-7, stable hash of pod name via FNV-1a)

### PodColorAssigner
Color assignment is deterministic and stable across restarts:
- Use FNV-1a 32-bit hash of the pod name
- `hash = 2166136261`
- For each UTF-8 byte in the pod name:
  - `hash ^= byte`
  - `hash *= 16777619`
- `colorIndex = hash % 8`
- The 8-color palette (hex codes):
  - `#60A5FA` (blue)
  - `#34D399` (green)
  - `#FB923C` (orange)
  - `#A855F7` (purple)
  - `#EC4899` (pink)
  - `#22D3EE` (cyan)
  - `#FACC15` (yellow)
  - `#2DD4BF` (teal)

## User Interface Layout

### Sidebar (left panel, 220–360px wide)
- **Header**: "Deployments" label + count (e.g. "12")
- **Scrollable list** of deployments sorted by namespace, then by name
  - Each row shows:
    - Deployment name (monospace, medium weight)
    - Namespace (monospace, small)
    - Ready/total replicas (e.g. "3/3", red text if ready < total)
    - Left border accent color (matches pod color palette, keyed to namespace/deployment name)
    - Selected row highlights with elevated background

### Stream pane (right panel, flexible width)
- **Empty state** (before selection):
  - Icon: `text.alignleft` system icon
  - Text: "Pick a deployment to tail its logs"
  - Subtitle: "Click any deployment on the left to open a live log stream here."

- **Stream view** (when deployment selected):
  - **Header** (elevation 1):
    - Colored circle (pod accent color)
    - Deployment name (monospace, semibold)
    - Namespace badge (monospace, small, sunken background)
    - Close button (X icon, sunken background)
  - **Toolbar** (elevation 1):
    - Filter text input (with magnifying glass icon, placeholder "filter")
    - "Wrap lines" toggle (arrow.turn.down.left icon, `⌥⌘W` shortcut)
    - "Hide probes" toggle (heart.slash icon, filters kube-probe/health/readiness lines)
    - Play/pause toggle (play.fill or pause.fill)
    - Clear button (trash icon)
  - **Error banner** (if error state):
    - Red foreground, monospace font
    - Error message from kubectl
  - **Log scroll area**:
    - Monospace font (11pt)
    - Each log line shows:
      - 2px colored left border (per-pod color)
      - Pod name (150px, truncated middle)
      - Timestamp (80px, HH:MM:SS.sss format if present)
      - Message text (flex, monospace, red if contains "error"/"fatal"/"panic")
      - Tap to expand single line to multi-line
    - Auto-scroll to bottom when new lines arrive AND user is at bottom (sticky)
    - "Jump to latest" button (floating bottom-right, visible when scrolled up)

## kubectl Integration

### Initial tail command
When a deployment is selected, a multi-pod tail is started:
```
kubectl logs -f --timestamps --prefix=true --all-containers=true \
  -n <namespace> -l <labelSelector> \
  --max-log-requests=20 --tail=200 \
  [--context <context>]
```
- `-f`: follow (live stream)
- `--timestamps`: prepend ISO8601 timestamp to each line
- `--prefix=true`: prepend pod/container name in format `[pod/<name>/<container>]`
- `--all-containers=true`: tail all containers across all matching pods
- `-n <namespace>`: the deployment's namespace
- `-l <labelSelector>`: the deployment's `spec.selector.matchLabels` joined as key=val,key=val
- `--max-log-requests=20`: limit concurrent pod stream connections
- `--tail=200`: start with last 200 lines per pod
- `--context <context>`: (optional) kubernetes context to use

### Line format parsing
kubectl outputs each line as:
```
[pod/<pod-name>/<container-name>] 2025-06-09T17:15:42.123456789Z <actual message>
```

LogLineParser extracts:
1. Pod name from prefix regex `^\[pod/([^/\]]+)/[^\]]+\]\s+`
2. Timestamp (ISO8601 with fractional seconds) up to the first space after prefix removal
3. Everything after timestamp as text
4. If timestamp unparseable, entire remainder is text with timestamp = null

### Probe-noise filter
Matches and filters lines that are high-frequency kubelet/health-check noise:

**Pattern 1: User-Agent contains "kube-probe"**
```regex
/kube-probe/
```

**Pattern 2: HTTP method + health endpoint**
```regex
/(?:GET|HEAD)\s+/(?:healthz|health|readyz|ready|livez|live|ping)(?:\s|\?|"|$)/
```

Examples filtered:
- `"GET /healthz HTTP/1.1"`
- `"HEAD /readyz?param=value HTTP/1.0"`
- `"User-Agent: kube-probe/1.28 ..."`

## User Actions

### 1. Select deployment
**Trigger**: Click a deployment row in the sidebar
**Effect**:
- Cancel any previous stream task
- Clear previous log lines
- Set `selectedDeploymentKey = "namespace/name"`
- Start new kubectl logs stream
- Set error = null
- Sidebar row highlights with accent color

**kubectl**: (as above, initial tail command)

### 2. Filter logs
**Trigger**: Type in the filter text field
**Effect**:
- Regex-free substring search (case-insensitive)
- Re-filter `filteredLines` on each keystroke
- Scroll position preserved
- Does NOT send to server; purely client-side

**kubectl**: None

### 3. Toggle "Hide probes"
**Trigger**: Click heart.slash icon
**Effect**:
- Toggle `hideProbes` boolean
- Re-compute `filteredLines` (apply both probe filter AND text filter)
- If lines are hidden, scroll position may shift
- Does NOT send to server; purely client-side

**kubectl**: None (filtering happens on already-fetched lines)

### 4. Toggle pause/play
**Trigger**: Click pause.fill or play.fill icon
**Effect**:
- Toggle `isPaused` boolean
- When paused: new lines from kubectl are discarded (not appended)
- When resumed: new lines are appended normally
- Display toggles icon to show next action

**kubectl**: None (process continues, lines buffered locally)

### 5. Clear
**Trigger**: Click trash icon
**Effect**:
- `lines.removeAll()`
- All displayed log lines disappear
- Stream continues running

**kubectl**: None

### 6. Pause and scroll up (manual scroll)
**Trigger**: User scrolls up in the log area
**Effect**:
- Track bottom-most visible line ID
- If bottom-most ID != last filteredLine ID, set `stickToBottom = false`
- "Jump to latest" button appears

**kubectl**: None

### 7. Jump to latest
**Trigger**: Click "Jump to latest" button (when visible)
**Effect**:
- Scroll to bottom
- Set `stickToBottom = true`
- Button disappears

**kubectl**: None

### 8. Wrap lines (toggle)
**Trigger**: Click arrow.turn.down.left icon OR press `⌥⌘W`
**Effect**:
- Toggle `wrapLines` boolean
- Each line switches from single-line (truncated) to multi-line (reflowed)

**kubectl**: None

### 9. Ask Claude about a line
**Trigger**: Context menu → "Ask Claude about this line" on a log line
**Effect**:
- Extract the selected LogLine
- Extract 5 lines before + 5 lines after (11 total from `lines` array)
- Hand off to chat panel with these surrounding lines as context
- (Exact chat handoff mechanism defined in contracts.md)

**kubectl**: None

### 10. Close log view (X button)
**Trigger**: Click X button in stream header
**Effect**:
- Call `viewModel.clearSelection()`
- Cancel current kubectl stream task
- Clear `lines`
- Clear `selectedDeploymentKey`
- Return to empty state

**kubectl**: Terminate the running `kubectl logs -f` process

### 11. Panel disappear
**Trigger**: User navigates away from Logs panel
**Effect**:
- Call `viewModel.stop()`
- Cancel current kubectl stream task
- Lines are cleared when panel reappears

**kubectl**: Terminate the running `kubectl logs -f` process

## State Management

### ViewModel state
- `selectedDeploymentKey: string | null` — "namespace/name" of selected deployment
- `lines: [LogLine]` — all lines received (capped at maxLines = 5000)
- `filter: string` — current substring filter
- `hideProbes: bool` — whether to hide kube-probe lines
- `isPaused: bool` — whether to accept new lines
- `error: string | null` — kubectl error message, if any
- `availableDeployments: [Deployment]` — sorted list of deployments in cache
- `selectedDeployment: Deployment | null` — looked up by key
- `filteredLines: [LogLine]` — computed: lines after probe + text filters
- `currentStream: Task | null` — handle to active kubectl process

### Line buffer
- Lines are appended only when `!isPaused`
- If `lines.count > maxLines (5000)`, remove oldest lines to stay within cap
- Each line is assigned a stable `colorIndex` at parse time (immutable)

## Edge Cases

### Empty/error states
- **No deployments in cache**: Sidebar is empty, user sees help text
- **Deployment with no label selector**: Error banner shows "deployment has no spec.selector.matchLabels"
- **kubectl process exits/crashes**: Error banner shows the error message (e.g. "permission denied")
- **All lines filtered out**: Display shows empty log area (no special message)

### Color assignment edge case
- If the same pod name appears across multiple namespaces, they will have the SAME color (hash is per pod name only, not per ns/name pair)
- This is acceptable; the sidebar also uses a separate color hash per deployment (ns/name)

### Sticky scroll edge case
- If the user has scrolled up and paused, and then resumes, new lines appear below but do not auto-scroll
- When the user manually scrolls back to bottom, `stickToBottom` is re-enabled

### Line content edge case
- A single log line from kubectl may be very long (no line-breaking in the message itself)
- UI truncates to one line by default, or wraps if `wrapLines = true`
- Tapping a line toggles expanded state (single vs multi-line)

### Namespace/context handling
- The deployment's namespace is read from its metadata at selection time
- If a context is known (e.g. from cluster manager), it is passed to kubectl via `--context`
- If no context is set, kubectl uses the current context in kubeconfig

## Filtering algorithm

```
filteredLines:
  1. Start with `lines`
  2. If hideProbes: remove lines where LogNoiseFilter.isProbe(line) == true
  3. If filter is non-empty: keep only lines where text.localizedCaseInsensitiveContains(filter)
  4. Return result
```

Both filters are applied; the order does not matter (both are independent predicates).

## Display details

### Timestamp formatting
- Parsed as ISO8601 (with fractional seconds)
- Displayed as `HH:MM:SS` (e.g. "17:15:42")
- Date component omitted (logs are assumed to be recent)

### Line wrap
- Default (wrap = false): single line, truncated with tail ellipsis
- When wrap = true: text reflowed to fill container width
- Expanding a line also shows full text (toggle state, not tied to wrap setting)

### Error highlighting
- Text containing "error", "fatal", or "panic" (case-insensitive) is colored red
- Used for visual scanning of critical messages

### Line height and spacing
- Each line has minimum height of 18pt (accommodates icon + text)
- Vertical padding: 2pt
- Horizontal padding: 8pt
- Monospace font, 11pt

## Scrolling behavior

### Auto-scroll
- When a new line arrives and `!isPaused`:
  - If user is viewing the bottom (last filtered line is visible), scroll new line into view
  - If user has scrolled up, do NOT auto-scroll (stay at user's position)

### Bottom detection
- Track the ID of the bottom-most visible element
- If bottom-most ID == last filteredLine ID, user is "at bottom"
- If bottom-most ID is null (no element visible), treat as at bottom

### Jump button
- Show "Jump to latest" button only when user is NOT at bottom
- Button is positioned at bottom-right with padding
- Clicking scrolls to bottom and re-enables auto-scroll

## Resource subscription

The Logs panel is NOT driven by the watch manager. Instead:
- It uses kubectl's `-f` (follow) flag to stream live lines
- It accesses the deployment list from the cluster cache (for sidebar)
- The sidebar is updated by the existing watch subscription to deployments

For web port: the server will NOT use the watch manager for logs; instead it spawns a separate `kubectl logs` process per log stream and pipes the output via WebSocket.

## Accessibility & keyboard

- `⌥⌘W` shortcut toggles wrap lines
- Context menu available on log lines
- All buttons have help text (tooltip)
- Search field is standard HTML input

