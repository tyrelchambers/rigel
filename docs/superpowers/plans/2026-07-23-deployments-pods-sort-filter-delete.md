# Deployments & Pods sort/filter + delete deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-facing sort and status/phase filtering to the Deployments and Pods panels, and wire a Delete action into the Deployments row menu.

**Architecture:** One new shared `PanelSort` control (field `<select>` + direction toggle) plus a shared `applySort` helper; each panel supplies its own ascending comparators and status predicates from its existing `*Display.ts` module. Delete reuses the already-shipped `deleteWorkload` action block and `ConfirmSheet` — no backend change.

**Tech Stack:** React 19 + TypeScript, Tailwind v4, Vitest + @testing-library/react, Font Awesome Pro icons.

---

## File Structure

- `apps/web/src/panels/components/PanelSort.tsx` — **new.** Shared sort control, `SortOption<T>` type, `applySort<T>` helper.
- `apps/web/src/panels/components/PanelSort.test.tsx` — **new.** `applySort` unit tests + a render/interaction test.
- `apps/web/src/panels/deployments/deploymentDisplay.ts` — add `deploymentSortOptions`, `matchesStatus`.
- `apps/web/src/panels/deployments/deploymentDisplay.test.ts` — add tests (create if absent).
- `apps/web/src/panels/deployments/DeploymentRow.tsx` — add Delete… menu item.
- `apps/web/src/panels/deployments/DeploymentsPanel.tsx` — sort + status-filter state, header controls.
- `apps/web/src/panels/pods/podDisplay.ts` — add `podSortOptions`, `matchesPhase`.
- `apps/web/src/panels/pods/podDisplay.test.ts` — add tests (file exists).
- `apps/web/src/panels/pods/PodsPanel.tsx` — sort + phase-filter state, header controls.

Commands (repo convention — no dev server):
- Test one file: `pnpm --filter web exec vitest run <path>`
- Typecheck: `pnpm --filter web typecheck`
- Build: `pnpm --filter web build`

---

## Task 1: Delete deployment from the row menu

**Files:**
- Modify: `apps/web/src/panels/deployments/DeploymentRow.tsx:91-95`

Note: `setPendingAction` is already a prop on `DeploymentRow`, and `ConfirmSheet`
is already mounted in `DeploymentsPanel`. `deleteWorkload` is already a valid
`ActionBlock` kind (see `apps/CONTRACTS.md` + `packages/k8s/src/actionBlocks.ts`).
This task is UI-only.

- [ ] **Step 1: Add the destructive Delete… item**

In `DeploymentRow.tsx`, inside `rowMenu`, replace the final YAML/Manage group
(currently lines 91-95) with the same block plus a Delete item and separator:

```tsx
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => viewYaml("deployment", d.metadata.name, d.metadata.namespace)}>View YAML…</ContextMenuItem>
      <ContextMenuItem onClick={() => editYaml("deployment", d.metadata.name, d.metadata.namespace)}>Edit YAML…</ContextMenuItem>
      <ContextMenuItem onClick={() => setMoveTarget(d)}>Move to namespace…</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onClick={() =>
          setPendingAction({
            kind: "deleteWorkload",
            name: d.metadata.name,
            namespace: d.metadata.namespace ?? "default",
            destructive: true,
            label: `Delete deployment ${d.metadata.name}`,
          })
        }
      >
        Delete…
      </ContextMenuItem>
      <ContextMenuItem onClick={() => toggleExpand(d)}>{isOpen ? "Collapse" : "Manage…"}</ContextMenuItem>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS (no errors). `deleteWorkload` with `name`/`namespace`/`destructive`/`label` matches the `ActionBlock` union.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels/deployments/DeploymentRow.tsx
git commit -m "feat(deployments): delete deployment from row menu"
```

---

## Task 2: Shared PanelSort control + applySort

**Files:**
- Create: `apps/web/src/panels/components/PanelSort.tsx`
- Create: `apps/web/src/panels/components/PanelSort.test.tsx`

- [ ] **Step 1: Write the failing test for applySort**

