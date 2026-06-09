# RBAC Panel — Normative Web Port Spec

**Status**: SOURCE OF TRUTH for web implementation.  
**Extracted from**: `Sources/Helmsman/Panels/RBAC/RBACPanel.swift` + `RBACViewModel.swift` + `Sources/Helmsman/Cluster/RBACTypes.swift`.  
**Watch scope**: Multi-kind panel with mixed scope (Roles/RoleBindings/ServiceAccounts are namespace-scoped; ClusterRoles/ClusterRoleBindings are cluster-scoped).

---

## 1. Data Source

### Watch Subscriptions

The panel subscribes to five Kubernetes resource kinds on mount and unsubscribes on unmount or namespace filter change:

#### ServiceAccounts (v1)
- **Kind**: `serviceaccounts`
- **Namespace**: Active namespace filter (from store); if none, subscribe to all namespaces
- **Scope**: Namespace-scoped
- **Ref**: `subscribe('serviceaccounts', namespaceFilter ?? '*')`
- **Initial snapshot**: All ServiceAccounts in the active namespace (or all if no filter)
- **Deltas**: Added/updated/removed ServiceAccounts trigger store updates

#### Roles (rbac.authorization.k8s.io/v1)
- **Kind**: `roles`
- **Namespace**: Active namespace filter (from store); if none, subscribe to all namespaces
- **Scope**: Namespace-scoped
- **Ref**: `subscribe('roles', namespaceFilter ?? '*')`
- **Initial snapshot**: All Roles in the active namespace (or all if no filter)
- **Deltas**: Added/updated/removed Roles trigger store updates

#### RoleBindings (rbac.authorization.k8s.io/v1)
- **Kind**: `rolebindings`
- **Namespace**: Active namespace filter (from store); if none, subscribe to all namespaces
- **Scope**: Namespace-scoped
- **Ref**: `subscribe('rolebindings', namespaceFilter ?? '*')`
- **Initial snapshot**: All RoleBindings in the active namespace (or all if no filter)
- **Deltas**: Added/updated/removed RoleBindings trigger store updates

#### ClusterRoles (rbac.authorization.k8s.io/v1)
- **Kind**: `clusterroles`
- **Namespace**: `*` (cluster-scoped; no namespace filter applies)
- **Scope**: Cluster-scoped
- **Ref**: `subscribe('clusterroles', '*')`
- **Initial snapshot**: All ClusterRoles in the cluster
- **Deltas**: Added/updated/removed ClusterRoles trigger store updates

#### ClusterRoleBindings (rbac.authorization.k8s.io/v1)
- **Kind**: `clusterrolebindings`
- **Namespace**: `*` (cluster-scoped; no namespace filter applies)
- **Scope**: Cluster-scoped
- **Ref**: `subscribe('clusterrolebindings', '*')`
- **Initial snapshot**: All ClusterRoleBindings in the cluster
- **Deltas**: Added/updated/removed ClusterRoleBindings trigger store updates

### Resource Types

```typescript
// Shared types
interface ObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

// PolicyRule — describes what a Role/ClusterRole permits
interface PolicyRule {
  apiGroups?: string[];      // e.g. ["", "apps", "batch"]
  resources?: string[];      // e.g. ["pods", "services", "deployments"]
  verbs?: string[];          // e.g. ["get", "list", "watch", "create", "update", "delete", "patch"]
}

// RoleRef — reference from a Binding to a Role/ClusterRole
interface RoleRef {
  kind?: string;    // "Role" | "ClusterRole"
  name?: string;
}

// Subject — who (user, group, or service account) is bound by a Binding
interface Subject {
  kind?: string;       // "User" | "Group" | "ServiceAccount"
  name?: string;
  namespace?: string;  // Present only for ServiceAccount subjects (namespace of the SA)
}

// ServiceAccount (v1) — namespace-scoped
interface ServiceAccount {
  metadata: ObjectMeta;
  secrets?: Array<{ name?: string }>;  // List of secret references
}

// Role (rbac.authorization.k8s.io/v1) — namespace-scoped
interface Role {
  metadata: ObjectMeta;
  rules?: PolicyRule[];
}

// ClusterRole (rbac.authorization.k8s.io/v1) — cluster-scoped
interface ClusterRole {
  metadata: ObjectMeta;
  rules?: PolicyRule[];
}

// RoleBinding (rbac.authorization.k8s.io/v1) — namespace-scoped
interface RoleBinding {
  metadata: ObjectMeta;
  roleRef?: RoleRef;
  subjects?: Subject[];
}

// ClusterRoleBinding (rbac.authorization.k8s.io/v1) — cluster-scoped
interface ClusterRoleBinding {
  metadata: ObjectMeta;
  roleRef?: RoleRef;
  subjects?: Subject[];
}
```

