# Namespaces Panel — Normative Behavior Spec

Ported from `Sources/Helmsman/Panels/Namespaces/` (Swift). This spec defines
the web implementation contract.

## 1. Data Model & Resources

### Namespace Object
Source: `kubectl get namespaces -o json` (cluster-scoped).

```
Namespace {
  metadata: {
    name: string               // DNS-1123 label, e.g. "default", "kube-system"
    uid: string                // cluster-scoped unique ID
    creationTimestamp: string   // ISO 8601, e.g. "2024-01-15T10:30:00Z"
    labels?: Record<string>
    annotations?: Record<string>
  }
  status?: {
    phase?: string             // "Active" | "Terminating" (optional, defaults to "Active")
  }
}
```

**Note:** Namespaces are **cluster-scoped** resources (no per-namespace qualifier).
The panel shows ALL namespaces and is NEVER filtered by the global `namespaceFilter`.

## 2. Panel Architecture

### Subscription & State
- **Watch:** `subscribe('namespaces', '*')` — always fetch all namespaces.
- **Store key:** `resources['namespaces']` — Record<name, Namespace>.
- **Load state:** `isLoading` (true between subscribe and first snapshot).
- **Error state:** `error` (last watch error message, if any).

### Display Flow
1. Header: Title "Namespaces", badge with count (respects search filter), loading spinner.
2. Search bar: Filter by name or phase (case-insensitive substring).
3. Error banner: Show `error` if non-null (red bg, mono font).
4. Table: sorted list of filtered namespaces (see §3).
5. Empty state: "No namespaces found" when filtered list is empty AND not loading.

## 3. Columns & Fields

Each row displays (left to right):

1. **Icon** — dashed-square icon (visual marker, no interaction).
2. **Name** — `metadata.name` (monospace font, max 1 line, left-align).
   - Source: `kubectl get namespace <name> -o json → metadata.name`.
3. **Phase** — `status.phase ?? "Active"` (pill badge, colored).
   - "Active" → green pill (rgba(34, 197, 94, 0.15), text green-600/green-400 dark).
   - "Terminating" → yellow pill (rgba(202, 138, 4, 0.15), text yellow-600/yellow-400 dark).
   - Other → gray pill (muted bg/text).
4. **Pod Count** — number of pods in this namespace (read-only, derived).
   - Source: count pods from `resources['pods']` where `pod.metadata.namespace == namespace.name`.
   - Display: "N pods" (singular: "1 pod", plural: "2 pods", etc.).
   - Fallback: "—" if pods subscription not active (do NOT require a new subscription).
5. **Age** — relative time since `metadata.creationTimestamp`.
   - Mirrors Swift `NamespaceRow.ageString()`: "5s", "3m", "2h", "1d".
   - Source: compute from `(now - creationTimestamp) / 1000` in seconds.
   - Fallback: "—" if creationTimestamp missing.

**Sort order:** By namespace name (lexicographic, case-sensitive ascending).

## 4. User Actions

### 4.1 Create Namespace

**Trigger:** Click "+ New" button in header (or Cmd+N / Ctrl+N keyboard shortcut).

**Flow:**
1. Open shadcn `Dialog` with title "New Namespace".
2. Single input field: "namespace name" placeholder.
3. DNS-1123 validation (client-side, real-time feedback):
   - Length: 1–63 characters.
   - Pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
   - (lowercase alphanumerics + hyphens; must start/end alphanumeric).
   - Display help text: "Names use lowercase letters, digits, and hyphens (DNS-1123)."
4. Create button: disabled until input is valid.
5. On "Create" or Enter: emit `ActionBlock`:
   ```
   {
     "kind": "createNamespace",
     "name": "<trimmed-input>",
     "label": "Create namespace <name>"
   }
   ```
6. Pass to `ConfirmSheet` (exact kubectl shown):
   ```
   kubectl create namespace <name>
   ```

**Empty/error handling:**
- Validation feedback: show disabled Create button until pattern matches.
- No server-side errors shown before confirm (server validation is in ConfirmSheet).

### 4.2 Delete Namespace

**Trigger:** Delete action per row (context menu or dropdown actions).

**Flow:**
1. User clicks delete/trash icon in row actions.
2. Emit `ActionBlock`:
   ```
   {
     "kind": "deleteNamespace",
     "name": "<namespace-name>",
     "destructive": true,
     "label": "Delete namespace <name>"
   }
   ```
