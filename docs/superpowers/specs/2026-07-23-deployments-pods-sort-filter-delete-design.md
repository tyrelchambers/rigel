# Deployments & Pods: sort, status filter, and delete deployment

Date: 2026-07-23

## Goal

Add user-facing **sorting** and a **status/phase filter** to the Deployments and
Pods panels, and wire up **Delete deployment** (already supported end-to-end on
the backend, just missing from the UI).

Today both panels sort with a fixed namespace→name order and only filter
structurally (text search everywhere; a node dropdown on Pods). Operators
usually hunt by *state* ("show me the unhealthy ones", "sort by restarts"), which
neither panel supports.

## Scope

1. Delete deployment from the Deployments row menu.
2. A shared sort dropdown (field + direction) in both panel headers.
3. A status/phase filter dropdown in both panel headers.

Out of scope: clickable column-header sorting (these are `ListRow` lists, not
tables), saved/persisted sort preferences, multi-column sort.

## 1. Delete deployment

`deleteWorkload` already exists in the action-block contract
(`apps/CONTRACTS.md`), in `packages/k8s/src/actionBlocks.ts`, and on the server
(`kubectl delete deployment …`). The only gap is the UI entry point.

- Add a destructive **Delete…** `ContextMenuItem` to `DeploymentRow`'s menu,
  after a `ContextMenuSeparator`, positioned like Pods' delete item (near the
  bottom, before the YAML/Manage group).
- It calls the panel's existing `setPendingAction` with:

  ```ts
  {
    kind: "deleteWorkload",
    name: d.metadata.name,
    namespace: d.metadata.namespace ?? "default",
    destructive: true,
    label: `Delete deployment ${d.metadata.name}`,
  }
  ```

- The existing `ConfirmSheet` in `DeploymentsPanel` renders the exact
  `kubectl delete` command and runs it. No new state, route, contract, or
  `actionBlocks.ts` change.
- This mirrors `PodsPanel.handleDelete` (`deletePod`) one-for-one.

## 2. Sort — shared `PanelSort` control

### Component (new, shared)

`apps/web/src/panels/components/PanelSort.tsx` — the single reusable renderer.

Props:

```ts
interface SortOption<T> {
  value: string;              // stable key, e.g. "restarts"
  label: string;              // "Restarts"
  compare: (a: T, b: T) => number; // ascending comparator
}

interface PanelSortProps<T> {
  options: SortOption<T>[];
  value: string;              // selected option value
  onValueChange: (v: string) => void;
  direction: "asc" | "desc";
  onDirectionChange: (d: "asc" | "desc") => void;
}
```

Renders a `<select>` (field) styled identically to the existing Pods node
filter, plus a small icon button that toggles ↑/↓ (Font Awesome
`arrow-up`/`arrow-down`, per the icon standard). Direction is applied by the
consumer, not inside the comparator (see below), so a single ascending
comparator per option is all each panel supplies.

### Sort application

A tiny shared helper keeps direction handling in one place:

```ts
// PanelSort.tsx (or a colocated helper)
export function applySort<T>(
  items: T[],
  option: SortOption<T> | undefined,
  direction: "asc" | "desc",
): T[] {
  if (!option) return items;
  const sorted = [...items].sort(option.compare);
  return direction === "desc" ? sorted.reverse() : sorted;
}
```

Every comparator uses a **name tiebreak** so equal keys stay stable, preserving
today's behavior when sorted by namespace.

### Per-panel options

