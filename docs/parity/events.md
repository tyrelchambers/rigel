# Events Panel — Normative Behavior Spec

This spec defines the behavior and implementation contract for porting the Swift Events panel to web. It is derived from reading `Sources/Helmsman/Panels/Events/EventsPanel.swift`, `EventsViewModel.swift`, and the K8sEvent model in `Sources/Helmsman/Cluster/KubeTypes.swift`.

## Scope: LIST view only (read-only, non-expandable)

This spec covers ONLY the live events table with type filtering, search, and timeline visualization. This is a read-only, presentation-only panel. The following features are NOT included:

- **Mutations** — events are read-only; no edit/delete/create.
- **Ask Claude handoff** — deferred (separate handoff spec).
- **Timeline visualization** — shows event bucketing (1h span, 60 buckets), but NOT interactive (no drilldown from timeline).
- **Event retention** — Kubernetes retains events for ~1h by default. The web panel displays the live watch; no client-side persistence of older events is required or performed.

The builder MUST use the EXISTING Phase A infra (events watch + search) and NOT modify the server beyond what is already supported (events watch is pre-built).

## Live Data Source

All event data comes from the Zustand store, fed by the WebSocket-based live watch:

- **Subscribe on mount**: Call `subscribe('events', namespace)` where `namespace` is the current namespace filter (default: `'*'` for all namespaces, or a specific namespace name).
- **Read from store**: `useCluster().resources['events']` returns a map of `{ uid: K8sEvent }`. Event type matches the Kubernetes Event JSON schema (see `Sources/Helmsman/Cluster/KubeTypes.swift`).
- **Auto-update**: Store patches come from the server's `WatchManager` via WebSocket (`/ws`). The server already watches events via `kubectl get events --watch -o json --all-namespaces`.
- **K8s event retention**: Kubernetes by default retains events for approximately 1 hour. Events outside this window are automatically removed from the cluster; the panel displays whatever the live watch returns (no client-side long-term storage needed).

## Table Columns (LIST view)

Each column is derived directly from the Event JSON; columns render in this order:

| Column           | Source JSON Path                          | Format / Display Logic                                                                                              |
|------------------|-------------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| **Age**          | `lastTimestamp` > `firstTimestamp` > `metadata.creationTimestamp` | Relative age: "5s", "3m", "2h", "1d", etc. Mirrors `K8sEvent.relativeAge(now:)` from Swift. Tooltip on hover shows absolute timestamp (e.g., "Jun 1, 2026 at 8:14:02 AM"). Use `metadata.creationTimestamp` as fallback if both timestamps missing. Pass `now` parameter to helper for test determinism. Show "—" if no usable timestamp. |
| **Count**        | `count`                                   | Integer (optional field). If `count > 1`, show as "×\(count)" in smaller, muted text below the age. If `count` is nil or 1, show nothing (omit the row). |
| **Type**         | `type`                                    | Badge: "WARNING" or "NORMAL". Warning → red badge (Theme.Status.failed / destructive color), Normal → green badge (Theme.Status.running / success color). Text: uppercase, monospace, semibold. Show "—" if nil. |
| **Reason**       | `reason`                                  | Monospace, primary text. Single-line, truncate with ellipsis. Width ~140px. Show "—" if nil. Examples: "FailedScheduling", "BackOff", "Started", "Killed". |
| **Involved Object** | `involvedObject.{kind, name, namespace}` | Two-line format: line 1 = "kind/name" or "kind/name · namespace" (secondary text, single-line, truncate middle), line 2 = message (primary text, single-line, expandable to multi-line on click). Example: "Pod/web-5f4c8 · default". Show "—" if object name is empty. |
| **Message**      | `message`                                 | Monospace, primary text. Single-line by default, truncate with ellipsis. On click/tap, toggle expansion to show full message (multi-line). Show "—" if nil. Text-selectable. |

### Type Color Scheme

