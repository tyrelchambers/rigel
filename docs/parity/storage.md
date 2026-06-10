# Storage Panel — Normative Web Port Spec

**Status**: SOURCE OF TRUTH for web implementation.  
**Extracted from**: `Sources/Helmsman/Panels/Storage/StoragePanel.swift` + `StorageViewModel.swift` + `StorageTypes.swift`.  
**Watch scope**: Multi-kind panel (PersistentVolumeClaims namespace-scoped, PersistentVolumes cluster-scoped, StorageClasses cluster-scoped).

---

## 1. Data Source

### Watch Subscriptions

The panel subscribes to three Kubernetes resource kinds on mount and unsubscribes on unmount or namespace filter change:

#### PersistentVolumeClaims (PVCs)
- **Kind**: `persistentvolumeclaims`
- **Namespace**: Active namespace filter (from store); if none, filter is `null` but PVCs are always namespace-scoped, so display only those matching current namespace
- **Scope**: Namespace-scoped
- **Ref**: `subscribe('persistentvolumeclaims', namespaceFilter ?? '*')`
- **Initial snapshot**: All PVCs in the active namespace (or all PVCs if no filter)
- **Deltas**: Added/updated/removed PVCs trigger store updates

#### PersistentVolumes (PVs)
- **Kind**: `persistentvolumes`
- **Namespace**: `*` (cluster-scoped; no namespace filter applies)
- **Scope**: Cluster-scoped
- **Ref**: `subscribe('persistentvolumes', '*')`
- **Initial snapshot**: All cluster PVs
- **Deltas**: Added/updated/removed PVs trigger store updates

#### StorageClasses
- **Kind**: `storageclasses`
- **Namespace**: `*` (cluster-scoped; no namespace filter applies)
- **Scope**: Cluster-scoped
- **Ref**: `subscribe('storageclasses', '*')`
- **Initial snapshot**: All StorageClasses in the cluster
- **Deltas**: Added/updated/removed StorageClasses trigger store updates

### Resource Types

```typescript
// PersistentVolumeClaim
interface PersistentVolumeClaim {
  metadata: ObjectMeta;
  spec?: {
    accessModes?: string[];  // "ReadWriteOnce", "ReadOnlyMany", "ReadWriteMany", "ReadWriteOncePod"
    resources?: {
      requests?: Record<string, string>;  // "storage": "10Gi"
    };
    storageClassName?: string;
    volumeName?: string;
  };
  status?: {
    phase?: string;  // "Bound" | "Pending" | "Lost"
    capacity?: Record<string, string>;  // "storage": actual provisioned
    accessModes?: string[];
  };
}

// PersistentVolume
interface PersistentVolume {
  metadata: ObjectMeta;
  spec?: {
    capacity?: Record<string, string>;  // "storage": capacity
    accessModes?: string[];
    persistentVolumeReclaimPolicy?: string;  // "Retain" | "Delete" | "Recycle"
    storageClassName?: string;
    claimRef?: {
      namespace?: string;
      name?: string;
    };
  };
  status?: {
    phase?: string;  // "Available" | "Bound" | "Released" | "Failed"
  };
}

// StorageClass
interface StorageClass {
  metadata: ObjectMeta;
  provisioner?: string;
  reclaimPolicy?: string;  // "Retain" | "Delete" | "Recycle"
  volumeBindingMode?: string;  // "Immediate" | "WaitForFirstConsumer"
  allowVolumeExpansion?: boolean;
}
```

---

## 2. Display Layout

### Header Row

- **Left Section**:
  - **Title**: "Storage" (panel name)
  - **Count badge**: Total count of resources for the currently selected kind (after filtering)
    - PVCs: filtered count (namespace filter applied)
    - PVs: filtered count (no namespace, cluster-wide)
    - StorageClasses: filtered count (no namespace, cluster-wide)
  - **Load indicator**: Spinning loader (when `isLoading === true`)
  
- **Right Section**:
  - **Search field**: Text input, placeholder "Search…", max-width 200px
    - Case-insensitive substring match across all searchable fields for the active kind

### Kind Toggle Bar

Five pill buttons in a horizontal row (left to right):

1. **Claims** (default, toggles to PVCs view)
2. **Volumes** (toggles to PVs view)
3. **Classes** (toggles to StorageClasses view)

- **Styling**: Active pill is highlighted (primary accent color); inactive pills are secondary/muted
- **Behavior**: Clicking a pill updates the view to show that kind only
- **State**: Persisted to client state (not persisted between sessions)