---

## 2. Display Layout

### Header Row

- **Left Section**:
  - **Title**: "RBAC" (panel name)
  - **Count badge**: Total count of resources for the currently selected kind (after filtering by search and namespace)
    - Reflects the filtered count when search is active
  - **Load indicator**: Spinning loader (when `isLoading === true`)

- **Right Section**:
  - **Search field**: Text input, placeholder "Search…", max-width 200px
    - Case-insensitive substring match across name, namespace, roleRef.name, and rule/subject content
    - Applied independently per kind

### Kind Toggle Bar

Five pill buttons in a horizontal row (left to right):

1. **ServiceAccounts** (toggles to ServiceAccounts view)
2. **Roles** (toggles to Roles view)
3. **RoleBindings** (toggles to RoleBindings view)
4. **ClusterRoles** (toggles to ClusterRoles view)
5. **ClusterRoleBindings** (toggles to ClusterRoleBindings view)

- **Styling**: Active pill is highlighted (primary accent color); inactive pills are secondary/muted
- **Behavior**: Clicking a pill updates the view to show that kind only
- **State**: Persisted to client state (not persisted between sessions)

### Error Banner

- **Visibility**: Shown only when `error !== null`
- **Style**: Red/destructive background with monospace font
- **Content**: Full error message text (e.g., kubectl connection failure)

### Main List / Card Area

Scrollable list with cards for each resource. Rows vary by kind; see §3 for per-kind structure.

---

## 3. Display Columns & Field Mappings

### 3A. ServiceAccounts

**Display mode**: Card layout (single card per ServiceAccount)  
**Sort order**: By namespace (alphabetic), then by name (lexicographic)  
**Filtering**: Case-insensitive substring match against name and namespace; also searches against the count of secrets (e.g. "2 secrets" matches the literal string)

#### Card Structure (left to right):

1. **Icon**: "person.crop.circle.fill" (person icon in circle)
   - Color: Primary accent

2. **Name** (monospace, semibold)
   - **Data source**: `metadata.name`
   - **Truncation**: Ellipsis if too long (lineLimit 1, truncationMode middle)

3. **Namespace Chip** (small badge)
   - **Data source**: `metadata.namespace` or omit if missing
   - **Styling**: Muted background, tertiary text

4. **Trailing Field** (right-aligned, monospace, secondary text)
   - **Data source**: `secrets.length` or `0` if not present
   - **Display format**: `"<count> secret"` or `"<count> secrets"` (plural)
   - **Example**: "3 secrets", "1 secret", "0 secrets"

#### Row Actions (Context Menu)

- **View YAML**: Opens YAML viewer (server-backed, deferred feature)
- **Divider**
- **Delete serviceaccount**: Dangerous action; opens confirm sheet with exact kubectl command:
  ```
  kubectl delete serviceaccount <name> -n <namespace>
  ```
  - Action block: `{"kind":"deleteResource","name":"<name>","namespace":"<namespace>","resourceKind":"serviceaccount","label":"Delete ServiceAccount <name>"}`

---

### 3B. Roles

**Display mode**: Card layout (single card per Role)  
**Sort order**: By namespace (alphabetic), then by name (lexicographic)  
**Filtering**: Case-insensitive substring match against name, namespace, and all rule content (apiGroups, resources, verbs flattened as searchable text)

#### Card Structure (left to right):

1. **Icon**: "lock.fill" (padlock icon)
   - Color: Primary accent

2. **Name** (monospace, semibold)
   - **Data source**: `metadata.name`
   - **Truncation**: Ellipsis if too long (lineLimit 1, truncationMode middle)

3. **Namespace Chip** (small badge)
   - **Data source**: `metadata.namespace` or omit if missing
   - **Styling**: Muted background, tertiary text

4. **Trailing Field** (right-aligned, monospace, secondary text)
   - **Data source**: `rules.length` or `0` if not present
   - **Display format**: `"<count> rule"` or `"<count> rules"` (plural)
   - **Example**: "5 rules", "1 rule", "0 rules"