- **Warning** (`type === "Warning"`): Red/destructive color (matches Swift `Theme.Status.failed`). RGB-based equivalent in Tailwind: `text-red-600 bg-red-600/15` or `text-destructive bg-destructive/10`.
- **Normal** (`type === "Normal"`): Green/success color (matches Swift `Theme.Status.running`). RGB-based equivalent: `text-green-600 bg-green-600/15` or `text-green bg-green/15`.

### Age & Count Layout

The Age column contains two stacked lines:
1. Relative age (top, tertiary text color).
2. Count (bottom, "×{count}", semibold, status-pending color) — ONLY if `count > 1`.

Height: fixed at ~70px to accommodate both lines. Example:
```
5m
×3
```

### Involved Object Formatting

Format: `{kind}/{name}` or `{kind}/{name} · {namespace}` (if namespace is present and differs from filter).
- If `involvedObject.name` is empty, show "—".
- If showing namespace, use a subtle separator (·).
- Truncate in the middle (preserve kind and name over namespace).
- Secondary text color, monospace.

Example:
- `Pod/web-5f4c8 · default`
- `Deployment/api`
- `Node/worker-1 · ""` (cross-namespace reference, namespace shown even if watching single namespace)

## Filter Bar (Type Filter)

Directly below the header, show three filter pills:

- **"All"** — show all events (default initial state in Swift is `.warning`; spec says to filter by warning initially per `typeFilter: EventTypeFilter = .warning`).
- **"Warning"** — show only events with `type === "Warning"`.
- **"Normal"** — show only events with `type === "Normal"` or `type === null` (neutral/missing).

**Filter Logic**:
```
if typeFilter === "All": return true
if typeFilter === "Warning": return event.isWarning (i.e., event.type === "Warning")
if typeFilter === "Normal": return event.type === "Normal"
```

**Pill Styling** (mirrors Swift `FilterPill`):
- Active pill: background = filter color (warning → red, normal → green, all → secondary), text = inverse (white/light).
- Inactive pill: background = muted/sunken, text = secondary, border = subtle outline.
- Font: monospace, small (10px), medium weight.
- Padding: horizontal 8px, vertical 3px.
- Border radius: small (4–6px).

## Timeline Ribbon

Directly below the filter bar, show a 1-hour event timeline:

- **Span**: 3600 seconds (1 hour).
- **Buckets**: 60 equal-width slots (60 seconds per bucket).
- **Bucketing algorithm**: `eventBuckets(events, now: Date(), span: 3600, count: 60)` from Swift (see `Sources/Helmsman/Charts/Aggregations.swift`):
  - Partition events into 60 time slots spanning `[now - 3600, now]`.
  - For each event, use `event.lastTimestamp ?? event.firstTimestamp ?? event.metadata.creationTimestamp` as the sort key.
  - Drop events without a usable timestamp or outside the window.
  - Track warning count and normal count per bucket.
- **Visual**: Stacked bar chart or miniature histogram (each bucket shows height proportional to event count, with warning events in red stacked below normal events in green).
- **Interactivity**: Display-only; no drilldown (deferred).
- **Refresh**: Bucket values recompute whenever events change or as time progresses (every render).

**Swift reference**: `EventTimeline` view in `Sources/Helmsman/Panels/Events/EventsPanel.swift`, invoked with `Viz.eventBuckets(viewModel.cache.events, now: Date(), span: 3600, count: 60)`.

## Filtering & Search

### Namespace Scoping
- The panel reads the namespace filter from the ClusterCache (set by a namespace selector elsewhere in the app).
- If `cache.namespaceFilter == nil`, show events from ALL namespaces (subscribe with `'*'`).
- If `cache.namespaceFilter == "default"` (or any namespace), show only events in that namespace (filter `involvedObject.namespace`).
- The store may receive all-namespace events; filter client-side by comparing `involvedObject.namespace` to the active namespace filter.

### Search
- Client-side substring search (case-insensitive) across:
  - `reason`
  - `message`
  - `involvedObject.name`