### Error Banner

- **Visibility**: Shown only when `error !== null`
- **Style**: Red/destructive background with monospace font
- **Content**: Full error message text (e.g., kubectl connection failure)

### Main List / Card Area

Scrollable list with cards for each resource, layout depends on active kind. See §3 for per-kind row structure.

---

## 3. Display Columns & Field Mappings

### 3A. PersistentVolumeClaims (PVCs)

**Display mode**: Card layout (single card per PVC)  
**Sort order**: By namespace (alphabetic), then by name (lexicographic)  
**Filtering**: Applied to PVCs only; search term is case-insensitive substring match against name, namespace, storageClassName, volumeName, and phase

#### Card Structure (left to right):

1. **Icon**: Disk/drive icon (externaldrive.fill)
   - Color: Primary accent

2. **Name** (monospace, semibold)
   - **Data source**: `metadata.name`
   - **Length**: Truncate with ellipsis if too long (lineLimit 1)

3. **Namespace Chip** (small badge)
   - **Data source**: `metadata.namespace` or "—" if missing
   - **Styling**: Muted background, tertiary text

4. **Phase Badge** (status-colored pill)
   - **Data source**: `status.phase` or "Unknown"
   - **Values & Colors**:
     - "Bound" → green (running)
     - "Available" → green (running)
     - "Pending" → amber (pending)
     - "Lost" → red (failed)
     - "Failed" → red (failed)
     - Other → tertiary gray
   - **Styling**: Colored background with text at matching color

5. **Access Modes** (comma-separated, monospace, tertiary text)
   - **Data source**: `status.accessModes` (preferred) or `spec.accessModes` (fallback)
   - **Abbreviation**: Apply display helper `abbreviateAccessModes`:
     - "ReadWriteOnce" → "RWO"
     - "ReadOnlyMany" → "ROX"
     - "ReadWriteMany" → "RWX"
     - "ReadWriteOncePod" → "RWOP"
   - **Display**: "RWO,ROX" (joined with comma)
   - **Visibility**: Hidden if no access modes

6. **Storage Class Chip** (optional, small badge)
   - **Data source**: `spec.storageClassName`
   - **Visibility**: Hidden if missing
   - **Styling**: Muted background, tertiary text

7. **Capacity** (monospace, right-aligned, min 48px width)
   - **Data source**:
     1. `status.capacity["storage"]` (actual provisioned, if bound)
     2. Fall back to `spec.resources.requests["storage"]` (requested, if pending)
     3. Fall back to "—" (if neither exists)
   - **Formatting**: Display as-is (e.g., "10Gi", "512Mi"); no additional parsing needed here (parsing deferred to display helper if needed in tests)

#### Row Actions (Context Menu)

- **View YAML**: Opens YAML viewer (server-backed, deferred feature)
- **Divider**
- **Delete PVC**: Dangerous action; opens confirm sheet with exact kubectl command:
  ```
  kubectl delete pvc <name> -n <namespace>
  ```
  - Action block: `{"kind":"deleteResource","name":"<pvc-name>","namespace":"<namespace>","resourceKind":"pvc","label":"Delete PVC <name>"}`

---

### 3B. PersistentVolumes (PVs)

**Display mode**: Card layout (single card per PV)  
**Sort order**: By name (lexicographic)  
**Filtering**: Applied to PVs only; search term is case-insensitive substring match against name, storageClassName, claim reference (namespace/name), phase, and reclaimPolicy

#### Card Structure (left to right):

1. **Icon**: Internal drive icon (internaldrive.fill)
   - Color: Primary accent

2. **Name** (monospace, semibold)
   - **Data source**: `metadata.name`
   - **Truncation**: Ellipsis if too long; middle truncation (truncationMode .middle) preferred
   - **Length**: Truncate with lineLimit 1

3. **Phase Badge** (status-colored pill)
   - **Data source**: `status.phase` or "Unknown"
   - **Values & Colors**:
     - "Available" → green (running)
     - "Bound" → green (running)
     - "Released" → red (failed)
     - "Failed" → red (failed)
     - Other → tertiary gray
   - **Styling**: Colored background with text at matching color

4. **Claim Reference** (optional, tertiary text, small mono)
   - **Data source**: `spec.claimRef` (object with namespace and name)
   - **Display format**: `<namespace>/<name>` (or "default/<name>" if namespace is missing/nil)
   - **Prefix icon**: Small arrow-right icon (right-pointing, tertiary color)
   - **Visibility**: Shown only if claimRef exists (i.e., PV is bound to a PVC)
   - **Truncation**: Middle truncation if too long; lineLimit 1

