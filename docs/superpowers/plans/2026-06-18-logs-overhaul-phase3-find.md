# Logs overhaul — Phase 3 (Find & isolate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find and isolate the right logs — a kind selector (Deployments / StatefulSets / DaemonSets / Pods) with a sidebar search over the list, and click-a-pod-to-isolate within a multi-replica stream.

**Architecture:** A new pure `logTargets.ts` normalizes any of the four kinds into a uniform `SidebarItem` (name, namespace, status, and either a label selector or a single pod) and filters/sorts the list — so the sidebar UI is kind-agnostic. `LogsPanel` gets kind tabs + a search box, subscribes the active kind's watch, and `startStream` is generalized to take a `SidebarItem` (selector OR pod). Pod isolation reuses the client-side `filterLines` predicate (a new `pod` option, mirroring `container`). Spec: `docs/superpowers/specs/2026-06-18-logs-panel-overhaul-design.md` (Phase 3).

**Tech Stack:** React 19 + Vite + vitest, Tailwind v4, Zustand cluster store, lucide-react.

---

## File structure

- **Create** `apps/web/src/panels/logs/logTargets.ts` — `LogKind`, `LOG_KINDS`, `SidebarItem`, `buildSidebarItems(resources, kind, search)`.
- **Create** `apps/web/src/panels/logs/logTargets.test.ts` — tests for the above.
- **Modify** `apps/web/src/panels/logs/logDisplay.ts` — widen `labelSelector` param to a structural type (reused by `logTargets`); add `pod` to `FilterOptions` + `filterLines`.
- **Modify** `apps/web/src/panels/logs/logDisplay.test.ts` — `filterLines` pod-isolation test.
- **Modify** `apps/web/src/panels/logs/LogsPanel.tsx` — kind tabs, sidebar search, per-kind subscribe, generalized `startStream(item)`, pod-isolation chips.

**Verification:** vitest for pure logic; `pnpm --filter web typecheck && build`; Playwright re-drive + Docker rebuild; Outline doc.

**Convention:** reuse `labelSelector` (widened) and the existing `distinctPods` rather than forking; `filterLines` is extended (pod option), not duplicated.

---

## Task 1: `logTargets.ts` — normalize the four kinds (TDD)

**Files:**
- Modify: `apps/web/src/panels/logs/logDisplay.ts` (widen `labelSelector`)
- Create: `apps/web/src/panels/logs/logTargets.ts`
- Create: `apps/web/src/panels/logs/logTargets.test.ts`

- [ ] **Step 1: Widen `labelSelector`'s parameter** in `logDisplay.ts` so it works for any workload (Deployments + StatefulSets + DaemonSets share `spec.selector.matchLabels`). Replace the `labelSelector` signature + add the structural type. Change:
```ts
export function labelSelector(d: Deployment): string | null {
```
to:
```ts
/** Anything with `spec.selector.matchLabels` (Deployment/StatefulSet/DaemonSet). */
export interface Selectable {
  spec?: { selector?: { matchLabels?: Record<string, string> } };
}

export function labelSelector(d: Selectable): string | null {
```
(The body is unchanged — it already reads `d.spec?.selector?.matchLabels`. `Deployment` structurally satisfies `Selectable`, so existing callers/tests keep working.)

