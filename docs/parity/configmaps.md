# ConfigMaps Panel — Normative Behavior Spec

This spec defines the behavior and implementation contract for porting the Swift ConfigMaps panel to web. It is derived from reading `Sources/Helmsman/Panels/ConfigMaps/ConfigMapsPanel.swift`, `ConfigMapsViewModel.swift`, `ConfigMapManageSheet.swift`, `ConfigMapEditorSheet.swift`, and `Sources/Helmsman/Cluster/ConfigMap.swift`.

## Scope: LIST view + expandable detail (read-only; edit/create/delete deferred)

This spec covers ONLY the live configmaps table + expandable detail rows showing data keys and values with no mutations. The following features are DEFERRED (out-of-scope-for-now) and must NOT be attempted without new infra:

- **Edit/Create/Delete mutations** — requires a generic `kubectl apply -f -` server route that does not yet exist (currently only specific mutation routes like scale/restart are wired). The Swift app routes edits through `ConfigMapEditorSheet` → `ConfigMap.toYAML()` → a `.applyConfigMap` action block, which in turn would need server-side YAML apply logic. DO NOT build a button that 422s. Document the action and skip the UI.
- **Copy-to-clipboard** — Swift has in-process pasteboard access; web needs a separate feature spec if desired.
- **View YAML** — requires a server YAML endpoint + viewer UI (already deferred in other panels).

The builder MUST use the EXISTING Phase A infra (configmaps watch + search) and NOT modify the server beyond what is already supported (configmaps watch is pre-built).

## Live Data Source

All configmap data comes from the Zustand store, fed by the WebSocket-based live watch:

- **Subscribe on mount**: Call `subscribe('configmaps', namespace)` where `namespace` is the current namespace filter (default: `'*'` for all namespaces, or a specific namespace name).
- **Read from store**: `useCluster().resources['configmaps']` returns a map of `{ name: ConfigMap }`. ConfigMap type matches the Kubernetes ConfigMap JSON schema.
- **Auto-update**: Store patches come from the server's `WatchManager` via WebSocket (`/ws`). The server already watches configmaps via `kubectl get configmaps --watch -o json`.

## Table Columns (LIST View)

Each column is derived directly from the ConfigMap JSON; columns render in this order:

| Column      | Source JSON Path                 | Format / Display Logic                                                                                              |
|-------------|----------------------------------|---------------------------------------------------------------------------------------------------------------------|
| **Namespace** | `metadata.namespace`            | Monospace, secondary text color (e.g., `#888`). Show "—" if nil (services should always have a namespace).                      |
| **Name**      | `metadata.name`                 | Monospace, primary text color. ConfigMap name (unique within namespace).                                                  |
| **Keys**    | `data` + `binaryData`                     | Integer count of keys. Computed as `(data?.count ?? 0) + (binaryData?.count ?? 0)`. Show "0 key" or "N keys" (plural). |
| **Age**     | `metadata.creationTimestamp`    | Relative age: "5s", "3m", "2h", "1d", etc. Computed using the same relative-time logic as pods/services. Hide if creationTimestamp is nil (though all ConfigMaps should have it).                       |

**Example row**:
```
| doc.plaintext icon | my-config | default | 3 keys | 5m |
```

## Expanded Detail Block (Inline Row)

When a configmap row is expanded (via chevron toggle on the left), an inline detail section is shown below the table row displaying all data keys and their values.

### Detail Layout

#### Summary Section
- **Header**: "STATUS" (styled as uppercase, secondary text)
- **Rows**: Key-value pairs shown in a fixed-width layout:
  - "KEYS": Total key count (from `data` + `binaryData`)
  - "BINARY": Binary key count (only if `binaryData` is non-empty)
  - "AGE": Relative age (same logic as list view)
  - "LABELS": Label pairs (only if `metadata.labels` is non-empty), formatted as `key=value`, comma-separated

