# Right-sizing All-namespaces Refresh Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Switching the Right-sizing panel's namespace filter from a specific namespace back to "All namespaces" must show every namespace's workloads again, not the stale specific-namespace list.

**Root cause:** `useRightSizing` (`apps/web/src/panels/rightsizing/useRightSizing.ts:94-104`) opens its live-workload watch scoped to the *selected* namespace (`resolveNamespaceScope(namespaceFilter, clusterWide)` — "*" or a specific ns), re-subscribing under a **different** `${kind}/${namespace}` key (`apps/web/src/lib/wsSubscriptions.ts:32-34`) every time the filter changes. The Zustand cluster store keys `resources` by **kind only** (`apps/web/src/store/cluster.ts:3`, `ResourceMap = Record<string, Record<string, unknown>>`), and the WS snapshot handler blindly does `store.replaceKind(m.kind, items)` (`apps/web/src/lib/ws.ts:308-316`), ignoring the `m.namespace` the server actually sent — so whichever namespace-scoped subscription's snapshot lands last **replaces the entire kind slice**, discarding the other scope's data. The specific bug in this ticket: unsubscribing from a namespace doesn't tear the watch down immediately — it *lingers* for 30s (`LINGER_MS` in `wsSubscriptions.ts:17`) before the unsubscribe frame is even sent. If the user flips back to a scope (e.g. "*") that is still lingering from an earlier visit, `planSubscribe` treats it as a **warm reuse** (`wsSubscriptions.ts:47-62`, confirmed by the existing test `wsSubscriptions.test.ts:33-48` "subscribe during linger cancels the timer and revives the entry") and explicitly returns `sendSubscribe: false` — no new subscribe frame is sent, so the server never re-delivers a fresh "*" snapshot. The store's single `resources.deployments` (etc.) bucket is left holding whatever the *other*, more-recently-active namespace subscription last wrote into it (the specific namespace's items), and only incremental deltas trickle in afterward. Since `RightSizingPanel.tsx:166-169` already client-filters `workloads` by `namespaceFilter` as a "safeguard", the panel faithfully renders this stale, under-populated data: it looks exactly like "stuck on the previous namespace."

**Approach:** Stop opening a second, namespace-scoped watch for the workload kinds in `useRightSizing`. Always watch every namespace (`"*"`) for `deployments`/`statefulsets`/`daemonsets` — a single, stable, ref-counted subscription per kind that's never torn down and rebuilt as the namespace filter changes — and rely entirely on the client-side filter that already exists in `RightSizingPanel.tsx` (`inNamespace`) to scope what's displayed. This matches the established fix pattern in this codebase (never open a second watch on an already-watched kind; filter the shared global slice client-side) and needs no store/wsSubscriptions changes. The namespace-scoped usage/metrics REST fetch (`fetchUsageHistory`) is untouched — it's a one-shot per-hook-instance `useState`, not routed through the shared kind-keyed store, so it isn't affected by this bug and still needs to stay namespace-scoped for `clusterWide: false` callers.

---

## Task 1 — Reproduce the clobber at the subscription-registry layer (failing test)

- [ ] In `apps/web/src/lib/wsSubscriptions.test.ts`, add a new `describe` block (e.g. `describe("cross-namespace clobber (HELM-31)", ...)`) with a test that walks the exact sequence that breaks right-sizing:
  1. `planSubscribe(reg, "deployments", "*")` — initial mount in "All namespaces" (cold, `sendSubscribe: true`).
  2. `planUnsubscribe(reg, "deployments", "*")` — user picks a specific namespace; the "*" entry's refs hit 0 and it starts lingering (`startLinger: true`).
  3. `planSubscribe(reg, "deployments", "team-a")` — cold subscribe for the specific namespace (`sendSubscribe: true`).
  4. `planUnsubscribe(reg, "deployments", "team-a")` — user flips back to "All namespaces" **within the linger window**; team-a's refs hit 0, it starts lingering too (`startLinger: true`).
  5. `planSubscribe(reg, "deployments", "*")` again — assert this is a **warm reuse** (`sendSubscribe: false`, `toggleLoading: false`), proving no fresh snapshot will ever be requested even though the shared store's `resources.deployments` bucket currently holds team-a-only data (from step 3's snapshot) rather than the full "*" snapshot from step 1.
  - Add a comment on the final assertion explaining this is the mechanism behind HELM-31: warm reuse is only safe when the store's cached data for that key is still valid, but `useCluster`'s `resources` map is keyed by kind only, so an intervening different-namespace subscription clobbers it.
- [ ] Run `pnpm --filter web test -- wsSubscriptions.test.ts` and confirm the new test **passes** (it documents existing, correct low-level behavior of `planSubscribe`/`planUnsubscribe` — the bug is in *how `useRightSizing` uses* this registry, not in the registry itself). This test is a regression guard, not a red/green TDD test for this task; it will keep passing after the fix in Task 3 since the registry contract doesn't change.
- [ ] Commit: `test(web): document wsSubscriptions cross-namespace clobber mechanism (HELM-31)`

## Task 2 — Add a failing test proving `useRightSizing` re-subscribes per namespace (the actual defect)