5. **Reclaim Policy Chip** (small badge)
   - **Data source**: `spec.persistentVolumeReclaimPolicy` or "—"
   - **Styling**: Muted background, tertiary text

6. **Storage Class Chip** (optional, small badge)
   - **Data source**: `spec.storageClassName`
   - **Visibility**: Hidden if missing or empty

7. **Capacity** (monospace, right-aligned, min 48px width)
   - **Data source**: `spec.capacity["storage"]` or "—"
   - **Formatting**: Display as-is (e.g., "100Gi")

#### Row Actions (Context Menu)

- **View YAML**: Opens YAML viewer (server-backed, deferred feature)
- **Divider**
- **Delete PV**: Dangerous action; opens confirm sheet with exact kubectl command:
  ```
  kubectl delete pv <name>
  ```
  - Action block: `{"kind":"deleteResource","name":"<pv-name>","resourceKind":"pv","label":"Delete PV <name>"}`

---

### 3C. StorageClasses

**Display mode**: Card layout (single card per StorageClass)  
**Sort order**: By name (lexicographic)  
**Filtering**: Applied to StorageClasses only; search term is case-insensitive substring match against name, provisioner, reclaimPolicy, and volumeBindingMode

#### Card Structure (left to right):

1. **Icon**: Shipping box / package icon (shippingbox.circle.fill)
   - Color: Primary accent

2. **Name** (monospace, semibold)
   - **Data source**: `metadata.name`
   - **Truncation**: Ellipsis if too long; lineLimit 1

3. **Default Badge** (optional)
   - **Data source**: `metadata.annotations["storageclass.kubernetes.io/is-default-class"]`
   - **Visibility**: Shown only if value is `"true"`
   - **Text**: "default" (lowercase)
   - **Styling**: Green background (running color), green text, small monospace font

4. **Volume Binding Mode Chip** (optional, small badge)
   - **Data source**: `volumeBindingMode`
   - **Visibility**: Hidden if missing
   - **Styling**: Muted background, tertiary text

5. **Reclaim Policy Chip** (optional, small badge)
   - **Data source**: `reclaimPolicy`
   - **Visibility**: Hidden if missing
   - **Styling**: Muted background, tertiary text

6. **Provisioner** (monospace, tertiary text, right-aligned, max 220px)
   - **Data source**: `provisioner` or "—"
   - **Truncation**: Middle truncation if too long; lineLimit 1

#### Row Actions (Context Menu)

- **View YAML**: Opens YAML viewer (server-backed, deferred feature)
  - No delete action for StorageClasses (mutations deferred)

---

## 4. User Actions & kubectl Commands

### Deferred Actions

The following actions are NOT implemented in the initial web port and MUST NOT be added without a new feature spec:

- **Port-forward**: Requires server-side subprocess manager + WebSocket bidirectional stream.
- **Edit / Create**: Requires mutation routes and ConfirmSheet wiring.
- **Delete**: Read-only panel; delete mutations deferred.
- **Ask Claude handoff**: Requires diagnostic context builder.
- **View YAML**: Requires server YAML endpoint + viewer UI (deferred, but row context menu shows the action as a stub).

### Implemented Actions

**None in read-only mode.** All context menu items (View YAML, Delete) are deferred stubs that open the confirm sheet (when wired later) or log a message.

---

## 5. Search & Filtering

### Search Behavior

- **Scope**: Current kind only (PVC, PV, or StorageClass)
- **Match**: Case-insensitive substring match
- **Fields searched** (varies by kind):

  **PVCs**: name, namespace, storageClassName, volumeName, phase
  ```
  matches = name.includes(search) 
         || namespace.includes(search) 
         || storageClassName.includes(search)
         || volumeName.includes(search)
         || phase.includes(search)
  ```

  **PVs**: name, storageClassName, claimRef (namespace/name formatted), phase, reclaimPolicy
  ```
  matches = name.includes(search)
         || storageClassName.includes(search)
         || claim.includes(search)
         || phase.includes(search)
         || reclaimPolicy.includes(search)
  ```

  **StorageClasses**: name, provisioner, reclaimPolicy, volumeBindingMode
  ```
  matches = name.includes(search)
         || provisioner.includes(search)
         || reclaimPolicy.includes(search)
         || volumeBindingMode.includes(search)
  ```