5. **Expandable Detail** (optional, secondary detail row)
   - **Visibility**: Expand on click to show full rule set
   - **Content** (when expanded):
     - For each rule in `rules[]`:
       - **API Groups**: Comma-separated list of `apiGroups[]` (or `[""]` shown as `["core"]`, or `"*"` if wildcard)
       - **Resources**: Comma-separated list of `resources[]` (or `"*"` if wildcard)
       - **Verbs**: Comma-separated list of `verbs[]` (or `"*"` if wildcard)
       - Format each rule as one indented line: `apiGroups: <groups>  resources: <resources>  verbs: <verbs>`
     - Example expansion:
       ```
       apiGroups: ["core"]  resources: ["pods"]  verbs: ["get", "list"]
       apiGroups: ["apps"]  resources: ["deployments"]  verbs: ["get", "list", "watch"]
       ```

#### Row Actions (Context Menu)

- **View YAML**: Opens YAML viewer (server-backed, deferred feature)
- **Divider**
- **Delete role**: Dangerous action; opens confirm sheet with exact kubectl command:
  ```
  kubectl delete role <name> -n <namespace>
  ```
  - Action block: `{"kind":"deleteResource","name":"<name>","namespace":"<namespace>","resourceKind":"role","label":"Delete Role <name>"}`

---

### 3C. RoleBindings

**Display mode**: Card layout (single card per RoleBinding)  
**Sort order**: By namespace (alphabetic), then by name (lexicographic)  
**Filtering**: Case-insensitive substring match against name, namespace, roleRef.name, and all subjects (kind, name, namespace flattened as searchable text)

#### Card Structure (left to right):

1. **Icon**: "link" (chain link icon)
   - Color: Primary accent

2. **Name** (monospace, semibold)
   - **Data source**: `metadata.name`
   - **Truncation**: Ellipsis if too long (lineLimit 1, truncationMode middle)

3. **Namespace Chip** (small badge)
   - **Data source**: `metadata.namespace` or omit if missing
   - **Styling**: Muted background, tertiary text

4. **RoleRef Trailing** (monospace, secondary text)
   - **Data source**: `roleRef`
   - **Display format**: `"<kind>/<name>"` where `kind` defaults to `"Role"` if missing
   - **Example**: `"Role/pod-reader"`, `"ClusterRole/admin"`
   - **Default when absent**: `"—"`

5. **Expandable Detail** (optional, subjects summary row)
   - **Visibility**: Always shown (second line below name)
   - **Content**: Compact subjects summary (see **RBACDisplay.subjectsSummary** below)
   - **Formatting**: See §3 helper functions

#### Row Actions (Context Menu)

- **View YAML**: Opens YAML viewer (server-backed, deferred feature)
- **Divider**
- **Delete rolebinding**: Dangerous action; opens confirm sheet with exact kubectl command:
  ```
  kubectl delete rolebinding <name> -n <namespace>
  ```
  - Action block: `{"kind":"deleteResource","name":"<name>","namespace":"<namespace>","resourceKind":"rolebinding","label":"Delete RoleBinding <name>"}`

---

### 3D. ClusterRoles

**Display mode**: Card layout (single card per ClusterRole)  
**Sort order**: By name (lexicographic)  
**Filtering**: Case-insensitive substring match against name and all rule content (apiGroups, resources, verbs flattened as searchable text); no namespace filter applies

#### Card Structure (left to right):

1. **Icon**: "lock.shield.fill" (padlock with shield icon)
   - Color: Primary accent

2. **Name** (monospace, semibold)
   - **Data source**: `metadata.name`
   - **Truncation**: Ellipsis if too long (lineLimit 1, truncationMode middle)

3. **Trailing Field** (right-aligned, monospace, secondary text)
   - **Data source**: `rules.length` or `0` if not present
   - **Display format**: `"<count> rule"` or `"<count> rules"` (plural)
   - **Example**: "8 rules", "1 rule"

4. **Expandable Detail** (optional)
   - **Visibility**: Expand on click to show full rule set
   - **Content**: Same as Roles (§3B) — each rule as one line with apiGroups, resources, verbs

#### Row Actions (Context Menu)

