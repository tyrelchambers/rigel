# Connectivity Dropdown: Finish or Remove — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remove the dead expand/collapse chevron on Connectivity rows so the panel no longer ships a control that renders but does nothing.

**The control:** The chevron ("expand/collapse") button rendered unconditionally by `ListRow` (`apps/web/src/panels/components/ListRow.tsx:79-87`), as used by `FlowRow` in `apps/web/src/panels/connectivity/ConnectivityPanel.tsx:240-246`. `FlowRow` calls `<ListRow rowKey={flow.id} isOpen={false} onToggle={() => {}} contextMenu={rowMenu}>` — `isOpen` is a hardcoded literal `false` (never toggles), `onToggle` is a no-op arrow function, and no `expandedContent` is ever passed. The chevron icon (`ChevronRight`/`ChevronDown`, visually a disclosure/"dropdown" arrow) is fully interactive — it has `aria-expanded`, focus styles, and a click handler — but clicking it can never change anything and there is nothing behind it to reveal.

**Recommendation:** REMOVE — every other one of the 18 `ListRow` consumers in the codebase (Services, ConfigMaps, RBAC, Storage, Pods, Ingresses, Secrets, Nodes, workloads rows, etc.) wires `isOpen`/`onToggle` to real component state plus a real `expandedContent`; Connectivity is the sole outlier where the wiring was stubbed and never finished. There is no approved Pencil design for a "Connectivity — expanded row" (unlike Services `x2MuTZ` / ConfigMaps `xCFK3`, which shipped from named frames), and the row already surfaces the operationally useful info inline (hosts, ingress name, service pill, ready/total pod count, health badge, issue text) plus two working navigation actions (View service / View pods via the kebab / right-click menu). Inventing new expand content now would violate "design in Pencil first" and would likely just duplicate what View service / View pods already do by jumping to the full Services/Pods panel.

---

## Findings

`apps/web/src/panels/connectivity/ConnectivityPanel.tsx` renders one `FlowRow` per computed `Flow` (from `connectivityDisplay.ts::computeFlows`). Every interactive/selector-like control in the panel:

