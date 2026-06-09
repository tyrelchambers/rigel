# Secrets Panel — Normative Behavior Spec

This spec defines the behavior and implementation contract for porting the Swift Secrets panel to web. It is derived from reading `Sources/Helmsman/Panels/Secrets/SecretsPanel.swift`, `SecretsViewModel.swift`, `SecretManageSheet.swift`, `SecretEditorSheet.swift`, and `Sources/Helmsman/Cluster/Secret.swift`.

## Scope: LIST view + expandable detail with read-only value reveal (mutations deferred)

This spec covers ONLY the live secrets table + expandable detail rows showing data keys and values with a per-key **reveal toggle** (values hidden by default, decoded on explicit user action). The following features are DEFERRED (out-of-scope-for-now) and must NOT be attempted without new infra:

- **Edit/Create mutations** — requires a generic `kubectl apply -f -` server route that does not yet exist. The Swift app routes edits through `SecretEditorSheet` → `Secret.toYAML()` → an action block, which would need server-side YAML apply logic. DO NOT build a button that 422s. Document the action and skip the UI.
- **Delete mutation** — requires ConfirmSheet wiring + `deleteResource` action block. Deferred; do NOT add a delete button.
- **Move namespace mutation** — requires a copy-and-delete flow with destination picker. Deferred; do NOT add a move button.
- **Copy-to-clipboard** — Swift has in-process pasteboard access; web needs a separate feature spec if desired.
- **View YAML** — requires a server YAML endpoint + viewer UI.

The builder MUST use the EXISTING Phase A infra (secrets watch + search) and NOT modify the server beyond what is already supported (secrets watch is pre-built via `kubectl get secrets --watch -o json`).

## Live Data Source

All secret data comes from the Zustand store, fed by the WebSocket-based live watch:

- **Subscribe on mount**: Call `subscribe('secrets', namespace)` where `namespace` is the current namespace filter (default: `'*'` for all namespaces, or a specific namespace name).
- **Read from store**: `useCluster().resources['secrets']` returns a map of `{ name: Secret }`. Secret type matches the Kubernetes Secret JSON schema.
- **Auto-update**: Store patches come from the server's `WatchManager` via WebSocket (`/ws`). The server already watches secrets via `kubectl get secrets --watch -o json`.

## Table Columns (LIST View)

Each column is derived directly from the Secret JSON; columns render in this order:

| Column      | Source JSON Path                 | Format / Display Logic                                                                                              |
|-------------|----------------------------------|---------------------------------------------------------------------------------------------------------------------|
| **Icon**      | (visual indicator)              | Key icon (system symbol `key.fill`) in accent color, constant width 12px.                                           |
| **Name**      | `metadata.name`                 | Monospace, primary text color. Secret name (unique within namespace).                                                  |
| **Namespace** | `metadata.namespace`            | Monospace badge, secondary text color (e.g., `#888`). Show "—" if nil. Background: subtle/sunken surface.                      |
| **Type**      | `type` (string, e.g., "Opaque") | Display name via `SecretType.displayName` (e.g., "Opaque", "Docker registry", "TLS", "Basic auth", "SSH auth", "Service-account token", "Other"). Accent color, small badge with dim background. Tooltip shows raw type string (e.g., "kubernetes.io/dockerconfigjson").                       |
| **Keys**      | `data` (map of strings)         | Integer count of keys (keys only, NOT values). Show "0 keys" or "N keys" (plural). Data values are always base64-encoded in the watch stream.           |
| **Age**       | `metadata.creationTimestamp`    | Relative age: "5s", "3m", "2h", "1d", etc. Computed using the same relative-time logic as pods/services. Hide if creationTimestamp is nil (though all Secrets should have it). Right-aligned, min-width 32px.                       |

**Example row**:
```
🔑  my-registry-secret   default   Docker registry   1 key   2d
```

**Kubernetes Secret Types (for display)**:
- `Opaque` → "Opaque" (default, user-supplied key/value pairs)
- `kubernetes.io/dockerconfigjson` → "Docker registry"
- `kubernetes.io/tls` → "TLS"
- `kubernetes.io/basic-auth` → "Basic auth"
- `kubernetes.io/ssh-auth` → "SSH auth"
- `kubernetes.io/service-account-token` → "Service-account token"
- Any other type → "Other"