- **View YAML**: Opens YAML viewer (server-backed, deferred feature)
- **Divider**
- **Delete clusterrole**: Dangerous action; opens confirm sheet with exact kubectl command:
  ```
  kubectl delete clusterrole <name>
  ```
  - Action block: `{"kind":"deleteResource","name":"<name>","resourceKind":"clusterrole","label":"Delete ClusterRole <name>"}`

---

### 3E. ClusterRoleBindings

**Display mode**: Card layout (single card per ClusterRoleBinding)  
**Sort order**: By name (lexicographic)  
**Filtering**: Case-insensitive substring match against name, roleRef.name, and all subjects (kind, name flattened as searchable text); no namespace filter applies

#### Card Structure (left to right):

1. **Icon**: "link.badge.plus" (chain link with badge/plus icon)
   - Color: Primary accent

2. **Name** (monospace, semibold)
   - **Data source**: `metadata.name`
   - **Truncation**: Ellipsis if too long (lineLimit 1, truncationMode middle)

3. **RoleRef Trailing** (monospace, secondary text)
   - **Data source**: `roleRef`
   - **Display format**: `"<kind>/<name>"` where `kind` defaults to `"ClusterRole"` if missing
   - **Example**: `"ClusterRole/admin"`, `"ClusterRole/view"`
   - **Default when absent**: `"—"`

4. **Expandable Detail** (optional, subjects summary row)
   - **Visibility**: Always shown (second line below name)
   - **Content**: Compact subjects summary (see **RBACDisplay.subjectsSummary** below)

#### Row Actions (Context Menu)

- **View YAML**: Opens YAML viewer (server-backed, deferred feature)
- **Divider**
- **Delete clusterrolebinding**: Dangerous action; opens confirm sheet with exact kubectl command:
  ```
  kubectl delete clusterrolebinding <name>
  ```
  - Action block: `{"kind":"deleteResource","name":"<name>","resourceKind":"clusterrolebinding","label":"Delete ClusterRoleBinding <name>"}`

---

## 4. Helper Functions (rbacDisplay.ts)

All display helpers are **pure functions** suitable for vitest. Mirrors the Swift `RBACDisplay` enum and sorting logic from `RBACViewModel.swift`.

### RBACDisplay.subjectsSummary(subjects: Subject[] | undefined): string

Compact formatting of the subject list (used in RoleBinding/ClusterRoleBinding detail rows).

**Logic**:
1. Return `"no subjects"` if `subjects` is null/undefined or empty
2. For each subject:
   - Extract `kind` (default `"?"` if missing), lowercase it, and abbreviate `"ServiceAccount"` → `"sa"`
   - If subject has a `namespace`, format as `"<kind>:<namespace>/<name>"`
   - Otherwise format as `"<kind>:<name>"`
3. Join the first 3 subjects with `", "`
4. If more than 3 subjects, append `" +<remaining>"` (e.g., `" +2"` for 5 total)

**Examples**:
- `[{kind: "ServiceAccount", name: "default", namespace: "default"}]`
  → `"sa:default/default"`
- `[{kind: "User", name: "alice"}, {kind: "User", name: "bob"}, {kind: "Group", name: "admin"}, {kind: "ServiceAccount", name: "webhook", namespace: "kube-system"}]`
  → `"user:alice, user:bob, group:admin +1"`
- `null` → `"no subjects"`

### rulesSummary(rules: PolicyRule[] | undefined): string

Compact display of policy rules (used optionally in expandable detail).

**Logic**:
1. Return empty string or `"no rules"` if `rules` is null/undefined or empty
2. For each rule:
   - **apiGroups**: Join with `", "`. If empty or `[""]`, display as `"core"`. If `["*"]`, display as `"*"`.
   - **resources**: Join with `", "`. If `["*"]`, display as `"*"`.
   - **verbs**: Join with `", "`. If `["*"]`, display as `"*"`.
   - Format as: `"<apiGroups> <resources> <verbs>"`
3. Join all rules with newline + indent (for multi-line display in expanded sections)

**Examples**:
```
apiGroups: [""]  resources: ["pods"]  verbs: ["get", "list"]
  → "core pods get,list"

apiGroups: ["apps"]  resources: ["deployments"]  verbs: ["*"]
  → "apps deployments *"

apiGroups: ["*"]  resources: ["*"]  verbs: ["*"]
  → "* * *"
```

### matchesSearch(searchFields: (string | undefined)[], query: string): boolean

Case-insensitive substring match for filtering.