- **Empty search**: Returns all resources for the active kind (no filtering)
- **Count**: Display counts total for active kind (after search filter), plus filtered count if different

---

## 6. Loading & Error States

### Loading State

- **Trigger**: When a kind is first subscribed (before snapshot arrives)
- **Visual**: Spinning loader icon in header, right of title
- **Duration**: Typically 0–500ms; dismissed when first snapshot arrives or error occurs

### Error State

- **Trigger**: Watch subscription fails (kubectl error, network error, RBAC denied)
- **Visual**: Red/destructive banner below header with monospace font
- **Content**: Full error text (e.g., "error: the server doesn't have a resource type "persistentvolumeclaims"")
- **Behavior**: Error persists until watch is re-established; clear on re-subscribe
- **Clear action**: Dismiss manually (no auto-clear) or wait for app reconnect

### Empty State

- **Trigger**: Active kind has zero resources (after search filter applied, if any)
- **Visual**: Empty list (no fallback message in Swift impl; just blank scrollable area)
- **Behavior**: Shows header + kind bar + empty scroll area
- **With search**: If search matches zero items, show the same empty list (no "no results" message)

---

## 7. Namespace Filtering

### Scope

- **PVCs**: Filtered by active `namespaceFilter` from the cluster store
  - If `namespaceFilter === null`, show PVCs from all namespaces
  - If `namespaceFilter === "default"`, show PVCs from the "default" namespace only
  - PVCs are always sorted by namespace first, then by name

- **PVs**: Always cluster-scoped; NO namespace filtering applied
  - Display all PVs regardless of namespace filter setting
  - Sorted by name only

- **StorageClasses**: Always cluster-scoped; NO namespace filtering applied
  - Display all StorageClasses regardless of namespace filter setting
  - Sorted by name only

### Behavior on Namespace Change

When `namespaceFilter` changes (user selects a different namespace elsewhere in the app):
1. Unsubscribe from the current PVC watch (old namespace or `*`)
2. Subscribe to the new PVC watch (new namespace or `*`)
3. The store updates; the filtered lists recompute
4. PV and StorageClass watches remain unchanged (cluster-scoped)

---

## 8. Display Helpers / Utility Functions

### `abbreviateAccessModes(modes: string[]): string[]`

Converts Kubernetes access mode strings to conventional abbreviations:

```typescript
const abbreviations: Record<string, string> = {
  "ReadWriteOnce": "RWO",
  "ReadOnlyMany": "ROX",
  "ReadWriteMany": "RWX",
  "ReadWriteOncePod": "RWOP",
};

export function abbreviateAccessModes(modes: string[]): string[] {
  return modes.map(m => abbreviations[m] ?? m);
}
```

**Usage**: PVC and PV access mode display

### `storagePhaseColor(phase: string): CSSClass`

Maps storage phase strings to Tailwind/CSS color classes:

```typescript
const colorMap: Record<string, string> = {
  "Bound": "text-running bg-running/10",
  "Available": "text-running bg-running/10",
  "Pending": "text-pending bg-pending/10",
  "Lost": "text-failed bg-failed/10",
  "Failed": "text-failed bg-failed/10",
  // default: "text-muted-foreground bg-muted"
};

export function phaseColorClass(phase: string): string {
  return colorMap[phase] ?? "text-muted-foreground bg-muted";
}
```

**Usage**: PVC and PV phase badge styling

### `isDefaultStorageClass(sc: StorageClass): boolean`

Detects if a StorageClass is marked as the cluster default:

```typescript
export function isDefaultStorageClass(sc: StorageClass): boolean {
  return sc.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true";
}
```

**Usage**: StorageClass "default" badge visibility

### `claimRef(pv: PersistentVolume): string | null`

Formats a PV's claim reference as "namespace/name":

```typescript
export function claimRef(pv: PersistentVolume): string | null {
  const ref = pv.spec?.claimRef;
  if (!ref?.name) return null;
  return `${ref.namespace ?? "default"}/${ref.name}`;
}
```

**Usage**: PV claim reference display

### `matchesSearch(searchFields: (string | undefined)[], query: string): boolean`

Case-insensitive substring matching for search:

```typescript
export function matchesSearch(
  searchFields: (string | undefined)[],
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const haystack = searchFields
    .filter((f) => f !== undefined && f !== null)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}
```

**Usage**: PVC, PV, and StorageClass filtering

---