Create `apps/web/src/panels/components/PanelSort.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PanelSort, applySort, type SortOption } from "./PanelSort";

interface Item { name: string; n: number }
const byN: SortOption<Item> = { value: "n", label: "N", compare: (a, b) => a.n - b.n || a.name.localeCompare(b.name) };
const items: Item[] = [
  { name: "b", n: 2 },
  { name: "a", n: 2 },
  { name: "c", n: 1 },
];

describe("applySort", () => {
  it("sorts ascending with the option comparator", () => {
    expect(applySort(items, byN, "asc").map((i) => i.name)).toEqual(["c", "a", "b"]);
  });
  it("reverses for descending", () => {
    expect(applySort(items, byN, "desc").map((i) => i.name)).toEqual(["b", "a", "c"]);
  });
  it("returns items unchanged when option is undefined", () => {
    expect(applySort(items, undefined, "asc")).toEqual(items);
  });
});

describe("PanelSort", () => {
  it("toggles direction when the button is clicked", () => {
    const onDir = vi.fn();
    render(
      <PanelSort
        options={[byN]}
        value="n"
        onValueChange={() => {}}
        direction="asc"
        onDirectionChange={onDir}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /sort direction/i }));
    expect(onDir).toHaveBeenCalledWith("desc");
  });
});
```

Add `import { vi } from "vitest";` to the imports (merge with the existing vitest import line: `import { describe, it, expect, vi } from "vitest";`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter web exec vitest run src/panels/components/PanelSort.test.tsx`
Expected: FAIL — cannot resolve `./PanelSort`.

- [ ] **Step 3: Implement PanelSort**

Create `apps/web/src/panels/components/PanelSort.tsx`:

```tsx
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUp, faArrowDown } from "@awesome.me/kit-6050953220/icons/classic/solid";

export interface SortOption<T> {
  value: string;
  label: string;
  /** Ascending comparator; include a stable tiebreak (e.g. name). */
  compare: (a: T, b: T) => number;
}

export interface PanelSortProps<T> {
  options: SortOption<T>[];
  value: string;
  onValueChange: (v: string) => void;
  direction: "asc" | "desc";
  onDirectionChange: (d: "asc" | "desc") => void;
}

/** Apply an option's ascending comparator, reversing for descending. */
export function applySort<T>(
  items: T[],
  option: SortOption<T> | undefined,
  direction: "asc" | "desc",
): T[] {
  if (!option) return items;
  const sorted = [...items].sort(option.compare);
  return direction === "desc" ? sorted.reverse() : sorted;
}

const selectClass =
  "h-8 max-w-44 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/50";