- Return true if ANY field contains the search query.
- Update filtered list in real time as the user types.
- Empty query matches everything.
- **Swift ref**: `EventsViewModel.filteredEvents` filtering with `localizedCaseInsensitiveContains()`.

### Count Chip
- Show total filtered event count in the header (after applying type filter + namespace scope + search).
- Example: "47" if 47 events pass all filters.

## Sort Order

- **Primary sort**: Most recent first, by `lastTimestamp` (fall back to `firstTimestamp`, then `metadata.creationTimestamp`).
- **Algorithm**: 
  ```
  sortKey = event.lastTimestamp ?? event.firstTimestamp ?? event.metadata.creationTimestamp
  events.sort { (a, b) => (b.sortKey ?? Date.distantPast) > (a.sortKey ?? Date.distantPast) }
  ```
- **Swift ref**: `ClusterCache.applyEvent()` keeps events sorted with `events.sort { ($0.when ?? .distantPast) > ($1.when ?? .distantPast) }`.
- This mirrors the Swift app's in-memory list, which is already sorted by the server.

## Empty / Loading / Error States

### Loading
- Show a small progress spinner in the header (next to the event count) while `cache.isLoading === true`.
- The store's `isLoading` flag is set by the server on first snapshot (before any events arrive).

### Error
- If `cache.error` is non-null, render a red error banner above the table.
- Text: the error message from the server (e.g., "kubectl failed: connection refused").
- Font: monospace, small, red background.
- Display position: below filter bar, above list.

### Empty
- If no events exist after filtering/search, the table body is empty but the header, filter bar, and timeline still render.
- Display: "No events found" text in the list area, or omit rows and show an empty table body.

## Row Actions: NONE (Read-Only)

The Swift panel has a "Ask Claude about this event" context menu action, which is DEFERRED for web:

- **Ask Claude** — DEFERRED (separate handoff spec, requires event diagnostics context builder).

Events are display-only; no edit, delete, or create mutations.

## Probe-Noise Filtering

The Swift app applies NO special filtering of "probe" events (e.g., liveness/readiness probe failures). These are shown in the event list. If future filtering is desired, it should be a separate feature (e.g., a "Hide probe noise" toggle).

## Data Derivation & Computed Properties

### `K8sEvent` Type Definition

```typescript
interface K8sEvent {
  metadata: ObjectMeta;
  type: string | null;           // "Normal" | "Warning" | null
  reason: string | null;
  message: string | null;
  count: number | null;
  firstTimestamp: string | null;  // ISO 8601
  lastTimestamp: string | null;   // ISO 8601
  involvedObject: {
    kind: string | null;
    name: string | null;
    namespace: string | null;
    uid: string | null;
  } | null;
}
```

### `isWarning` (computed)
```typescript
const isWarning = event.type === "Warning"
```

### `when` (best timestamp, computed)
```typescript
const when = event.lastTimestamp ?? event.firstTimestamp ?? event.metadata.creationTimestamp
```