## 9. Edge Cases & Behaviors

### PVC with no storageClassName
- **Display**: Omit the storageClassName chip; show only name, namespace, phase, access modes, capacity
- **Search**: Clause `storageClassName.includes(search)` skipped (or filtered as "—")

### PV with no claimRef
- **Display**: Omit the claim reference; show only name, phase, capacity, reclaim policy
- **Search**: Claim search clause skipped

### PV with empty storageClassName
- **Display**: Omit the storageClassName chip (check `!sc.isEmpty` or presence)
- **Search**: Filtered from search match

### StorageClass with no provisioner
- **Display**: Show "—" in provisioner column
- **Search**: Include "—" in search match (or treat as missing)

### Missing or undefined nested objects
- All objects default to display "—" or are hidden (per spec)
- Decoding failures are silently handled; nil/undefined fields are treated as absent

### Capacity Quantity Formatting
- **Stored as**: Kubernetes quantity strings ("10Gi", "512Mi", "1048576Ki")
- **Display as-is**: No normalization to largest unit (e.g., "1048576Ki" stays as "1048576Ki", not converted to "1Gi")
- **Parsing deferred**: If value needs to be parsed/normalized, implement in a display helper with vitest coverage

### Access Modes Order
- **Display order**: As returned from Kubernetes API (no explicit sort)
- **Abbreviation**: Always apply even if single mode

### Phase Unknown Values
- Any phase not in the enum ("Bound", "Pending", "Lost", "Available", "Released", "Failed") falls through to default color (tertiary gray)
- **Display**: Show the phase string as-is (e.g., "Corrupt" displays as "Corrupt")

---

## 10. State Management & Lifecycle

### Mount
1. Subscribe to `persistentvolumeclaims` with active namespace filter (or `*`)
2. Subscribe to `persistentvolumes` with `*`
3. Subscribe to `storageclasses` with `*`
4. Read initial snapshots from store; apply filters and sorting
5. Set `activeKind = StorageKind.pvcs` (default)
6. Set `search = ""`

### Unmount
1. Unsubscribe from `persistentvolumeclaims` (active namespace or `*`)
2. Unsubscribe from `persistentvolumes`
3. Unsubscribe from `storageclasses`

### On Namespace Filter Change
1. Unsubscribe from PVC watch (old namespace)
2. Subscribe to PVC watch (new namespace)
3. Store updates; filtered PVC list recomputes
4. PV and StorageClass subscriptions remain unchanged

### On Kind Change
1. Update `activeKind` to the selected kind
2. Reset search to `""` (optional; preserving search is also acceptable)
3. Update displayed list to filtered resources for the new kind

### On Search Input Change
1. Update search string
2. Recompute filtered list for active kind
3. Update count badge

---

## 11. Acceptance Criteria

1. **Live resource views**: All three resource kinds (PVCs, PVs, StorageClasses) are fetched via the cluster store and displayed correctly.
2. **Kind toggle**: Switching between Claims/Volumes/Classes displays the correct resource list and updates the count badge.
3. **PVC columns**: Name, namespace, phase (colored), access modes, storageClassName, capacity are all displayed per spec.
4. **PV columns**: Name, phase (colored), claim reference, reclaim policy, storageClassName, capacity are all displayed per spec.
5. **StorageClass columns**: Name, default badge (when applicable), volume binding mode, reclaim policy, provisioner are all displayed per spec.
6. **Search**: Case-insensitive substring matching works for each kind across the documented fields.
7. **Namespace filtering**: PVCs respect the active namespace filter; PVs and StorageClasses are cluster-wide.
8. **Loading state**: Spinner appears during initial snapshot load; disappears when data arrives or error occurs.
9. **Error state**: Red banner displays error messages correctly.
10. **Empty state**: Blank list when no resources match (no special "no results" message required).
11. **Sorting**: PVCs sorted by namespace, then name; PVs and StorageClasses sorted by name only.
12. **Abbreviation helpers**: `abbreviateAccessModes`, `storagePhaseColor`, `isDefaultStorageClass`, `claimRef`, `matchesSearch` are implemented and covered by vitest.
13. **No mutations**: Read-only panel; context menu actions are deferred stubs (no ConfirmSheet, no action blocks emitted).
14. **TypeScript**: Zero type errors via `pnpm --filter web typecheck`.
15. **Build**: `pnpm --filter web build` succeeds.
16. **Tests**: `pnpm --filter web test` passes; display-helper tests cover all utility functions.