export function PanelSort<T>({
  options,
  value,
  onValueChange,
  direction,
  onDirectionChange,
}: PanelSortProps<T>) {
  return (
    <div className="flex items-center gap-1">
      <select
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        aria-label="Sort by"
        className={selectClass}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            Sort: {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label="Sort direction"
        title={direction === "asc" ? "Ascending" : "Descending"}
        onClick={() => onDirectionChange(direction === "asc" ? "desc" : "asc")}
        className="flex h-8 w-8 items-center justify-center rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] text-foreground outline-none hover:bg-[var(--surface-elevated)] focus:ring-2 focus:ring-ring/50"
      >
        <FontAwesomeIcon icon={direction === "asc" ? faArrowUp : faArrowDown} className="text-xs" />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter web exec vitest run src/panels/components/PanelSort.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/components/PanelSort.tsx apps/web/src/panels/components/PanelSort.test.tsx
git commit -m "feat(panels): shared PanelSort control + applySort helper"
```

---

## Task 3: Deployment sort options + status predicate

**Files:**
- Modify: `apps/web/src/panels/deployments/deploymentDisplay.ts` (append near `sortDeployments`, line ~266)
- Create/Modify: `apps/web/src/panels/deployments/deploymentDisplay.test.ts`

- [ ] **Step 1: Write the failing tests**

Create (or append to) `apps/web/src/panels/deployments/deploymentDisplay.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deploymentSortOptions, matchesStatus } from "./deploymentDisplay";
import type { Deployment } from "./types";
import type { Pod } from "../pods/types";

function dep(over: Partial<Deployment>): Deployment {
  return {
    metadata: { name: "x", namespace: "default" },
    spec: { replicas: 1 },
    status: { replicas: 1, readyReplicas: 1 },
    ...over,
  } as Deployment;
}

const optByValue = (v: string) => deploymentSortOptions([]).find((o) => o.value === v)!;

describe("deploymentSortOptions", () => {
  it("sorts by replicas ascending", () => {
    const a = dep({ metadata: { name: "a" }, spec: { replicas: 3 } });
    const b = dep({ metadata: { name: "b" }, spec: { replicas: 1 } });
    const sorted = [a, b].sort(optByValue("replicas").compare);
    expect(sorted.map((d) => d.metadata.name)).toEqual(["b", "a"]);
  });

  it("namespace option breaks ties by name", () => {
    const a = dep({ metadata: { name: "b", namespace: "ns" } });
    const b = dep({ metadata: { name: "a", namespace: "ns" } });
    const sorted = [a, b].sort(optByValue("namespace").compare);
    expect(sorted.map((d) => d.metadata.name)).toEqual(["a", "b"]);
  });
});

describe("matchesStatus", () => {
  const pods: Pod[] = [];
  it("all matches everything", () => {
    expect(matchesStatus(dep({}), pods, "all")).toBe(true);
  });
  it("unhealthy matches when not fully ready", () => {
    const d = dep({ status: { replicas: 2, readyReplicas: 1 } });
    expect(matchesStatus(d, pods, "unhealthy")).toBe(true);
    expect(matchesStatus(dep({}), pods, "unhealthy")).toBe(false);
  });
  it("paused matches spec.paused", () => {
    expect(matchesStatus(dep({ spec: { replicas: 1, paused: true } }), pods, "paused")).toBe(true);
    expect(matchesStatus(dep({}), pods, "paused")).toBe(false);
  });
  it("zero matches scaled-to-zero", () => {
    expect(matchesStatus(dep({ spec: { replicas: 0 } }), pods, "zero")).toBe(true);
    expect(matchesStatus(dep({}), pods, "zero")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web exec vitest run src/panels/deployments/deploymentDisplay.test.ts`
Expected: FAIL — `deploymentSortOptions`/`matchesStatus` not exported.

- [ ] **Step 3: Implement the options + predicate**

Append to `apps/web/src/panels/deployments/deploymentDisplay.ts` (after `sortDeployments`).
Add `SortOption` to the imports at the top:

```ts
import type { SortOption } from "@/panels/components/PanelSort";
```

Then:

```ts
/** Ready fraction (0..1) for sort; 0 when no desired replicas. */
function readyFraction(d: Deployment): number {
  const total = totalReplicas(d);
  return total > 0 ? (d.status?.readyReplicas ?? 0) / total : 0;
}

const byName = (a: Deployment, b: Deployment) => a.metadata.name.localeCompare(b.metadata.name);
const ageMs = (d: Deployment) => Date.parse(d.metadata.creationTimestamp ?? "") || 0;

/**
 * Sort options for the Deployments panel. `pods` is the panel's live child-pod
 * list, needed only by the Restarts comparator (closes over it).
 */
export function deploymentSortOptions(pods: Pod[]): SortOption<Deployment>[] {
  return [
    { value: "namespace", label: "Namespace", compare: (a, b) => (a.metadata.namespace ?? "default").localeCompare(b.metadata.namespace ?? "default") || byName(a, b) },
    { value: "name", label: "Name", compare: byName },
    { value: "ready", label: "Ready", compare: (a, b) => readyFraction(a) - readyFraction(b) || byName(a, b) },
    { value: "replicas", label: "Replicas", compare: (a, b) => desiredReplicas(a) - desiredReplicas(b) || byName(a, b) },
    { value: "restarts", label: "Restarts", compare: (a, b) => totalRestarts(a, pods) - totalRestarts(b, pods) || byName(a, b) },
    { value: "age", label: "Age", compare: (a, b) => ageMs(a) - ageMs(b) || byName(a, b) },
  ];
}

/** Status filter predicate. `status` is a value from the filter dropdown. */
export function matchesStatus(d: Deployment, pods: Pod[], status: string): boolean {
  switch (status) {
    case "unhealthy": return !isReady(d);
    case "paused": return d.spec?.paused === true;
    case "zero": return desiredReplicas(d) === 0;
    case "rollingOut": return isRedeploying(d, pods);
    default: return true; // "all"
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web exec vitest run src/panels/deployments/deploymentDisplay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/deployments/deploymentDisplay.ts apps/web/src/panels/deployments/deploymentDisplay.test.ts
git commit -m "feat(deployments): sort options + status filter predicate"
```

---

## Task 4: Wire sort + status filter into DeploymentsPanel

**Files:**
- Modify: `apps/web/src/panels/deployments/DeploymentsPanel.tsx`

- [ ] **Step 1: Import the control and helpers**

In `DeploymentsPanel.tsx`, extend the existing import from `./deploymentDisplay`
(currently `desiredReplicas, matchesSearch, sortDeployments, namespaceOptions`)
to add `deploymentSortOptions` and `matchesStatus`, and add:

```tsx
import { PanelSort, applySort } from "@/panels/components/PanelSort";
```

- [ ] **Step 2: Add state**

Below the existing `const [search, setSearch] = useState("");` add:

```tsx
  const [sortValue, setSortValue] = useState("namespace");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [statusFilter, setStatusFilter] = useState("all");
```

- [ ] **Step 3: Replace the fixed sort with option-driven sort**

Replace the current `allDeployments` memo (which wraps `sortDeployments(...)`)
with an unsorted list + sort options + a sorted list:

```tsx
  const allDeployments = useMemo(
    () => Object.values((resources["deployments"] ?? {}) as Record<string, Deployment>),
    [resources],
  );
  const allPods = useMemo(
    () => Object.values((resources["pods"] ?? {}) as Record<string, Pod>),
    [resources],
  );
  const sortOptions = useMemo(() => deploymentSortOptions(allPods), [allPods]);
```

Then update the `filtered` memo to filter first, then sort, and to include the
status filter:

```tsx
  const filtered = useMemo(() => {
    const matched = allDeployments.filter(
      (d) =>
        (!namespaceFilter || d.metadata.namespace === namespaceFilter) &&
        matchesSearch(d, search) &&
        matchesStatus(d, allPods, statusFilter),
    );
    return applySort(matched, sortOptions.find((o) => o.value === sortValue), sortDir);
  }, [allDeployments, allPods, search, namespaceFilter, statusFilter, sortOptions, sortValue, sortDir]);
```

Remove the now-unused `sortDeployments` import from the `./deploymentDisplay`
import list. Note `useFocusRow`/the `key` helper still operate on
`allDeployments` (unsorted) — that is fine, they look up by key.

- [ ] **Step 4: Add the header controls**

In the `PanelHeader` children, after `PanelSearch`, add the status `<select>`
(styled like the Pods node filter) and the `PanelSort`:

```tsx
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
          className="h-8 max-w-44 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/50"
        >
          <option value="all">All statuses</option>
          <option value="unhealthy">Unhealthy</option>
          <option value="paused">Paused</option>
          <option value="zero">Scaled to zero</option>
          <option value="rollingOut">Rolling out</option>
        </select>
        <PanelSort
          options={sortOptions}
          value={sortValue}
          onValueChange={setSortValue}
          direction={sortDir}
          onDirectionChange={setSortDir}
        />
```

- [ ] **Step 5: Typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: PASS. No unused-import errors (confirm `sortDeployments` import was removed).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/deployments/DeploymentsPanel.tsx
git commit -m "feat(deployments): sort + status filter controls in panel header"
```

---

## Task 5: Pod sort options + phase predicate

**Files:**
- Modify: `apps/web/src/panels/pods/podDisplay.ts` (append near `sortPods`, line ~140)
- Modify: `apps/web/src/panels/pods/podDisplay.test.ts`

Note: CPU/Mem sort needs a live metric value the panel holds in
`metricsHistory` (not on the `Pod` object). To keep `podSortOptions` pure and
testable, it takes an optional metric accessor; the panel passes one when
metrics are available, and omits the CPU/Mem options otherwise.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/panels/pods/podDisplay.test.ts`:

```ts
import { podSortOptions, matchesPhase } from "./podDisplay";

function pod(over: Partial<Pod>): Pod {
  return { metadata: { name: "x", namespace: "default" }, status: { phase: "Running" }, ...over } as Pod;
}

describe("podSortOptions", () => {
  it("omits CPU/Mem options when no metric accessor is given", () => {
    const values = podSortOptions().map((o) => o.value);
    expect(values).not.toContain("cpu");
    expect(values).not.toContain("mem");
  });
  it("includes CPU/Mem when a metric accessor is given", () => {
    const values = podSortOptions(() => ({ cpu: 0, mem: 0 })).map((o) => o.value);
    expect(values).toContain("cpu");
    expect(values).toContain("mem");
  });
  it("sorts by restarts ascending", () => {
    const a = pod({ metadata: { name: "a" }, status: { phase: "Running", containerStatuses: [{ name: "c", ready: true, restartCount: 5 } as any] } });
    const b = pod({ metadata: { name: "b" }, status: { phase: "Running", containerStatuses: [{ name: "c", ready: true, restartCount: 1 } as any] } });
    const opt = podSortOptions().find((o) => o.value === "restarts")!;
    expect([a, b].sort(opt.compare).map((p) => p.metadata.name)).toEqual(["b", "a"]);
  });
});

describe("matchesPhase", () => {
  it("all matches everything", () => {
    expect(matchesPhase(pod({}), "all")).toBe(true);
  });
  it("failed matches Failed phase", () => {
    expect(matchesPhase(pod({ status: { phase: "Failed" } }), "failed")).toBe(true);
    expect(matchesPhase(pod({}), "failed")).toBe(false);
  });
  it("notReady matches when a container is not ready", () => {
    const p = pod({ status: { phase: "Running", containerStatuses: [{ name: "c", ready: false, restartCount: 0 } as any] } });
    expect(matchesPhase(p, "notReady")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web exec vitest run src/panels/pods/podDisplay.test.ts`
Expected: FAIL — `podSortOptions`/`matchesPhase` not exported.

- [ ] **Step 3: Implement the options + predicate**

Add `SortOption` import at the top of `apps/web/src/panels/pods/podDisplay.ts`:

```ts
import type { SortOption } from "@/panels/components/PanelSort";
```

Append (after `sortPods`; reuses `podHasError` — import it from the deployments
module where it already lives, or move it. Simplest: add
`import { podHasError } from "../deployments/deploymentDisplay";`):

```ts
const byPodName = (a: Pod, b: Pod) => a.metadata.name.localeCompare(b.metadata.name);
const podAgeMs = (p: Pod) => Date.parse(p.metadata.creationTimestamp ?? "") || 0;

/** Current CPU (millicores) and memory (Mi) for a pod, from the panel's metrics history. */
export interface PodMetric { cpu: number; mem: number }

/**
 * Sort options for the Pods panel. Pass `metric` (a per-pod current-usage
 * accessor) only when metrics are available; when omitted, the CPU and Mem
 * options are excluded.
 */
export function podSortOptions(metric?: (p: Pod) => PodMetric): SortOption<Pod>[] {
  const options: SortOption<Pod>[] = [
    { value: "namespace", label: "Namespace", compare: (a, b) => (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "") || byPodName(a, b) },
    { value: "name", label: "Name", compare: byPodName },
    { value: "phase", label: "Phase", compare: (a, b) => (a.status?.phase ?? "").localeCompare(b.status?.phase ?? "") || byPodName(a, b) },
    { value: "restarts", label: "Restarts", compare: (a, b) => restartCount(a) - restartCount(b) || byPodName(a, b) },
    { value: "age", label: "Age", compare: (a, b) => podAgeMs(a) - podAgeMs(b) || byPodName(a, b) },
    { value: "node", label: "Node", compare: (a, b) => (a.spec?.nodeName ?? "").localeCompare(b.spec?.nodeName ?? "") || byPodName(a, b) },
  ];
  if (metric) {
    options.push(
      { value: "cpu", label: "CPU", compare: (a, b) => metric(a).cpu - metric(b).cpu || byPodName(a, b) },
      { value: "mem", label: "Mem", compare: (a, b) => metric(a).mem - metric(b).mem || byPodName(a, b) },
    );
  }
  return options;
}

/** Phase filter predicate. `phase` is a value from the filter dropdown. */
export function matchesPhase(pod: Pod, phase: string): boolean {
  const statuses = pod.status?.containerStatuses ?? [];
  switch (phase) {
    case "running": return pod.status?.phase === "Running";
    case "pending": return pod.status?.phase === "Pending";
    case "failed": return pod.status?.phase === "Failed";
    case "notReady": return statuses.length > 0 && !statuses.every((c) => c.ready);
    case "crashloop": return podHasError(pod);
    default: return true; // "all"
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web exec vitest run src/panels/pods/podDisplay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/pods/podDisplay.ts apps/web/src/panels/pods/podDisplay.test.ts
git commit -m "feat(pods): sort options + phase filter predicate"
```

---

## Task 6: Wire sort + phase filter into PodsPanel

**Files:**
- Modify: `apps/web/src/panels/pods/PodsPanel.tsx`

- [ ] **Step 1: Imports**

Add to `PodsPanel.tsx`:

```tsx
import { PanelSort, applySort } from "@/panels/components/PanelSort";
```

Extend the existing import from `./podDisplay` to add `podSortOptions` and
`matchesPhase`, and drop `sortPods` (replaced below).

- [ ] **Step 2: Add state**

Below `const [nodeFilter, setNodeFilter] = useState("");` add:

```tsx
  const [sortValue, setSortValue] = useState("namespace");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [phaseFilter, setPhaseFilter] = useState("all");
```

- [ ] **Step 3: Build sort options with the metric accessor**

The panel already has `metricsAvailable` and `metricsHistory` (a `Map` keyed by
`` `${namespace}/${name}` ``, values with `cpuNow`/`memNow`). Build options after
those are in scope:

```tsx
  const sortOptions = useMemo(
    () =>
      podSortOptions(
        metricsAvailable
          ? (p: Pod) => {
              const m = metricsHistory.get(`${p.metadata.namespace ?? ""}/${p.metadata.name}`);
              return { cpu: m?.cpuNow ?? 0, mem: m?.memNow ?? 0 };
            }
          : undefined,
      ),
    [metricsAvailable, metricsHistory],
  );
```

Reset `sortValue` to `"namespace"` if the selected option disappears (e.g. CPU
sort selected, then metrics drop):

```tsx
  useEffect(() => {
    if (!sortOptions.some((o) => o.value === sortValue)) setSortValue("namespace");
  }, [sortOptions, sortValue]);
```

- [ ] **Step 4: Replace fixed sort in allPods, apply sort after filtering**

Change `allPods` to drop `sortPods` (keep it unsorted, namespace-scoped):

```tsx
  const allPods = useMemo(
    () => filterByNamespace(resources["pods"], namespaceFilter) as Pod[],
    [resources, namespaceFilter],
  );
```

Update `filtered` to add the phase filter and apply the sort last:

```tsx
  const filtered = useMemo(() => {
    const matched = allPods.filter(
      (p) => matchesSearch(p, search) && matchesNode(p, nodeFilter) && matchesPhase(p, phaseFilter),
    );
    return applySort(matched, sortOptions.find((o) => o.value === sortValue), sortDir);
  }, [allPods, search, nodeFilter, phaseFilter, sortOptions, sortValue, sortDir]);
```

- [ ] **Step 5: Add header controls**

In `PanelHeader`, after the existing node `<select>`, add the phase filter and
`PanelSort`:

```tsx
        <select
          value={phaseFilter}
          onChange={(e) => setPhaseFilter(e.target.value)}
          aria-label="Filter by phase"
          className="h-8 max-w-44 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/50"
        >
          <option value="all">All phases</option>
          <option value="running">Running</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
          <option value="notReady">Not ready</option>
          <option value="crashloop">CrashLoop</option>
        </select>
        <PanelSort
          options={sortOptions}
          value={sortValue}
          onValueChange={setSortValue}
          direction={sortDir}
          onDirectionChange={setSortDir}
        />
```

- [ ] **Step 6: Typecheck + build + full web test**

Run: `pnpm --filter web typecheck && pnpm --filter web build && pnpm --filter web test`
Expected: PASS. Confirm `sortPods` import removed (no unused-import error).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/panels/pods/PodsPanel.tsx
git commit -m "feat(pods): sort + phase filter controls in panel header"
```

---

## Self-review notes

- **Spec coverage:** Delete (Task 1) ✓; shared sort control + applySort (Task 2) ✓;
  deployment sort options + status predicate (Task 3) ✓; deployment panel wiring (Task 4) ✓;
  pod sort options + phase predicate + CPU/Mem-when-available (Task 5) ✓; pod panel wiring (Task 6) ✓.
- **Type consistency:** `SortOption<T>`/`applySort`/`PanelSort` defined in Task 2 are
  used unchanged in Tasks 3-6. `deploymentSortOptions(pods)` and
  `podSortOptions(metric?)` signatures match their call sites in the panels.
  `matchesStatus(d, pods, status)` and `matchesPhase(pod, phase)` match.
- **`sortPods`/`sortDeployments`:** left in place (still used by `sortDeployments`
  callers if any; Task 4/6 only remove the panel's own import). Grep before
  deleting either export — out of scope here.
- **`podHasError` location:** currently exported from `deploymentDisplay.ts`;
  Task 5 imports it from there. If a reviewer prefers, moving it to `podDisplay.ts`
  is a valid cleanup but not required.