## Expanded Detail Block (Inline Row)

When a secret row is expanded (via chevron toggle on the left), an inline detail section is shown below the table row displaying all data keys and their values with a **per-key reveal toggle**.

### Detail Layout

#### Summary Section
- **Header**: "STATUS" (styled as uppercase, secondary text)
- **Rows**: Key-value pairs shown in a fixed-width layout:
  - "TYPE": Display name of the secret type (from `SecretType.displayName`)
  - "RAW TYPE": Raw `type` field value (e.g., "kubernetes.io/dockerconfigjson"), or "Opaque" if absent
  - "KEYS": Total key count (from `data`)
  - "AGE": Relative age (same logic as list view)
  - "LABELS": Label pairs (only if `metadata.labels` is non-empty), formatted as `key=value`, comma-separated

#### Keys Section
- **Header**: "KEYS (N)" where N is the total key count
- **Empty**: If `keyCount == 0`, show "No data keys" in tertiary text
- **List**: One card per key (sorted alphabetically by key name), showing:
  - **Key name**: Monospace, primary text, selectable (top-left)
  - **Size badge**: Formatted as `NB` (bytes), monospace, secondary text (top-right)
    - Compute from base64-decoded byte count (mirrors Swift `secret.rawBytes(key)?.count ?? 0`)
  - **Reveal/Hide toggle button** (conditional):
    - When revealed: Show decoded UTF-8 value in a monospace code block below the key row
    - When hidden: Show `••••••••` (mask placeholder) with a "Reveal" button
    - Label: "Reveal" (hidden) or "Hide" (revealed)
    - Icon: eye.slash or eye
    - Color: secondary when ready
    - Clicking toggles local reveal state for this key only (no server round-trip)
  - **Value block** (when revealed):
    - If the key decodes to valid UTF-8: Render decoded text in a monospace code block
    - If the key is binary (fails UTF-8 decode): Render `<binary, NB bytes>` in monospace (do NOT show masked bytes, already shown as non-decodable)
    - Max height ~200px with scrollbar if value is very long
    - Tertiary text color, selectable, padding 8px, border subtle, rounded corners

**Example expanded view**:
```
STATUS
TYPE    Docker registry
RAW TYPE  kubernetes.io/dockerconfigjson
KEYS    1
AGE     3h

KEYS (1)
🔘  .dockerconfigjson (512B)
  [Reveal]
  (masked)
```

After clicking Reveal:
```
🔘  .dockerconfigjson (512B)
  [Hide]
  {
    "auths": {
      "docker.io": {
        "username": "myuser",
        "password": "mypass123",
        "email": "user@example.com"
      }
    }
  }
```

For a binary/non-UTF-8 key:
```
🔘  tls.key (1024B)
  [Reveal]
  (masked)

After Reveal:
🔘  tls.key (1024B)
  [Hide]
  <binary, 1024 bytes>
```

## Filtering & Search

### Namespace Scoping
- The panel reads the namespace filter from the store (set by a namespace selector elsewhere in the app).
- If namespace filter is `nil`, show secrets from ALL namespaces (subscribe with `'*'`).
- If namespace filter is "default" (or any namespace), show only secrets in that namespace.
- The store already receives only the secrets in the subscribed namespace (server-side filtering in `WatchManager.subscribe()`).

### Search
- Client-side substring search (case-insensitive) across:
  - Secret name (`metadata.name`)
  - Namespace (`metadata.namespace`)
  - Secret type (`type` field)
  - Data keys (each key in `data`)
- **Search DOES NOT match against decoded values** — values are hidden by default and search should never expose sensitive content. Only search against the non-sensitive name/namespace/type/key metadata.
- Return true if ANY of these non-sensitive fields contains the search query.
- Update filtered list in real time as the user types.
- Swift ref: `SecretsViewModel.filteredSecrets` uses `cache.filtered(…, matches: { s, q in (s.type ?? "").localizedCaseInsensitiveContains(q) })`. The web impl should extend this to include key names as well.

### Count Chip
- Show total secret count. If a search is active and results differ, show `<filtered> / <total>`.
- Example: "12" if all shown; "3 / 12" if search narrows the list.