**Logic**:
1. Trim and lowercase the query; return `true` if empty
2. Flatten searchFields into a space-separated haystack (excluding undefined/null)
3. Return `true` if haystack (lowercased) contains the lowercased query as a substring

**Example**:
```
matchesSearch(["pod-reader", "default", "get,list"], "pod")  → true
matchesSearch(["admin", "default"], "role")  → false
```

### sortByNamespaceName(items: Array<{ metadata: ObjectMeta }>): sorted array

Sort namespace-scoped resources (ServiceAccounts, Roles, RoleBindings).

**Logic**:
1. Sort by namespace (alphabetic), ascending
2. Then by name (lexicographic), ascending
3. Treat missing/undefined namespace as empty string `""`

### sortByName(items: Array<{ metadata: ObjectMeta }>): sorted array

Sort cluster-scoped resources (ClusterRoles, ClusterRoleBindings).

**Logic**:
1. Sort by name (lexicographic), ascending

---

## 5. User Actions & Mutations (DEFERRED)

### Read-Only Panel

This is a **READ-ONLY** panel. The following are intentionally NOT implemented:

- **View YAML** — Deferred stub (needs server YAML endpoint + viewer UI)
- **Delete <resource>** — Deferred stub (needs ConfirmSheet wiring + server action routes)

No action blocks are emitted by this panel. All deletions will be handled by a shared confirm sheet once mutations are wired (future feature).

When mutations are added, follow the pattern in `docs/parity/contracts.md` §1 for action-block format. Delete actions will emit:
```
{
  "kind": "deleteResource",
  "name": "<resource-name>",
  "namespace": "<namespace>" (if namespace-scoped),
  "resourceKind": "<serviceaccount|role|rolebinding|clusterrole|clusterrolebinding>",
  "label": "Delete <Kind> <name>"
}
```

---

## 6. Loading, Error, and Empty States

### Loading State
- **Indicator**: Spinning `LoaderCircle` icon in the header (when `isLoading === true`)
- **Behavior**: List continues to show previously cached data while loading

### Error State
- **Banner**: Red/destructive error banner appears above the list
- **Content**: Monospace font with full error message
- **Dismissal**: Non-dismissible (persists until error clears)

### Empty State
- **Visibility**: When filtered list is empty (0 results)
- **Behavior**: Blank scrollable area (no "no results" copy; mirrors Storage panel UX)
- **Context**: Users can clear search or change the kind toggle to see data

---

## 7. Namespace Filter Behavior

### Namespace-Scoped Kinds (ServiceAccounts, Roles, RoleBindings)

- **Subscription**: Re-subscribe when `namespaceFilter` changes
- **Filtering**: Filter the resource list to show only items in the active namespace
- **Ref**: `subscribe(kind, namespaceFilter ?? '*')`
- **Unsubscribe on unmount**: Critical to clean up watches

### Cluster-Scoped Kinds (ClusterRoles, ClusterRoleBindings)

- **Subscription**: Subscribe once with `'*'` on mount
- **Filtering**: No namespace filter applies; show all cluster-scoped resources
- **Ref**: `subscribe(kind, '*')`
- **Unsubscribe on unmount**: Critical to clean up watches

---

## 8. Implementation Checklist

### Components & Files
- [ ] `apps/web/src/panels/rbac/RbacPanel.tsx` — Main panel component
  - Kind toggle pills (default: ServiceAccounts)
  - Search field
  - Loading spinner
  - Error banner
  - Kind-specific lists/cards
  - Context menu stubs (View YAML, Delete — actions deferred)

- [ ] `apps/web/src/panels/rbac/rbacDisplay.ts` — Pure display helpers
  - `subjectsSummary(subjects)` — Format subjects list
  - `rulesSummary(rules)` — Format rules (optional)
  - `matchesSearch(fields, query)` — Case-insensitive substring match
  - `sortByNamespaceName(items)` — Sort namespace-scoped resources
  - `sortByName(items)` — Sort cluster-scoped resources

- [ ] `apps/web/src/panels/rbac/types.ts` — TypeScript interfaces (mirrors Swift types)
  - `ObjectMeta`, `PolicyRule`, `RoleRef`, `Subject`
  - `ServiceAccount`, `Role`, `ClusterRole`, `RoleBinding`, `ClusterRoleBinding`
  - `RbacKind` type union