#### Keys Section
- **Header**: "KEYS (N)" where N is the total key count
- **Empty**: If `keyCount == 0`, show "No data keys" in tertiary text
- **List**: One card per key (sorted alphabetically by key name), showing:
  - **Icon**: 
    - Plaintext key: a dotted circle icon
    - Binary key: a zipper icon (indicating compressed/binary)
  - **Key name**: Monospace, primary text, selectable
  - **Size badge**: Formatted as `NB` (bytes), monospace, secondary text
    - For plaintext keys: count UTF-8 bytes of the value (e.g., `"hello"` = 5B)
    - For binary keys: decode the base64 value to get raw byte count (e.g., `100B`)
  - **Copy button** (plaintext keys only): 
    - Label: "copy" or "copied" (when recently clicked)
    - Icon: `doc.on.doc` or `checkmark` (after click)
    - Color: secondary when ready, status-success when copied
    - Clicking copies the plaintext value to the clipboard (DEFERRED on web; do NOT add the button yet)
  - **Value block** (plaintext keys only):
    - Rendered in a monospace code block below the key row
    - Max height ~200px with scrollbar if value is very long (e.g., multi-line config files)
    - Tertiary text color, selectable
    - Padding 8px, border subtle, rounded corners
  - **Binary indicator** (binary keys only):
    - Rendered as a disabled/info block: `<binary, NB bytes>` where N is the decoded byte count
    - Monospace, tertiary text, no scrolling (just text)
    - Padding 8px, rounded corners, no border

**Example expanded view**:
```
STATUS
KEYS    3
AGE     2h
LABELS  env=production, app=api

KEYS (3)
• config.yaml (1.2KB) [copy]
  ```
  server:
    port: 8080
    debug: false
  ```
• app.env (145B) [copy]
  ```
  DATABASE_URL=postgres://...
  API_KEY=secret123
  ```
• certs.pem (<binary, 2048 bytes>)
```

## Filtering & Search

### Namespace Scoping
- The panel reads the namespace filter from the store (set by a namespace selector elsewhere in the app).
- If namespace filter is `nil`, show configmaps from ALL namespaces (subscribe with `'*'`).
- If namespace filter is "default" (or any namespace), show only configmaps in that namespace.
- The store already receives only the configmaps in the subscribed namespace (server-side filtering in `WatchManager.subscribe()`).

### Search
- Client-side substring search (case-insensitive) across:
  - ConfigMap name (`metadata.name`)
  - Namespace (`metadata.namespace`)
  - Data keys (each key in `data` or `binaryData`)
- Return true if ANY field contains the search query.
- Update filtered list in real time as the user types.
- Swift ref: `ConfigMapsViewModel.filteredConfigMaps` uses `cache.filtered(…, matches: { c, q in c.keysSorted.contains { $0.localizedCaseInsensitiveContains(q) } })`.

### Count Chip
- Show total configmap count. If a search is active and results differ, show `<filtered> / <total>`.
- Example: "8" if all shown; "3 / 8" if search narrows the list.

## Empty / Loading / Error States

### Loading
- Show a small progress spinner in the header (next to the count chip) while `isLoading === true`.
- The store's `isLoading` flag is set by the server on first snapshot (before any configmaps arrive).

### Error
- If `error` is non-null, render a red error banner above the table.
- Text: the error message from the server (e.g., "kubectl failed: permission denied").
- Font: monospace, small, red background.

### Empty
- If no configmaps exist (after filtering/search), the table body is empty but the header and search still render.
- Display: "No configmaps found" or similar message in the table area (no specific example in Swift, so use common pattern).

## Row Actions: NONE (Read-Only) + DEFERRED BUTTONS

The Swift panel has the following actions in the manage sheet, which are DEFERRED for web:

- **Edit button** — opens `ConfigMapEditorSheet` (form with name, namespace, data key/value pairs). Deferred: need generic `kubectl apply -f -` server route.
- **Delete button** — submits a `deleteResource` action block. Deferred: need ConfirmSheet wiring for mutations.
- **View YAML button** — shows the raw YAML representation (via `ConfigMap.toYAML()` using Yams). Deferred: need server YAML viewer.

DO NOT add Edit/Delete/View YAML buttons to the web panel; these require infrastructure that is not yet in place.

## Input Restrictions & Validation (For Future Mutations)

When edit/create mutations ARE implemented (later, with new infra), these rules apply (from `ConfigMapEditorSheet`):

- **Name field**: Required, non-empty after trimming whitespace.
- **Namespace field**: Required, non-empty. Defaults to "default" for new configmaps. Read-only on edit.
- **Data rows**: Key and value pairs. Keys must be non-empty and unique (no duplicates after trimming). Values can be empty. Values support multi-line text (e.g., whole YAML files).
- **Binary data**: Preserved unchanged during edit (editor only touches plaintext `data`). When serializing, include `binaryData` field if present (via `ConfigMap.draft()` and `toYAML()`).
- **Labels**: Editable (from `metadata.labels`), but NOT shown in the read-only list view; only visible in the manage sheet's STATUS section.

This is documented for future implementation; the web build is read-only and skips the editor UI entirely.

## kubectl Commands

All data is read-only and comes from the watch stream. No mutations are attempted on web. For reference (future mutations):

- **List**: `kubectl get configmaps [-n <namespace>] --watch -o json` (server-side; web reads from store)
- **Get single**: `kubectl get configmap <name> [-n <namespace>] -o json`
- **Create/Edit** (future): `kubectl apply -f -` with the YAML produced by `ConfigMap.toYAML()` (requires new server route)
- **Delete** (future): `kubectl delete configmap <name> [-n <namespace>]` (requires ConfirmSheet + server route)

## Data Derivation & Computed Properties

### Key Count
```
keyCount = (configMap.data?.count ?? 0) + (configMap.binaryData?.count ?? 0)
```

### Keys Sorted
All keys across `data` and `binaryData`, sorted alphabetically for stable display:
```
keysSorted = Set((data ?? [:]).keys).union((binaryData ?? [:]).keys).sorted()
```

### Binary Byte Count
For a key in `binaryData`, decode the base64 value to get raw bytes:
```
binaryBytes(key) = Data(base64Encoded: binaryData[key])?.count ?? 0
```

### Relative Age
From `metadata.creationTimestamp`:
```
if (now - created) < 60s: "Xs" (seconds)
if (now - created) < 3600s: "Xm" (minutes)
if (now - created) < 86400s: "Xh" (hours)
else: "Xd" (days)
```

## Resource Watches

The panel subscribes to ONE resource kind:

- **`configmaps`** — live ConfigMap objects. Subscription scope depends on `namespaceFilter`:
  - If `nil`: subscribe to `'*'` (all namespaces)
  - If set: subscribe to that namespace name (e.g., `'default'`)

No other resource kinds are watched (unlike Pods panel which also watches Events for logs).

## Summary of Implementation Checklist

- [x] Read from `resources['configmaps']` via Zustand store
- [x] Subscribe to `'configmaps'` watch on mount
- [x] Render list table with Namespace, Name, Keys count, Age columns
- [x] Sort by name (optionally group by namespace, but NOT for single-namespace views)
- [x] Expandable rows showing all data keys + values in detail section
- [x] Search across name, namespace, and key names
- [x] Count chip with filtered count display
- [x] Loading spinner, error banner, empty state
- [x] Binary key display as `<binary, NB bytes>` without decoding
- [x] Plaintext key display with scrollable value blocks
- [x] Relative age calculation
- [ ] Edit/Create/Delete buttons (DEFERRED — requires new server infra)
- [ ] Copy-to-clipboard for plaintext values (DEFERRED — requires web impl)
- [ ] View YAML button (DEFERRED — requires server YAML viewer)