3. Pass to `ConfirmSheet`:
   ```
   kubectl delete namespace <name>
   ```
4. ConfirmSheet shows destructive (red) confirm button + acknowledgment.

**Notes:**
- Namespace deletion is cluster-wide and permanent.
- Pods in the namespace are deleted with it (cascade).

## 5. Edge Cases & Error States

### Loading State
- `isLoading === true` after first subscribe, before snapshot arrives.
- Show spinner in header, disable create/delete actions (or allow and let server catch).
- Display table rows if available from previous session; otherwise empty.

### Error State
- `error` is non-null: show banner at top (red bg, mono font).
- Keep table visible below error banner (non-blocking).
- Disable create/delete actions or allow and let ConfirmSheet handle server errors.

### Empty State
- No namespaces in cluster: "No namespaces found" (centered, small text).
- All namespaces filtered out by search: "No namespaces match search" (if >0 exist).

### Namespace with No Pods
- Pod count shows "0 pods" (not hidden).

### Missing Fields
- `creationTimestamp` null: age displays "—".
- `status.phase` null: defaults to "Active", colored green.

## 6. Search Filter

**Scope:** `metadata.name` + `status.phase` (case-insensitive substring).

**Examples:**
- "kube" matches "kube-system", "kube-public".
- "active" matches any namespace with phase "Active" (case-insensitive).
- Empty query: all rows shown (no filter).

## 7. Keyboard & Accessibility

- **Cmd+N / Ctrl+N:** Open create dialog (bound in dialog/button).
- **Enter in create dialog:** Confirm (if valid).
- **Escape in create dialog:** Cancel.
- **Tab:** Navigate between search input → table rows → create button.
- **Delete action keyboard:** N/A (use mouse/trackpad or dialog confirm).

## 8. Watch & Subscription Lifecycle

**On mount:**
```ts
useEffect(() => {
  subscribe('namespaces', '*');
  return () => unsubscribe('namespaces', '*');
}, []);
```

**Key insight:** No namespace-filter dependency. Namespaces panel always watches
all namespaces (cluster-scoped).

## 9. kubectl Commands

Exact commands built by `apps/server/src/actions.ts::buildCommand()`:

```
createNamespace(name: "foo")
  → kubectl create namespace foo

deleteNamespace(name: "foo")
  → kubectl delete namespace foo
```

No `-n` namespace flag (cluster-scoped resource).
No `--context` in this contract (prepended by server/client).

## 10. Pod Count Derivation

**Source of truth:** `resources['pods']` (Record<podKey, Pod>).

**Algorithm:**
```ts
function podCountInNamespace(namespace: Namespace, allPods: Pod[]): number {
  return allPods.filter(p => p.metadata.namespace === namespace.metadata.name).length;
}
```

**Fallback:** If `resources['pods']` not subscribed, display "—" (do not add a new
subscription or polling requirement).

**Key:** Pods panel may or may not be subscribed; namespaces panel must not impose
this as a hard dependency. If pods are subscribed (e.g., pods panel is open), show
the count; if not, show "—".

## 11. Testing & Verification

### Unit Tests (vitest)

**Covered:**
- DNS-1123 validator: valid/invalid patterns.
- Relative age computation: "5s", "3m", "2h", "1d", "—".
- Pod count derivation: filter by namespace.
- Phase color mapping: Active/Terminating/other.
- Search filter: name + phase, case-insensitive.
- Sort order: lexicographic by name.

### Integration Test

**Live cluster:**
1. `pnpm --filter web test` passes.
2. `pnpm --filter web typecheck` passes.
3. `pnpm --filter web build` succeeds.
4. Open panel, subscribe('namespaces', '*') fires.
5. Table populated from `resources['namespaces']`.
6. Create dialog: enter valid name → ConfirmSheet shows `kubectl create namespace X`.
7. Delete action: ConfirmSheet shows `kubectl delete namespace X`.
8. Search bar: type name → rows filtered.

## 12. Deferred Infrastructure

- **Global namespace selector bar:** Separate feature (cross-cutting). Out of scope.
- **Namespace YAML view:** Defer; covered by "View YAML" MCP or manual kubectl.
- **Namespace quota/LimitRange display:** Defer; separate detail panel.
- **Batch operations (create multiple, delete selected):** Defer; start with single actions.