### Integration
- [ ] Update `apps/web/src/App.tsx`:
  - Import `RbacPanel` component
  - Add `"rbac"` to `PANELS` array
  - Add route: `<Route path="/rbac" element={<div className="h-full overflow-auto p-4"><RbacPanel /></div>} />`

### Testing
- [ ] `apps/web/src/panels/rbac/__tests__/rbacDisplay.test.ts`
  - Unit tests for `subjectsSummary()` (basic, edge cases, truncation)
  - Unit tests for `matchesSearch()` (various queries and fields)
  - Unit tests for sorting functions
  - Vitest convention: use `.test.ts` extension, co-locate with implementation

### Verification
- [ ] `pnpm --filter web typecheck` — No TS errors
- [ ] `pnpm --filter web build` — Build succeeds
- [ ] `pnpm --filter web test` — All vitest pass
- [ ] `pnpm --filter @helmsman/server test` — Server tests pass
- [ ] Manual smoke test:
  - Navigate to `/rbac` in the web app
  - Confirm all five kind tabs are visible and clickable
  - Verify resources load from store
  - Test search across each kind
  - Confirm namespace filter affects only namespace-scoped kinds
  - Verify context menu stubs are present (not functional yet)

---

## 9. kubectl Commands Reference

All commands use the active context (passed by the server):

### ServiceAccounts
```bash
# List all ServiceAccounts (all namespaces)
kubectl get serviceaccounts -A -o json

# List ServiceAccounts in a specific namespace
kubectl get serviceaccounts -n <namespace> -o json

# Delete a ServiceAccount (requires ConfirmSheet + server mutation route)
kubectl delete serviceaccount <name> -n <namespace>
```

### Roles
```bash
# List all Roles (all namespaces)
kubectl get roles -A -o json

# List Roles in a specific namespace
kubectl get roles -n <namespace> -o json

# Delete a Role (requires ConfirmSheet + server mutation route)
kubectl delete role <name> -n <namespace>
```

### RoleBindings
```bash
# List all RoleBindings (all namespaces)
kubectl get rolebindings -A -o json

# List RoleBindings in a specific namespace
kubectl get rolebindings -n <namespace> -o json

# Delete a RoleBinding (requires ConfirmSheet + server mutation route)
kubectl delete rolebinding <name> -n <namespace>
```

### ClusterRoles
```bash
# List all ClusterRoles
kubectl get clusterroles -o json

# Delete a ClusterRole (requires ConfirmSheet + server mutation route)
kubectl delete clusterrole <name>
```

### ClusterRoleBindings
```bash
# List all ClusterRoleBindings
kubectl get clusterrolebindings -o json

# Delete a ClusterRoleBinding (requires ConfirmSheet + server mutation route)
kubectl delete clusterrolebinding <name>
```

---

## 10. Design Decisions & Deviations

### Consistent with Storage & Workloads Panels
- Multi-kind toggle with per-kind filtering
- Kind-aware subscriptions (namespace vs. cluster scope)
- Card-based layout with expandable detail (for rules/subjects)
- Shared search and namespace filter behavior

### Expandable Detail for Rules & Subjects
- Rules (Roles/ClusterRoles) and subjects (RoleBindings/ClusterRoleBindings) are rendered in expandable detail sections
- Keeps the main row compact while allowing inspection of complex data
- Mirrors the Services panel's expandable port/selector display pattern

### Display Helpers (Pure Functions)
- All formatting logic is testable pure functions (no component coupling)
- Follows the vitest convention established by `storageDisplay.ts` and `podsDisplay.ts`
- Enables easy unit testing of edge cases (null/undefined, large counts, special characters)

### Read-Only Status
- No mutations in the initial port
- Context menu stubs clearly mark what is deferred
- Mutation UX (ConfirmSheet) will be added in a follow-up when the server mutation routes are ready

---

## 11. Summary

The RBAC panel is a multi-kind, mixed-scope read-only viewer that presents Kubernetes role-based access control resources. It mirrors the five core RBAC kinds (ServiceAccounts, Roles, RoleBindings, ClusterRoles, ClusterRoleBindings) with kind-aware subscriptions, search-based filtering, and namespace awareness. Expandable details allow users to inspect rules and subject lists without cluttering the main view. The implementation reuses the established multi-kind pattern from Storage and Workloads panels and adheres to the shared display-helper + vitest convention for maintainability.