Options + comparators live in the existing display modules, next to the current
`sortDeployments` / `sortPods` (which become the default option's comparator).

`deploymentDisplay.ts` — `deploymentSortOptions: SortOption<Deployment>[]`:

- **Namespace** (default) — namespace, then name. Reuses today's
  `sortDeployments` ordering.
- **Name** — name.
- **Ready** — `readyReplicas/total` fraction ascending (unhealthy first when
  ascending; helper `isReady`/`totalReplicas` already exist).
- **Replicas** — `desiredReplicas`.
- **Restarts** — `totalRestarts(d, pods)` (needs the panel's `allPods`; see note).
- **Age** — `metadata.creationTimestamp`.

`podDisplay.ts` — `podSortOptions: SortOption<Pod>[]`:

- **Namespace** (default) — namespace, then name. Reuses today's `sortPods`.
- **Name** — name.
- **Phase** — `status.phase`.
- **Restarts** — `restartCount(pod)`.
- **CPU** / **Mem** — current metric value; when metrics are unavailable these
  two options are omitted from the list the panel passes in (the panel already
  knows `metricsAvailable`).
- **Age** — `metadata.creationTimestamp`.
- **Node** — `spec.nodeName`.

Restart-sort note: `totalRestarts` needs the child pods, which the Deployments
panel already loads (`allPods`). The panel builds its `deploymentSortOptions`
with `allPods` in scope (via `useMemo`) so the comparator closes over it — no new
data plumbing.

### Panel state

Each panel adds `sortValue` (defaulting to `"namespace"`) and `sortDir`
(defaulting to `"asc"`), and replaces its current unconditional
`sortDeployments(...)` / `sortPods(...)` call with `applySort(...)`. Everything
downstream (search, namespace/node filter, status filter) runs on the sorted
list as it does today.

## 3. Status / phase filter

A second `<select>` in each header, styled exactly like the Pods node filter.
Composes with search and the namespace/node filter as **AND**.

### Deployments — `statusFilter`

Values → predicate (helpers already in `deploymentDisplay.ts`):

- `all` — everything (default).
- `unhealthy` — `!isReady(d)`.
- `paused` — `d.spec?.paused === true`.
- `zero` — `desiredReplicas(d) === 0` ("Scaled to zero").
- `rollingOut` — `isRedeploying(d, allPods)`.

### Pods — `phaseFilter`

Values → predicate (helpers already in `podDisplay.ts`):

- `all` — everything (default).
- `running` — `phase === "Running"`.
- `pending` — `phase === "Pending"`.
- `failed` — `phase === "Failed"`.
- `notReady` — has statuses and not all ready (`readyText` numerator < denominator).
- `crashloop` — `podHasError(pod)`.

### Implementation

Add a parameterized predicate resolver to each display module so the panel maps
the selected value to a predicate, e.g.:

```ts
// deploymentDisplay.ts
export function matchesStatus(d: Deployment, pods: Pod[], status: string): boolean { … }
// podDisplay.ts
export function matchesPhase(pod: Pod, phase: string): boolean { … }
```

The panels fold this into the existing `filtered` `useMemo` alongside
`matchesSearch` / `matchesNode`. A filter/sort that yields zero rows reuses the
current "No … match your filters" empty state.

## Files touched

- `apps/web/src/panels/components/PanelSort.tsx` — **new** shared control +
  `applySort` + `SortOption` type.
- `apps/web/src/panels/deployments/DeploymentsPanel.tsx` — sort/filter state,
  header controls, delete menu wiring passthrough.
- `apps/web/src/panels/deployments/DeploymentRow.tsx` — Delete… menu item.
- `apps/web/src/panels/deployments/deploymentDisplay.ts` — `deploymentSortOptions`,
  `matchesStatus`.
- `apps/web/src/panels/pods/PodsPanel.tsx` — sort/filter state, header controls.
- `apps/web/src/panels/pods/podDisplay.ts` — `podSortOptions`, `matchesPhase`.

## Testing

Vitest (`pnpm --filter web test`), pure-function focused per repo convention:

- `deploymentDisplay.test.ts`: each `deploymentSortOptions` comparator orders a
  fixture correctly; `applySort` respects direction and name tiebreak;
  `matchesStatus` for each status value (incl. `all`).
- `podDisplay.test.ts`: each `podSortOptions` comparator; `matchesPhase` for each
  value; CPU/Mem options absent when metrics unavailable.
- No live-cluster / mutation-endpoint execution (delete is verified via the
  action-block builder, already tested for `deleteWorkload`).

Verify build + typecheck: `pnpm --filter web build`, `pnpm --filter web typecheck`.

## Non-goals / deferrals

- Persisting sort/filter choices across sessions.
- Sorting by columns via header clicks.
- Bulk delete / multi-select.