1. **Legend** (`ConnectivityPanel.tsx:142-156`) — static, not interactive. Not a control.
2. **Right-click / kebab context menu** (`ConnectivityPanel.tsx:233-238`, rendered via `ListRow`'s `contextMenu` prop) — **functional**. Two items:
   - `View service` → `handleSelectService` (`ConnectivityPanel.tsx:209-217`) calls `goToResource(navigate, { kind: "services", ... })`. Works.
   - `View pods` → `handleSelectPods` (`ConnectivityPanel.tsx:219-231`), disabled when `flow.totalPods === 0`, otherwise navigates to the first matching pod. Works.
   - The kebab button itself (`ListRow.tsx:92-103`, `openRowMenu` at `ListRow.tsx:62-70`) just re-dispatches a synthetic `contextmenu` event to open the same menu — functional, shared with every other panel.
3. **Service-name button** (`ConnectivityPanel.tsx:281-296`) — functional, calls `handleSelectService` directly (same navigation as above).
4. **Pod-count button** (`ConnectivityPanel.tsx:301-313`) — functional, calls `handleSelectPods`, correctly disabled when there are no pods.
5. **Expand/collapse chevron** (rendered by `ListRow.tsx:79-87`, driven by the props `FlowRow` passes at `ConnectivityPanel.tsx:241-246`) — **the stub**. `isOpen={false}` is a literal, never read from state; `onToggle={() => {}}` is a no-op; `expandedContent` is never passed. The button is visually present (chevron icon, `aria-expanded="false"`, hover/focus styles — it reads as a disclosure/"dropdown" affordance) and is clickable, but clicking it is a pure no-op and there is no content that could ever appear even if `isOpen` did flip. Confirmed via `grep` that all 17 other `ListRow` call sites (`ServicesPanel`, `ConfigMapsPanel`, `RbacPanel` x4, `StoragePanel` x3, `PodsPanel`, `IngressesPanel`, `SecretsPanel`, `NamespacesPanel`, `EventsPanel`, `NodesPanel`, `CertificatesPanel`, `RightSizingPanel`, `DatabasesPanel`, workloads' `JobRow`/`StatefulSetRow`/`DaemonSetRow`/`CronJobRow`) wire `isOpen` to real `Set`-backed expand state and `onToggle` to a real `toggleExpand`/`toggle` callback, paired with a real `expandedContent` (a `*Detail` component). Connectivity is the only place this was left as dead scaffolding.

No other dropdown/select/popover exists anywhere in `ConnectivityPanel.tsx`, `connectivityDisplay.ts`, or `types.ts` — `connectivityDisplay.ts` is pure data-shaping logic (`computeFlows`, `isPodReady`, `getFlowHealth`) with no UI at all.

---

## Tasks (Option B — REMOVE)

### Task 1: Add an `expandable` escape hatch to `ListRow` (TDD)

`ListRow`'s chevron is currently unconditional; we need a supported way to opt a row out of it entirely, without touching the 17 other call sites (which all still want the chevron, unchanged, at its default behavior).

**Files:**
- Create: `apps/web/src/panels/components/ListRow.test.tsx`
- Edit: `apps/web/src/panels/components/ListRow.tsx`

- [ ] **Step 1 — write the failing test.** Create `apps/web/src/panels/components/ListRow.test.tsx`:

  ```tsx
  // @vitest-environment jsdom
  import { describe, it, expect, vi } from "vitest";
  import { render, screen } from "@testing-library/react";
  import { ListRow } from "./ListRow";

  describe("ListRow", () => {
    it("renders the expand/collapse chevron by default", () => {
      render(
        <ListRow rowKey="a" isOpen={false} onToggle={() => {}}>
          row body
        </ListRow>,
      );
      expect(screen.getByRole("button", { name: "Expand" })).toBeInTheDocument();
    });

    it("omits the chevron when expandable={false}", () => {
      render(
        <ListRow rowKey="a" expandable={false}>
          row body
        </ListRow>,
      );
      expect(screen.queryByRole("button", { name: "Expand" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Collapse" })).not.toBeInTheDocument();
    });

    it("still renders a working context-menu kebab when expandable={false}", () => {
      render(
        <ListRow rowKey="a" expandable={false} contextMenu={<div>menu item</div>}>
          row body
        </ListRow>,
      );
      expect(screen.getByRole("button", { name: "Row actions" })).toBeInTheDocument();
    });
  });
  ```

  Run `pnpm --filter web test -- ListRow` from the repo root and confirm it fails (the `expandable` prop doesn't exist yet, so TypeScript/the component will ignore it and the chevron will still render for test 2).

- [ ] **Step 2 — make it pass.** In `apps/web/src/panels/components/ListRow.tsx`:
  - In `ListRowProps` (around line 18), make `isOpen`/`onToggle` optional and add `expandable`:
    ```ts
    /** Whether the row is currently expanded. Ignored when `expandable` is false. */
    isOpen?: boolean;
    /** Called when the chevron or name is clicked to toggle expand. Ignored when `expandable` is false. */
    onToggle?: () => void;
    /**
     * Set to `false` for rows with no expandable detail — omits the chevron
     * entirely instead of rendering a disclosure control that does nothing.
     * Defaults to `true`.
     */
    expandable?: boolean;
    ```
  - In the function signature (around line 43), default them: `isOpen = false, onToggle = () => {}, expandable = true,`.
  - Wrap the chevron `<button>` (lines 79-87) in `{expandable && (...)}`.
  - Leave the `{isOpen && expandedContent && (...)}` block (lines 142-149) untouched — it already no-ops correctly when `isOpen` is false.

- [ ] **Step 3 — verify.** `pnpm --filter web test -- ListRow` passes (all 3 cases). `pnpm --filter web typecheck` passes.

### Task 2: Stop passing the dead toggle wiring from `FlowRow`

**Files:**
- Edit: `apps/web/src/panels/connectivity/ConnectivityPanel.tsx`

- [ ] Replace the `<ListRow ...>` open tag at `ConnectivityPanel.tsx:241-246`:

  ```tsx
  <ListRow
    rowKey={flow.id}
    isOpen={false}
    onToggle={() => {}}
    contextMenu={rowMenu}
  >
  ```

  with:

  ```tsx
  <ListRow
    rowKey={flow.id}
    expandable={false}
    contextMenu={rowMenu}
  >
  ```

- [ ] Update the file-header comment block at `ConnectivityPanel.tsx:28-32` to drop the ambiguity about what's deferred vs. intentionally absent. Replace:

  ```
  // ---------------------------------------------------------------------------
  // Navigation uses goToResource to jump to the Services or Pods panel and focus
  // the selected row. Port-forward UI, View YAML, Ask Claude handoff, and
  // forwarding badge remain deferred. NO mutations, NO kubectl writes.
  // ---------------------------------------------------------------------------
  ```

  with:

  ```
  // ---------------------------------------------------------------------------
  // Navigation uses goToResource to jump to the Services or Pods panel and focus
  // the selected row. Port-forward UI, View YAML, Ask Claude handoff, and
  // forwarding badge remain deferred. NO mutations, NO kubectl writes.
  //
  // Rows are intentionally non-expandable (ListRow's `expandable={false}`):
  // the chip row already surfaces hosts/ingress/service/pod-count/health/issues
  // inline, and View service / View pods (context menu + inline buttons) cover
  // drill-down. Do not re-add a chevron/expand affordance here without a
  // Pencil design for the expanded content (see feedback_pencil_design_first).
  // ---------------------------------------------------------------------------
  ```

- [ ] `pnpm --filter web typecheck` passes (confirms no other code still reads a nonexistent `isOpen`/`onToggle` requirement for this call site).

### Task 3: Full verification

- [ ] `pnpm --filter web typecheck`
- [ ] `pnpm --filter web test` (full suite — confirms `connectivityDisplay.test.ts`, the new `ListRow.test.tsx`, and nothing else regresses)
- [ ] Manually re-read the rendered `FlowRow` markup (via the test or a quick `pnpm --filter web build`) to confirm no leftover chevron-sized gap looks broken — `ListRow`'s row is a flex container with `gap-2`, so omitting the button naturally closes the gap; no extra layout fix expected, but eyeball the diff.

---

## Alternative (not recommended)

**Option A — FINISH.** Wire `isOpen`/`onToggle` to real per-row expand state (a `Set<string>` of open flow ids in `ConnectivityPanel`, same `toggleExpand` pattern as every other panel) and add a `FlowDetail` component as `expandedContent`, e.g. showing: the full list of `flow.podNames` with individual ready/not-ready status (today only the aggregate `readyPods/totalPods` count is shown), the full ingress host/path table backing the flow, and `flow.serviceType`/cluster IP pulled from the underlying `Service` object. This would reuse `MetaCard`/`TagPill`/`StatusBadge` the same way `ServiceDetail.tsx` and `ConfigMapDetail.tsx` do.

Why not recommended right now: there is no Pencil frame for a "Connectivity — expanded row," and per the established pattern (Services `x2MuTZ`, ConfigMaps `xCFK3`) this team designs expanded-row layouts in Pencil before building them — inventing the layout here would violate that. It also isn't clear the extra depth earns its keep: the two things it would add (per-pod status, ingress host/path table) are one click away via View pods / View service, which already jump to panels built to show exactly that detail with full actions. If a future ticket wants this, it should start with a Pencil design spec (frame id required) rather than being bolted on as a side effect of this bug ticket.

If Option A is chosen instead of B, skip Tasks 1-2 above and instead: (1) get a Pencil frame for the Connectivity expanded row, (2) add `expanded: Set<string>` + `toggleExpand` state to `ConnectivityPanel`, (3) build `FlowDetail.tsx` per the frame, (4) wire `isOpen`/`onToggle`/`expandedContent` on `FlowRow` the same way `ServicesPanel.tsx:168-171` does, (5) unit-test `FlowDetail` the way `ServiceDetail`/`ConfigMapDetail` presumably are tested, (6) verify with the same `pnpm --filter web typecheck` / `pnpm --filter web test` commands.