- [ ] **Step 2: Write the failing tests.** Create `apps/web/src/panels/logs/logTargets.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { LOG_KINDS, buildSidebarItems } from "./logTargets";

const resources = {
  deployments: {
    "default/web": {
      metadata: { name: "web", namespace: "default" },
      spec: { selector: { matchLabels: { app: "web" } } },
      status: { readyReplicas: 1, replicas: 2 },
    },
  },
  daemonsets: {
    "kube-system/fluentd": {
      metadata: { name: "fluentd", namespace: "kube-system" },
      spec: { selector: { matchLabels: { app: "fluentd" } } },
      status: { numberReady: 3, desiredNumberScheduled: 3 },
    },
  },
  pods: {
    "default/web-abc": {
      metadata: { name: "web-abc", namespace: "default" },
      status: { phase: "Running" },
    },
    "default/web-def": {
      metadata: { name: "web-def", namespace: "default" },
      status: { phase: "CrashLoopBackOff" },
    },
  },
};

describe("LOG_KINDS", () => {
  it("lists the four kinds, deployments first", () => {
    expect(LOG_KINDS.map((k) => k.kind)).toEqual(["deployments", "statefulsets", "daemonsets", "pods"]);
  });
});

describe("buildSidebarItems", () => {
  it("deployment → label selector + ready/total + unhealthy when not all ready", () => {
    const [it0] = buildSidebarItems(resources, "deployments", "");
    expect(it0).toMatchObject({
      key: "default/web", name: "web", namespace: "default",
      statusText: "1/2", unhealthy: true, selector: "app=web", pod: null,
    });
  });
  it("daemonset → numberReady/desired", () => {
    const [it0] = buildSidebarItems(resources, "daemonsets", "");
    expect(it0).toMatchObject({ statusText: "3/3", unhealthy: false, selector: "app=fluentd", pod: null });
  });
  it("pod → phase as status, pod set, no selector; unhealthy when not Running", () => {
    const items = buildSidebarItems(resources, "pods", "");
    expect(items.map((i) => i.name)).toEqual(["web-abc", "web-def"]);
    expect(items[0]).toMatchObject({ statusText: "Running", unhealthy: false, pod: "web-abc", selector: null });
    expect(items[1]).toMatchObject({ statusText: "CrashLoopBackOff", unhealthy: true, pod: "web-def" });
  });
  it("search filters by name/namespace (case-insensitive)", () => {
    expect(buildSidebarItems(resources, "pods", "DEF").map((i) => i.name)).toEqual(["web-def"]);
    expect(buildSidebarItems(resources, "pods", "kube").length).toBe(0);
  });
  it("empty kind → []", () => {
    expect(buildSidebarItems(resources, "statefulsets", "")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `pnpm --filter web test logTargets 2>&1 | tail -15`
Expected: FAIL — module `./logTargets` not found.

- [ ] **Step 4: Implement `logTargets.ts`:**
```ts
// Normalizes the four log-source kinds (Deployments / StatefulSets / DaemonSets
// / Pods) into a uniform SidebarItem so the Logs sidebar is kind-agnostic.
// Workloads stream via their label selector; pods stream by name.
import { labelSelector } from "./logDisplay";

export type LogKind = "deployments" | "statefulsets" | "daemonsets" | "pods";

/** Tab order + short labels for the sidebar kind selector. */
export const LOG_KINDS: { kind: LogKind; label: string }[] = [
  { kind: "deployments", label: "Deploy" },
  { kind: "statefulsets", label: "STS" },
  { kind: "daemonsets", label: "DS" },
  { kind: "pods", label: "Pods" },
];

/** A uniform sidebar row across all kinds. */
export interface SidebarItem {
  key: string;
  name: string;
  namespace: string;
  /** "ready/total" for workloads, pod phase for pods. */
  statusText: string;
  /** True when not fully ready / not Running (status shown in red). */
  unhealthy: boolean;
  /** Label selector to tail (workloads); null for pods. */
  selector: string | null;
  /** Pod name to tail (pods); null for workloads. */
  pod: string | null;
}

interface RawObj {
  metadata?: { name?: string; namespace?: string };
  spec?: { selector?: { matchLabels?: Record<string, string> } };
  status?: {
    readyReplicas?: number; replicas?: number;
    numberReady?: number; desiredNumberScheduled?: number;
    phase?: string;
  };
}

function statusFor(kind: LogKind, o: RawObj): { statusText: string; unhealthy: boolean } {
  if (kind === "pods") {
    const phase = o.status?.phase ?? "Unknown";
    return { statusText: phase, unhealthy: phase !== "Running" && phase !== "Succeeded" };
  }
  let ready = 0;
  let total = 0;
  if (kind === "daemonsets") {
    ready = o.status?.numberReady ?? 0;
    total = o.status?.desiredNumberScheduled ?? 0;
  } else {
    ready = o.status?.readyReplicas ?? 0;
    total = o.status?.replicas ?? 0;
  }
  return { statusText: `${ready}/${total}`, unhealthy: ready < total };
}