## Empty / Loading / Error States

### Loading
- Show a small progress spinner in the header (next to the count chip) while `isLoading === true`.
- The store's `isLoading` flag is set by the server on first snapshot (before any secrets arrive).

### Error
- If `error` is non-null, render a red error banner above the table.
- Text: the error message from the server (e.g., "kubectl failed: permission denied").
- Font: monospace, small, red background.

### Empty
- If no secrets exist (after filtering/search), the table body is empty but the header and search still render.
- Display: "No secrets found" or similar message in the table area.

## Row Actions: NONE (Read-Only) + DEFERRED BUTTONS

The Swift panel has the following actions in the manage sheet, which are DEFERRED for web:

- **Edit button** — opens `SecretEditorSheet` (form with name, namespace, type, data key/value pairs). Type-aware editors exist for Opaque, Docker registry, TLS, Basic auth, SSH auth; others are view-only. Deferred: need generic `kubectl apply -f -` server route.
- **Move button** — copies the secret to another namespace. Deferred: need namespace picker + apply route.
- **Delete button** — submits a `deleteResource` action block. Deferred: need ConfirmSheet wiring for mutations.
- **View YAML button** — shows the raw YAML representation (via `Secret.toYAML()` using hand-rolled YAML). Deferred: need server YAML viewer.

DO NOT add Edit/Move/Delete/View YAML buttons to the web panel; these require infrastructure that is not yet in place.

## Input Restrictions & Validation (For Future Mutations)

When edit/create mutations ARE implemented (later, with new infra), these rules apply (from `SecretEditorSheet`):

- **Name field**: Required, non-empty after trimming whitespace. Read-only on edit.
- **Namespace field**: Required, non-empty. Defaults to "default" for new secrets. Read-only on edit.
- **Type field**: One of `SecretType` enum values. Defaults to `.opaque` for new secrets. Read-only on edit. Some types (Service-account token, Other) are not user-creatable.
- **Data rows**: Key and value pairs (decoded text). Keys must be non-empty and unique (no duplicates after trimming). Values can be empty. Type-specific editors pre-populate canonical keys:
  - Opaque: no defaults
  - Docker registry: `.dockerconfigjson` (assembled from server/username/password/email fields)
  - TLS: `tls.crt`, `tls.key`
  - Basic auth: `username`, `password`
  - SSH auth: `ssh-privatekey`
- **Labels**: Editable (from `metadata.labels`), but NOT shown in the read-only list view; only visible in the manage sheet's STATUS section.
- **Serialization**: When submitting, data is base64-encoded. The `Secret.draft()` and `Secret.toYAML()` methods handle encoding.

This is documented for future implementation; the web build is read-only and skips the editor UI entirely.

## kubectl Commands

All data is read-only and comes from the watch stream. No mutations are attempted on web. For reference (future mutations):

- **List**: `kubectl get secrets [-n <namespace>] --watch -o json` (server-side; web reads from store)
- **Get single**: `kubectl get secret <name> [-n <namespace>] -o json`
- **Create/Edit** (future): `kubectl apply -f -` with the YAML produced by `Secret.toYAML()` (requires new server route)
- **Delete** (future): `kubectl delete secret <name> [-n <namespace>]` (requires ConfirmSheet + server route)
- **Copy** (future, Move): `kubectl apply -f -` with the secret retargeted to another namespace via `Secret.copied(toNamespace:)`, then `kubectl delete secret <name> [-n <old-namespace>]`

## Data Derivation & Computed Properties

### Key Count
```
keyCount = data?.count ?? 0
```
(Secrets do NOT have a separate `binaryData` field like ConfigMaps; all values in `data` are base64-encoded.)

### Keys Sorted
All keys in `data`, sorted alphabetically for stable display:
```
keysSorted = (data ?? [:]).keys.sorted()
```

### Raw Bytes (from base64)
For a key in `data`, the value is always base64-encoded. Decode to get raw byte count:
```
rawBytes(key) = Data(base64Encoded: data[key] ?? "")?.count ?? 0
```

