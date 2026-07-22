# Browser-style navigation history in the top header

## Goal

Replace the Rigel logo in the top header (`GlobalHeader`) with **Back** and
**Forward** arrows that walk a browser-style history stack. Each stack entry
captures the user's full location — panel, cluster, namespace, and focused
resource — so stepping back returns the user exactly where they were, even
across cluster and namespace switches.

## Background

- The app uses **React Router v7** (`<BrowserRouter>`). "Which panel you are on"
  is the URL pathname; there is one route per panel in `App.tsx`.
- **Cluster context** (`activeContext`) and **namespace** (`namespaceFilter`)
  live in the Zustand `useCluster` store (`store/cluster.ts`) and do NOT create
  router history entries — switching cluster or namespace mutates the store.
- Cluster switches go through `switchCluster(context)` in `lib/ws.ts` (releases
  old watches, clears cache, adopts the per-context namespace, resubscribes).
  It is a synchronous store update and a no-op when already on `context`.
- Cross-resource navigation uses `goToResource` / `goToLogs` in
  `lib/resourceNav.ts`, which call `navigate(route)` and
  `setFocusRequest({route, kind, key})`; destination panels consume
  `focusRequest` to scroll/highlight the target row.

Because plain DOM history cannot report whether forward/back entries exist, and
because we must also restore cluster + namespace (which are not in router
history), we maintain our own stack rather than calling `navigate(-1)`.

## Data model

```ts
interface NavEntry {
  path: string;                 // route pathname, e.g. "/pods"
  context: string | null;       // active kubeconfig context
  namespace: string | null;     // namespace filter, null = all
  focus: FocusRequest | null;   // pending focus-row request to replay, if any
}
```

`FocusRequest` is the existing type from `store/cluster.ts`
(`{ route; kind; key; search? }`).

A **signature** is the comparable identity of a location:
`path` + `context` + `namespace`. `focus` is carried but NOT part of the
signature (it is a replay hint, not an identity).

## Component 1 — `store/navHistory.ts` (pure Zustand store)

Single-purpose, no router or cluster dependencies, fully unit-testable.

State:

- `entries: NavEntry[]` — the stack (starts empty).
- `index: number` — pointer to the current entry (`-1` when empty).
- `pendingTarget: string | null` — signature the recorder is waiting to settle
  on during a programmatic step (`null` in the steady state).

Actions:

- `push(entry: NavEntry): void`
  - If `pendingTarget` is set: if `signature(entry) === pendingTarget`, clear
    `pendingTarget` and return (the programmatic step has settled — do not
    record it as new history). Otherwise return without recording (still
    mid-transition; ignore intermediate signatures).
  - If `index >= 0` and `signature(entry) === signature(entries[index])`,
    return (dedupe: same location, e.g. re-clicking the current panel).
  - Otherwise truncate `entries` to `index + 1` (drop any forward history —
    the user branched off), append `entry`, set `index = entries.length - 1`.

- `stepBack(): NavEntry | null`
  - If `index <= 0` return `null`. Else `index -= 1`, set
    `pendingTarget = signature(entries[index])`, return `entries[index]`.

- `stepForward(): NavEntry | null`
  - If `index >= entries.length - 1` return `null`. Else `index += 1`, set
    `pendingTarget = signature(entries[index])`, return `entries[index]`.

- `canGoBack(): boolean` = `index > 0`.
- `canGoForward(): boolean` = `index < entries.length - 1`.

The stack is in-memory only — not persisted across app restarts (browser
history is per-session).

## Component 2 — `shell/useNavHistory.ts` (wiring hook)

Bridges the pure store to the router and the cluster store. Called once, from
`GlobalHeader` (always mounted at the top of the app).

- **Recording effect:** reads `useLocation().pathname`, and `activeContext` +
  `namespaceFilter` from `useCluster`. On any change, calls
  `navHistory.push({ path, context, namespace, focus: useCluster.getState().focusRequest })`.
  The `push` guard (`pendingTarget` / dedupe) decides whether it actually
  records. `focus` is read at record time so a resource-link navigation carries
  its focus request.

- **`applyEntry(entry)`** — restores a location in one batched handler (all
  synchronous store writes, so React batches them into a single settle that
  matches `pendingTarget`):
  1. If `entry.context` and `entry.context !== activeContext`:
     `switchCluster(entry.context)`.
  2. If `entry.namespace !== namespaceFilter`:
     `setNamespaceFilter(entry.namespace)` (runs after the switch so it
     overrides the per-context namespace `switchCluster` adopts).
  3. `navigate(entry.path)`.
  4. If `entry.focus`: `setFocusRequest(entry.focus)`.

- Returns `{ canGoBack, canGoForward, goBack, goForward }` where
  `goBack = () => { const e = stepBack(); if (e) applyEntry(e); }` and likewise
  for `goForward`.

- **Keyboard shortcuts:** a global `keydown` listener (registered in an effect,
  cleaned up on unmount) invokes `goBack` / `goForward`:
  - `Cmd/Ctrl + [` → back, `Cmd/Ctrl + ]` → forward (browser convention).
  - `Cmd/Ctrl + ArrowLeft` → back, `Cmd/Ctrl + ArrowRight` → forward.
  - Ignore the event when the focus target is a text input, textarea, or
    `contentEditable` element (do not steal keys from the chat box, YAML
    editor, or search field). `preventDefault` when we handle it.
  - `goBack`/`goForward` are already no-ops at the ends, so no extra guarding.

## Component 3 — `shell/GlobalHeader.tsx`

- Remove the `RigelMark` block and its import. No Rigel branding remains in the
  top bar (per the request — arrows only, no logo).
- In its place render two icon buttons, left-to-right: Back (`faArrowLeft`) then
  Forward (`faArrowRight`), matching the existing header icon-button styling
  (Font Awesome Pro, `var(--fg-*)` colors, `NO_DRAG` style so they remain
  clickable in the Electron draggable titlebar).
- Wire them from `useNavHistory()`: `onClick` → `goBack` / `goForward`; each
  button `disabled` (greyed, non-interactive) when its `canGo*` is false.

## Testing

- **Unit (vitest, `store/navHistory.ts`):**
  - push appends; `index` advances.
  - dedupe: pushing the current signature is a no-op.
  - branch: pushing after `stepBack` truncates forward history.
  - `stepBack` / `stepForward` move `index` and set `pendingTarget`; return
    `null` at the ends.
  - `pendingTarget` guard: a `push` matching `pendingTarget` clears it and does
    NOT record; a non-matching push while `pendingTarget` is set is ignored.
  - `canGoBack` / `canGoForward` at the boundaries.

- **Verification:** `pnpm --filter web typecheck`, `pnpm --filter web test`,
  `pnpm --filter web build`. Live check via `pnpm --filter desktop dev` only if
  requested.

## Out of scope (YAGNI)

- Persistence across restarts.
- A dropdown/long-press list of history entries.