### `relativeAge(now: number)` (computed)
Returns a relative time string:
```typescript
function relativeAge(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const dt = (now - then) / 1000; // seconds
  if (dt < 0) return "0s";
  if (dt < 60) return `${Math.floor(dt)}s`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h`;
  return `${Math.floor(dt / 86400)}d`;
}
```
**Pass `now` as a parameter for test determinism** (defaults to `Date.now()` in production).

### `absoluteWhen` (computed, for tooltip)
Returns a formatted absolute timestamp string, e.g., "Jun 1, 2026 at 8:14:02 AM":
```typescript
function absoluteWhen(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium" });
}
```

## Webhook / Server Contract

The `subscribe('events', namespace)` call triggers the server to watch events:

```bash
kubectl get events -o json --watch -A  (if namespace === '*')
# OR
kubectl get events -o json --watch -n <namespace>  (if namespace is specific)
```

The server streams `WatchEvent<K8sEvent>` objects via WebSocket. The client processes:
- **ADDED** events: append or update in the store.
- **MODIFIED** events: update existing entry by UID.
- **DELETED** events: remove from store.

Events are keyed by `metadata.uid` in the store, not by `name`. The store is automatically maintained by the client's watch handler.

## Initial Filter State

Per the Swift app's `EventsViewModel` init, the initial `typeFilter` is `.warning`. The web panel should:
- Start with the "Warning" filter active (only show events with `type === "Warning"`).
- Allow the user to toggle to "All" or "Normal" at any time.

(Note: An earlier read showed `typeFilter: EventTypeFilter = .warning` in the Swift ViewModel, indicating Warning is the default active filter, not "All".)

## Display Defaults

- **Type filter**: "Warning" (initially active).
- **Search**: empty.
- **Namespace scope**: respect the global ClusterCache namespace filter.
- **Sort**: newest first (by `lastTimestamp` > `firstTimestamp` > `creationTimestamp`).
- **Timeline span**: 1 hour (3600s), 60 buckets.

## No Client-Side Event Persistence

Unlike pods or services, events are ephemeral (1h TTL in Kubernetes). The web panel does NOT:
- Cache events to localStorage.
- Keep a long-term history.
- Paginate or virtualize old events.

The panel displays the live snapshot from the watch (up to ~1h of events). No server-side persistence is required beyond the live watch.

## Test Determinism

All time-dependent helpers (`relativeAge`, `absoluteWhen`, event bucketing) accept a `now` parameter (or `now: number` for epoch milliseconds) to allow unit tests to control time. This mirrors the Swift pattern of `func relativeAge(now: Date = Date())`.

Example test:
```typescript
const now = new Date("2026-06-09T15:00:00Z").getTime();
const event = { lastTimestamp: "2026-06-09T14:55:00Z" };
expect(relativeAge(event.lastTimestamp, now)).toBe("5m");
```

## Key kubectl Commands (References)

- **Watch all events**: `kubectl get events -o json --watch -A`
- **Watch events in a namespace**: `kubectl get events -o json --watch -n <namespace>`
- **Watch events for a specific resource**: `kubectl describe <kind> <name> -n <namespace>` (shows events in the describe output, not used here; the panel uses the generic events watch)

## Implementation Checklist

1. **Type definition**: Add `K8sEvent` type to `packages/k8s` (mirrors Swift model).
2. **Panel UI**: Create `apps/web/src/panels/events/EventsPanel.tsx` with:
   - Header (title, count, search, loading spinner, error banner).
   - Filter bar (All/Warning/Normal pills).
   - Timeline ribbon (1h, 60 buckets, stacked bar visualization).
   - Table/list rows (columns as defined above).
   - Empty state when no events.
3. **Display helpers**: Create `apps/web/src/panels/events/eventsDisplay.ts` with:
   - `relativeAge(iso: string, now?: number): string`
   - `absoluteWhen(iso: string): string | null`
   - `typeColorClass(type: string): string`
   - `matchesSearch(event: K8sEvent, query: string): boolean`
   - `sortEvents(events: K8sEvent[]): K8sEvent[]`
   - `eventBuckets(events: K8sEvent[], now: number, span: number, count: number): EventBucket[]`
4. **Tests**: Vitest suite covering:
   - `relativeAge` with edge cases (missing timestamps, future dates, zero time).
   - `typeColorClass` returns correct Tailwind classes.
   - `matchesSearch` substring matching across fields.
   - `eventBuckets` time partitioning (edge events, out-of-window events).
   - `sortEvents` by recency.
5. **Registration**: Add 'events' to `PANELS` in `App.tsx` and route `/events` to `EventsPanel`.
6. **Store integration**: Ensure `subscribe('events', ns)` is called on mount; read from `resources['events']`.
7. **Build & type check**: `pnpm --filter web typecheck && build && test`.
8. **Server test**: Ensure `pnpm --filter @helmsman/server test` passes (events watch is pre-existing).