### Decoded Value (UTF-8)
Attempt to decode the base64 value as UTF-8. Returns `nil` if not valid UTF-8 (binary):
```
decoded(key) = String(data: Data(base64Encoded: data[key] ?? "") ?? Data(), encoding: .utf8)
```
Use this to populate the reveal block. If `nil`, show `<binary, N bytes>` instead.

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

- **`secrets`** — live Secret objects. Subscription scope depends on `namespaceFilter`:
  - If `nil`: subscribe to `'*'` (all namespaces)
  - If set: subscribe to that namespace name (e.g., `'default'`)

No other resource kinds are watched.

## Reveal Toggle State Management

- **Per-key local state**: The reveal/hide toggle for each key is stored in a React component state (Set<string> of revealed key names), not persisted.
- **No server interaction**: Reveal is purely client-side base64 decoding. No mutations, no round-trips.
- **Default hidden**: All values start hidden (masked with `••••••••`).
- **User-controlled**: Only explicit user click on "Reveal" for a key (or a global "Reveal all" button if implemented later) changes visibility.
- **Binary detection**: If a key's base64 value fails UTF-8 decode, show `<binary, N bytes>` instead of decoded text; still uses the same reveal toggle.

## Web Type Definition (packages/k8s)

The Secret type should be added to `packages/k8s/src/index.ts`:

```typescript
/**
 * Secret — mirrors the Kubernetes Secret JSON schema and the Swift
 * `Secret` type in `Sources/Helmsman/Cluster/Secret.swift`.
 * Secrets are namespace-scoped. All values in `data` are base64-encoded
 * as returned by `kubectl get -o json`.
 */
export interface Secret {
  metadata: ObjectMeta;
  type?: string; // e.g., "Opaque", "kubernetes.io/dockerconfigjson", "kubernetes.io/tls"
  /** Base64-encoded key/value pairs. */
  data?: Record<string, string>;
}
```

## Summary of Implementation Checklist

- [x] Read from `resources['secrets']` via Zustand store
- [x] Subscribe to `'secrets'` watch on mount
- [x] Render list table with Icon, Name, Namespace, Type, Keys count, Age columns
- [x] Type chip with display name and raw type tooltip
- [x] Sort by name (optionally group by namespace for all-ns view)
- [x] Expandable rows showing all data keys + values in detail section
- [x] Per-key reveal toggle (hidden by default, decoded on explicit user action)
- [x] Base64 decoding for revealed values (client-side only)
- [x] Binary detection and `<binary, NB bytes>` display for non-UTF-8 keys
- [x] Search across name, namespace, type, and key names (NOT decoded values)
- [x] Count chip with filtered count display
- [x] Loading spinner, error banner, empty state
- [x] Relative age calculation
- [ ] Edit/Create/Delete/Move buttons (DEFERRED — requires new server infra)
- [ ] Copy-to-clipboard for decoded values (DEFERRED — requires web impl)
- [ ] View YAML button (DEFERRED — requires server YAML viewer)
- [ ] Global reveal/hide all toggle (OPTIONAL — not in Swift, nice-to-have for UX)

## Architecture Notes

- **Reveal state**: Store in a local React state Set<string> (keys that are revealed). Alternatively, use a Map<string, boolean> for more efficient lookups. This is NOT shared across pages or persisted.
- **Type enum**: Mirror the Swift `SecretType` enum for display purposes. A helper function `secretTypeDisplayName(rawType?: string): string` should match `SecretType.displayName`.
- **Display helper module**: Create `apps/web/src/panels/secrets/secretsDisplay.ts` with pure functions:
  - `keyCount(secret: Secret): number`
  - `keysSorted(secret: Secret): string[]`
  - `secretTypeDisplayName(rawType?: string): string`
  - `decoded(secret: Secret, key: string): string | null` (returns null for binary)
  - `rawBytes(secret: Secret, key: string): number` (base64-decoded byte count)
  - `matchesSearch(secret: Secret, query: string): boolean` (name, namespace, type, keys — NOT values)
  - `sortSecrets(secrets: Secret[]): Secret[]` (namespace, then name)
- **Tests**: vitest coverage for base64 decode, binary detection, key count, type label, search (excluding values).
- **No new npm deps**: Use only existing shadcn/ui components and built-in Node.js APIs (e.g., `atob` for base64 in the browser, or a standard library function).