/** Build the sorted, search-filtered sidebar list for one kind. */
export function buildSidebarItems(
  resources: Record<string, Record<string, unknown>>,
  kind: LogKind,
  search: string,
): SidebarItem[] {
  const q = search.trim().toLowerCase();
  const raw = (resources[kind] ?? {}) as Record<string, RawObj>;
  const items: SidebarItem[] = [];
  for (const o of Object.values(raw)) {
    const name = o.metadata?.name ?? "";
    const namespace = o.metadata?.namespace ?? "default";
    if (q && !name.toLowerCase().includes(q) && !namespace.toLowerCase().includes(q)) continue;
    const { statusText, unhealthy } = statusFor(kind, o);
    items.push({
      key: `${namespace}/${name}`,
      name,
      namespace,
      statusText,
      unhealthy,
      selector: kind === "pods" ? null : labelSelector(o),
      pod: kind === "pods" ? name : null,
    });
  }
  return items.sort((a, b) =>
    a.namespace === b.namespace ? a.name.localeCompare(b.name) : a.namespace.localeCompare(b.namespace),
  );
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter web test logTargets && pnpm --filter web test logDisplay 2>&1 | tail -6`
Expected: PASS (both suites).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/logs/logTargets.ts apps/web/src/panels/logs/logTargets.test.ts apps/web/src/panels/logs/logDisplay.ts
git commit -m "feat(logs): logTargets — normalize Deployments/STS/DS/Pods into a uniform sidebar item"
```

---

## Task 2: `filterLines` pod isolation (TDD)

**Files:**
- Modify: `apps/web/src/panels/logs/logDisplay.ts` (`FilterOptions`, `filterLines`)
- Test: `apps/web/src/panels/logs/logDisplay.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `logDisplay.test.ts`:
```ts
describe("filterLines pod isolation", () => {
  const ls = [
    { id: "1", sourcePod: "web-a", timestamp: null, text: "a", colorIndex: 0 },
    { id: "2", sourcePod: "web-b", timestamp: null, text: "b", colorIndex: 0 },
  ];
  const base = { hideProbes: false, errorsOnly: false, query: buildLogQuery("", false) };
  it("keeps only the isolated pod when set", () => {
    expect(filterLines(ls, { ...base, pod: "web-b" }).map((l) => l.text)).toEqual(["b"]);
  });
  it("empty/undefined pod keeps everything", () => {
    expect(filterLines(ls, base).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter web test logDisplay 2>&1 | tail -12`
Expected: FAIL — `pod` not on `FilterOptions`.

- [ ] **Step 3: Implement.** In `logDisplay.ts`, add `pod?` to `FilterOptions` (after `container?`):
```ts
  /** When non-empty, keep only lines from this pod (client-side isolation). */
  pod?: string;
```
and add this predicate inside `filterLines`'s `.filter` (next to the container one):
```ts
    if (opts.pod && l.sourcePod !== opts.pod) return false;
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter web test logDisplay 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/logs/logDisplay.ts apps/web/src/panels/logs/logDisplay.test.ts
git commit -m "feat(logs): filterLines pod-isolation predicate"
```

---

## Task 3: Kind tabs + sidebar search + per-kind streaming (UI)

**Files:**
- Modify: `apps/web/src/panels/logs/LogsPanel.tsx`

(No unit test — logic covered by Tasks 1–2; verify typecheck/build.) READ the file first.

- [ ] **Step 1: Imports + state.** Add imports:
```tsx
import { type LogKind, LOG_KINDS, type SidebarItem, buildSidebarItems } from "./logTargets";
```
Add state (near the other `useState`s); REMOVE the old `selectedKey` usage will be replaced — keep a `selectedKey` for highlight but add kind + search + the selected item:
```tsx
  const [logKind, setLogKind] = useState<LogKind>("deployments");
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [selectedItem, setSelectedItem] = useState<SidebarItem | null>(null);
```

- [ ] **Step 2: Subscribe to the active kind (replace the hardcoded deployments subscribe).** Find the `useEffect` that does `subscribe("deployments", ns)` and change it to subscribe the active `logKind`:
```tsx
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe(logKind, ns);
    return () => unsubscribe(logKind, ns);
  }, [namespaceFilter, logKind]);
```

- [ ] **Step 3: Build the sidebar list from `logTargets`.** Replace the `deployments` memo (the `sortDeployments(Object.values(...))` one) and the `selected` memo with:
```tsx
  const items = useMemo(
    () => buildSidebarItems(resources, logKind, sidebarSearch),
    [resources, logKind, sidebarSearch],
  );
  const selectedKey = selectedItem?.key ?? null;
```
(Remove now-unused imports `sortDeployments`, `replicaText`, `replicasUnhealthy`, `deploymentColor`, `deploymentKey`, `labelSelector` from `./logDisplay` IF they're no longer referenced after this task — check with the build; `podColor`/`formatTimestamp`/etc. stay. `selected` is replaced by `selectedItem`; update any `selected?.metadata...` references in `askClaude`/header to use `selectedItem`.)

- [ ] **Step 4: Generalize `startStream` to take a `SidebarItem`.** Replace the Phase-2 `startStream` (which took a `Deployment`) with one that streams a selector OR a pod:
```tsx
  const startStream = useCallback(
    (item: SidebarItem, o: { previous: boolean; since: string; tailLines: number; container: string }) => {
      if (!item.selector && !item.pod) {
        setError("no label selector or pod to tail");
        return;
      }
      sendLogsStop();
      setLines([]);
      setExpandedLines(new Set());
      setError(null);
      setStickToBottom(true);
      sendLogsStart(
        [{
          namespace: item.namespace,
          labelSelector: item.selector ?? undefined,
          pod: item.pod ?? undefined,
          previous: o.previous,
          since: o.since || undefined,
          container: o.previous && o.container ? o.container : undefined,
        }],
        o.tailLines,
      );
    },
    [],
  );
```
Replace `selectDeployment` with `selectItem`:
```tsx
  const selectItem = useCallback((item: SidebarItem) => {
    setSelectedItem(item);
    setSelectedContainer("");
    setPrevious(false);
    setIsolatedPod("");
    startStream(item, { previous: false, since, tailLines, container: "" });
  }, [startStream, since, tailLines]);
```
(`isolatedPod` state is added in Task 4 — if building strictly in order, add `const [isolatedPod, setIsolatedPod] = useState("");` here in Step 4 so `selectItem` compiles; Task 4 wires its UI.)
Update `reissue` to use `selectedItem` instead of `selected`:
```tsx
    if (selectedItem) startStream(selectedItem, { previous: p, since: s, tailLines: t, container: c });
```
And `closeStream` sets `setSelectedItem(null)` instead of `setSelectedKey(null)`.

- [ ] **Step 5: Render kind tabs + search above the sidebar list.** In the sidebar `<aside>`, above the list `<div className="flex-1 overflow-auto">`, insert:
```tsx
        <div className="flex shrink-0 border-b text-xs">
          {LOG_KINDS.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              onClick={() => { setLogKind(kind); setSelectedItem(null); }}
              aria-pressed={logKind === kind}
              className={`flex-1 py-1.5 ${logKind === kind ? "border-b-2 border-primary font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="shrink-0 border-b px-2 py-1.5">
          <input
            type="text"
            value={sidebarSearch}
            onChange={(e) => setSidebarSearch(e.target.value)}
            placeholder="Search…"
            aria-label="Search sources"
            className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
```

- [ ] **Step 6: Render the list from `items`.** Replace the deployments `<ul>` mapping with one over `items` (uniform shape):
```tsx
            <ul>
              {items.map((it) => (
                <li key={it.key}>
                  <button
                    type="button"
                    onClick={() => selectItem(it)}
                    className={`flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left hover:bg-muted ${
                      it.key === selectedKey ? "bg-muted" : ""
                    }`}
                    style={{ borderLeftColor: podColor(it.name) }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs font-medium">{it.name}</div>
                      <div className="truncate font-mono text-[10px] text-muted-foreground">{it.namespace}</div>
                    </div>
                    <span className={`font-mono text-[10px] ${it.unhealthy ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
                      {it.statusText}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
```
Update the empty/loading states to reference `items.length` instead of `deployments.length`, and the header count badge to `{items.length}`. Update the sidebar header title to be generic (e.g. keep "Sources" or show the active kind label).

- [ ] **Step 7: Update the stream-pane header + askClaude to use `selectedItem`.** Where the header shows `selected.metadata.name`/namespace and the color dot, use `selectedItem.name`/`selectedItem.namespace` and `podColor(selectedItem.name)`. In `askClaude`, replace `selected?.metadata.namespace`/`selected?.metadata.name` with `selectedItem?.namespace`/`selectedItem?.name`. Replace the `!selected` empty-state guard with `!selectedItem`.

- [ ] **Step 8: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build 2>&1 | tail -3`
Expected: PASS. Remove any now-unused imports the compiler flags.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/panels/logs/LogsPanel.tsx
git commit -m "feat(logs): kind tabs (Deploy/STS/DS/Pods) + sidebar search + per-kind/pod streaming"
```

---

## Task 4: Click-a-pod-to-isolate (UI)

**Files:**
- Modify: `apps/web/src/panels/logs/LogsPanel.tsx`

- [ ] **Step 1: State (if not already added in Task 3 Step 4).** Ensure:
```tsx
  const [isolatedPod, setIsolatedPod] = useState("");
```

- [ ] **Step 2: Add `isolatedPod` to the `filtered` memo** (client-side, like container):
```tsx
  const filtered = useMemo(
    () => sortByTimestamp(filterLines(lines, { hideProbes, errorsOnly, query, container: selectedContainer, pod: isolatedPod })),
    [lines, hideProbes, errorsOnly, query, selectedContainer, isolatedPod],
  );
```

- [ ] **Step 3: Compute pod chips + render them.** Near the `containers` memo:
```tsx
  const pods = useMemo(() => distinctPods(lines), [lines]);
```
(`distinctPods` is already imported.) Render chips in the toolbar (only when more than one pod is present) — clicking toggles isolation:
```tsx
              {pods.length > 1 && (
                <div className="flex items-center gap-1">
                  {pods.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setIsolatedPod((cur) => (cur === p ? "" : p))}
                      aria-pressed={isolatedPod === p}
                      title={`Isolate ${p}`}
                      className={`max-w-[120px] truncate rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                        isolatedPod === p ? "bg-primary/15 border-primary" : "text-muted-foreground hover:text-foreground"
                      }`}
                      style={{ borderLeftColor: podColor(p) }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
```

- [ ] **Step 4: Clear isolation on (re)select** — already handled if Task 3's `selectItem` calls `setIsolatedPod("")`. If not, add it there.

- [ ] **Step 5: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/logs/LogsPanel.tsx
git commit -m "feat(logs): click-a-pod-to-isolate chips (client-side filter)"
```

---

## Task 5: Verify + Docker + Playwright + docs + merge

**Files:** none.

- [ ] **Step 1: Full tests + typecheck.** `pnpm --filter web typecheck && pnpm --filter web test 2>&1 | grep -E "Test Files|Tests "` — all PASS.
- [ ] **Step 2: Docker rebuild.** `docker compose up -d --build`.
- [ ] **Step 3: Playwright re-drive.** Open `/logs`: confirm the four kind tabs + search box render; type in search and confirm the list filters; switch to STS / DS / Pods and confirm the list repopulates; pick a Pod and confirm a stream opens; confirm pod chips appear for a multi-replica deployment and clicking one isolates. Screenshot `/tmp/logs-analyze/p3-*.png`.
- [ ] **Step 4: Outline doc.** Edit the "Logs — live tail, filter & scan" doc (id `70a019c7-a6a9-42ed-b101-87ab50ec6df7`): move kind tabs / sidebar search / pod tailing / pod isolation out of "planned (phase 3)" into the live feature list.
- [ ] **Step 5: Merge + push.** `git checkout master && git fetch && git merge origin/master --no-edit && git merge --no-ff feature/logs-overhaul-phase3-find -m "…" && git push origin master`.

---

## Self-review notes (addressed)

- **Spec coverage (Phase 3):** kind tabs + per-kind streaming (Tasks 1,3 — STS/DS via labelSelector, Pods via pod target), sidebar search (Tasks 1,3), pod isolation (Tasks 2,4). All covered.
- **Type consistency:** `LogKind`, `SidebarItem` (`key/name/namespace/statusText/unhealthy/selector/pod`), `buildSidebarItems` used identically across `logTargets.ts`, its tests, and `LogsPanel.tsx`. `startStream` now takes `SidebarItem`; `selectItem`/`reissue`/`closeStream` updated to `selectedItem`. `FilterOptions.pod` matches `filterLines`.
- **Reuse:** `labelSelector` widened (one definition) and reused by `logTargets`; `distinctPods` reused for chips; `filterLines` extended (pod option), not forked.
- **Ordering:** `isolatedPod` state is introduced in Task 3 Step 4 (so `selectItem` compiles) and its UI lands in Task 4 — every commit typechecks.