- [ ] Read `apps/web/src/panels/rightsizing/useRightSizing.test.ts` (currently only covers `resolveNamespaceScope`) to match its existing style, then add a new test file `apps/web/src/panels/rightsizing/useRightSizing.subscribe.test.ts`:
  - `// @vitest-environment jsdom` at the top (see `apps/web/src/lib/agents.test.ts:1` for the convention).
  - `vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }))` and import the mocked `subscribe`/`unsubscribe`.
  - Import `renderHook` from `@testing-library/react`, `useRightSizing` from `./useRightSizing`, and `useCluster` from `@/store/cluster`.
  - Also mock `global.fetch` (via `vi.spyOn(globalThis, "fetch")`) to resolve `{ available: false, backend: null, items: [] }` for `/api/metrics/usage` and `{ backends: [] }` for `/api/metrics/backends`, so the hook doesn't hit the network.
  - Test: `it("keeps watching every namespace when the namespace filter changes, instead of re-subscribing per namespace", ...)`:
    - `useCluster.setState({ namespaceFilter: "team-a" })`.
    - `const { rerender } = renderHook(() => useRightSizing())`.
    - Assert `subscribe` was called with `("deployments", "*")`, `("statefulsets", "*")`, `("daemonsets", "*")` (NOT `"team-a"`) — this will **fail** against current code, which calls `subscribe("deployments", "team-a")` etc.
    - `vi.clearAllMocks()`; `useCluster.setState({ namespaceFilter: null })`; `rerender()`.
    - Assert `subscribe`/`unsubscribe` were **not called again** for these three kinds (no new frame, no unsubscribe/resubscribe churn) — proving the watch is now stable across namespace-filter changes.
- [ ] Run `pnpm --filter web test -- useRightSizing.subscribe.test.ts` and confirm it **fails** with the expected mismatch (`subscribe` called with `"team-a"` instead of `"*"`, and/or extra calls on rerender). Paste the failing assertion output into the commit body isn't required, but confirm failure before proceeding.
- [ ] Commit: `test(web): failing test — right-sizing must not re-scope its watch per namespace (HELM-31)`

## Task 3 — Fix `useRightSizing` to always watch every namespace

- [ ] In `apps/web/src/panels/rightsizing/useRightSizing.ts`, change the workload-watch effect (currently lines 93-104):
  ```ts
  // Workload specs come from the live store. Always watch every namespace
  // here (kind="*") and let RightSizingPanel's `inNamespace` filter scope the
  // display client-side. Re-subscribing under a namespace-specific key here
  // would open a SECOND watch on the same kind — and since useCluster.resources
  // is keyed by kind only (not kind+namespace), whichever subscription's
  // snapshot lands last clobbers the other's data. Worse, the 30s subscription
  // linger (see wsSubscriptions.ts) means flipping back to "*" within that
  // window is treated as a warm reuse and never re-requests a fresh snapshot,
  // leaving the store stuck on the other namespace's items (HELM-31).
  useEffect(() => {
    subscribe("deployments", "*");
    subscribe("statefulsets", "*");
    subscribe("daemonsets", "*");
    return () => {
      unsubscribe("deployments", "*");
      unsubscribe("statefulsets", "*");
      unsubscribe("daemonsets", "*");
    };
  }, []);
  ```
  - Remove the now-unused `namespaceFilter`/`clusterWide` references from *this specific effect only* — leave the usage-fetch effect (lines 119-141) and its `resolveNamespaceScope` call untouched; it still needs to be namespace-scoped for the REST query.
  - Double-check `resolveNamespaceScope` is still exported and still used by the usage-fetch effect and by `useRightSizing.test.ts` — do not remove or rename it.
- [ ] Run `pnpm --filter web test -- useRightSizing.subscribe.test.ts` and confirm it now **passes**.
- [ ] Run `pnpm --filter web test -- wsSubscriptions.test.ts useRightSizing.test.ts` and confirm both still pass (no regressions to the pure-function tests or `resolveNamespaceScope`).
- [ ] Commit: `fix(web): right-sizing watches every namespace once, filters client-side (HELM-31)`

## Task 4 — Guard the panel-level display filter with a regression test

- [ ] `RightSizingPanel.tsx:166-169` already filters `workloads` by `namespaceFilter` client-side (`inNamespace`) — this is the mechanism the fix now relies on exclusively. Check whether `RightSizingPanel` has an existing component test file (`apps/web/src/panels/rightsizing/RightSizingPanel.test.tsx`); if none exists, skip adding a full component test (out of scope — keep this fix bite-sized) but confirm via a quick read that `inNamespace`'s filter predicate (`namespaceFilter == null || w.namespace === namespaceFilter`) correctly handles both "All" (`null`) and a specific namespace using the now-always-multi-namespace `workloads` array from `useRightSizing`. No code change expected here — this step is verification only.
- [ ] Run the full web suite: `pnpm --filter web test` and confirm no other suite (e.g. `OverviewPanel`, which also calls `useRightSizing({ clusterWide: true })`) broke from the effect-dependency change.

## Task 5 — Typecheck and final verification

- [ ] Run `pnpm --filter web typecheck` and fix any type errors surfaced by the edit.
- [ ] Run `pnpm --filter web test` one more time (full suite) to confirm everything is green.
- [ ] Summarize the fix and link back to HELM-31 in the final commit message body if squashing, or leave the three commits from Tasks 1-3 as-is.
