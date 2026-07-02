# Button Standardization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `apps/web/src/components/ui/button.tsx` the single styled source of truth for every button (fill, border, radius, padding, text size/weight, icon spacing, hover, focus, disabled), and migrate the ~98 hand-rolled `<button>` consumer files onto it.
**Architecture:** `Button` keeps its existing 7-variant x 8-size `cva` shape; only the `default` variant's hover token changes to match the app's established `--accent-hover`. Every hand-rolled control-affordance button (icon trigger, CTA, toggle, destructive action, text-link action, copy chip) is replaced with `<Button variant=… size=…>`; full-bleed clickable rows/cards and four Pencil-exception modal footers are explicitly left as native `<button>`. TypeScript does not enforce this migration (no removed exports), so each batch's real gate is a grep sweep plus targeted tests.
**Spec:** docs/superpowers/specs/2026-07-02-button-standardization-design.md

---

## Migration recipe (reference for every consumer task)

For each file in a task:

1. **Classify every `<button>` in the file** using the spec's mapping table:
   - Accent CTA (`bg-[var(--accent-primary)]`, `hover:bg-[var(--accent-hover)]`, bold/semibold text) → `<Button variant="default" size={"default"|"sm"|"lg"}>`.
   - Bordered cancel/secondary (`border-[var(--border-strong)]` or similar, no fill) → `<Button variant="outline">` (use `variant="muted"` if the hand-rolled version had a translucent `bg-white/5` fill instead of a plain background).
   - Icon-only, no border, subtle hover (`hover:bg-muted`, `hover:bg-white/[0.05]`, `hover:opacity-80`) → `<Button variant="ghost" size="icon-xs"|"icon-sm"|"icon"|"icon-lg">` (pick the closest scale size to the current pixel dimension; if a Pencil-exact non-scale pixel size is required, add `className="size-[Npx]"` on top of the nearest size).
   - Destructive (red text/bg, delete/remove/uninstall actions) → `<Button variant="destructive">`.
   - Arrow/text-link style (`text-[var(--accent-primary)] hover:underline`, no border/fill) → `<Button variant="link" size="sm">` (or `xs` to match the original text size).
   - Small icon+label "Copy" chip → `<Button variant="ghost" size="xs">`.
   - **Skip** (leave as native `<button>`): full-width/full-bleed clickable rows or cards (list items, option rows, banner-style clickable cards). If unsure whether something is a "row" or a "button", check: does it span the container width and lay out multi-line/multi-element content, or is it a bounded icon/label control? The former stays native.
   - **Skip** (leave as native `<button>`, do not touch): the four Pencil-exception modal footers named below.
2. **Replace** the `<button className="…">…</button>` with `<Button variant=… size=…>…</Button>`, moving any *content-specific* leftover classes (e.g. `w-fit`, `ml-2`, a one-off color override) into `className` on `Button` — `cn()` merges it last.
3. **Drop** now-redundant inline `style={{}}` that duplicated what the chosen variant/size already provides (background, padding, border-radius, color, hover). Keep any style that isn't expressible as a variant (e.g. a dynamic per-item color computed at runtime) — but prefer converting it to a token-based `className` if it's simple (e.g. `style={{ color: "var(--fg-secondary)" }}` → `className="text-[var(--fg-secondary)]"`).
4. **Preserve behavior exactly**: `onClick`, `disabled`, `title`, `aria-label`, `type` (only meaningful for `type="submit"` inside a form — `Button` forwards all native button props), `onContextMenu`, etc. all carry over unchanged.
5. Import `Button` from `@/components/ui/button` if not already imported.

**After every task:** `pnpm --filter web typecheck` must be clean for the files touched, and the task's commit only lands once green.

---

## Task 1: Adjust `Button`'s default hover + add tests

**Files:**
- Modify: `apps/web/src/components/ui/button.tsx`
- Test: `apps/web/src/components/ui/button.test.tsx` (create)

- [ ] **Step 1: Write tests**

Create `apps/web/src/components/ui/button.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("renders as a real button with its accessible name", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("applies the default variant's accent hover token", () => {
    render(<Button>Go</Button>);
    const btn = screen.getByRole("button", { name: "Go" });
    expect(btn.className).toContain("hover:bg-[var(--accent-hover)]");
  });

  it("applies the destructive variant", () => {
    render(<Button variant="destructive">Delete</Button>);
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn.className).toContain("text-destructive");
  });

  it("applies the link variant", () => {
    render(<Button variant="link">View all</Button>);
    const btn = screen.getByRole("button", { name: "View all" });
    expect(btn.className).toContain("hover:underline");
  });

  it("supports icon sizes", () => {
    render(<Button size="icon-sm" aria-label="Close">X</Button>);
    const btn = screen.getByRole("button", { name: "Close" });
    expect(btn.className).toContain("size-7");
  });

  it("respects disabled state", () => {
    render(<Button disabled>Nope</Button>);
    expect(screen.getByRole("button", { name: "Nope" })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run the tests to verify the hover assertion fails**

Run: `pnpm --filter web test -- button.test`
Expected: FAIL on "applies the default variant's accent hover token" (current code has `hover:bg-primary/80`, not `hover:bg-[var(--accent-hover)]`). Other assertions pass already since nothing else changes.

- [ ] **Step 3: Change the `default` variant's hover**

In `apps/web/src/components/ui/button.tsx`, change:

```tsx
default: "bg-primary text-primary-foreground hover:bg-primary/80",
```

to:

```tsx
default: "bg-primary text-primary-foreground hover:bg-[var(--accent-hover)]",
```

No other lines in the variants/sizes objects change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web test -- button.test`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Typecheck and full existing test suite**

Run: `pnpm --filter web typecheck && pnpm --filter web test`
Expected: Clean. The hover-class change only affects `Button`'s `default`
variant visually; no existing test asserts the old `hover:bg-primary/80`
string (confirm with `grep -rn "bg-primary/80" apps/web/src` — expect no
hits after this step).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ui/button.tsx apps/web/src/components/ui/button.test.tsx
git commit -m "feat(web): align Button default-variant hover with --accent-hover token"
```

---

## Task 2: Migrate shell chrome batch A (rail, header, nav)

**Files (modify):**
- `apps/web/src/shell/GlobalHeader.tsx`
- `apps/web/src/shell/NavStrip.tsx`
- `apps/web/src/shell/ClusterRail.tsx`
- `apps/web/src/shell/ClusterIconPicker.tsx`
- `apps/web/src/shell/ClusterHealthBadge.tsx`
- `apps/web/src/shell/AddClusterChooser.tsx`
- `apps/web/src/shell/NamespaceBar.tsx`

- [ ] **Step 1: Apply the migration recipe to each file**

These are almost entirely icon-only triggers (sidebar collapse, search, account,
add-cluster, per-cluster switch/context-menu, health badge). Map each to
`variant="ghost"` (or `variant="outline"` where a visible border ring is part
of the design, e.g. an active/selected rail item) and the closest `icon-*`
size. `ClusterRail.tsx`'s 38px add-button and `ClusterHealthBadge.tsx`/dialog
close buttons at 30px are the non-scale sizes flagged in the spec — use
`size="icon-lg" className="size-[38px]"` / `size="icon-sm" className="size-[30px]"`
respectively to preserve exact Pencil pixel values while still routing through
`Button`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: No errors in the seven files above.

- [ ] **Step 3: Run affected tests**

Run: `pnpm --filter web test -- ClusterRail ClusterIconPicker AddClusterChooser NamespaceBar GlobalHeader NavStrip`
Expected: PASS (update any selector asserting a hand-rolled `className`).

- [ ] **Step 4: Grep verify no stray raw buttons remain in this batch**

Run: `grep -n "<button" apps/web/src/shell/GlobalHeader.tsx apps/web/src/shell/NavStrip.tsx apps/web/src/shell/ClusterRail.tsx apps/web/src/shell/ClusterIconPicker.tsx apps/web/src/shell/ClusterHealthBadge.tsx apps/web/src/shell/AddClusterChooser.tsx apps/web/src/shell/NamespaceBar.tsx`
Expected: No matches (or only documented row/card holdouts, if any are found during migration — note them in the commit message).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/GlobalHeader.tsx apps/web/src/shell/NavStrip.tsx apps/web/src/shell/ClusterRail.tsx apps/web/src/shell/ClusterIconPicker.tsx apps/web/src/shell/ClusterHealthBadge.tsx apps/web/src/shell/AddClusterChooser.tsx apps/web/src/shell/NamespaceBar.tsx
git commit -m "refactor(web): migrate rail/header/nav chrome to Button"
```

---

## Task 3: Migrate shell chrome batch B (wizards, dialogs, chat pane chrome)

**Files (modify):**
- `apps/web/src/shell/ChatPane.tsx`
- `apps/web/src/shell/ChatPaneEmptyState.tsx`
- `apps/web/src/shell/ConnectWizard.tsx`
- `apps/web/src/shell/ConnectClusterModal.tsx`
- `apps/web/src/shell/CreateClusterModal.tsx`
- `apps/web/src/shell/RemoveClusterDialog.tsx`
- `apps/web/src/shell/TerminalDrawer.tsx`
- `apps/web/src/shell/PaneComposer.tsx`
- `apps/web/src/shell/OnboardingWizard.tsx`
- `apps/web/src/shell/onboarding/AboutYouStep.tsx`

**Excluded from this task:** `apps/web/src/shell/AccountModal.tsx` — its footer
("Sign out" + "Done") is a named Pencil exception (spec, Out of scope #1). Do
not touch this file.

- [ ] **Step 1: Apply the migration recipe to each file**

`OnboardingWizard.tsx` has local `primaryBtn`/`ghostBtn` inline `style`
objects reused across several buttons — replace every call site with
`<Button variant="default">`/`<Button variant="outline">` (or `"ghost"`
depending on whether the original had a visible border) and delete the now-
unused `primaryBtn`/`ghostBtn` style constants once no `<button style={…}>`
references them.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: No errors in the ten files above.

- [ ] **Step 3: Run affected tests**

Run: `pnpm --filter web test -- ChatPane ConnectWizard ConnectClusterModal CreateClusterModal RemoveClusterDialog TerminalDrawer OnboardingWizard AboutYouStep`
Expected: PASS.

- [ ] **Step 4: Grep verify**

Run: `grep -n "<button" apps/web/src/shell/ChatPane.tsx apps/web/src/shell/ChatPaneEmptyState.tsx apps/web/src/shell/ConnectWizard.tsx apps/web/src/shell/ConnectClusterModal.tsx apps/web/src/shell/CreateClusterModal.tsx apps/web/src/shell/RemoveClusterDialog.tsx apps/web/src/shell/TerminalDrawer.tsx apps/web/src/shell/PaneComposer.tsx apps/web/src/shell/OnboardingWizard.tsx apps/web/src/shell/onboarding/AboutYouStep.tsx`
Expected: No matches (or documented holdouts only).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/ChatPane.tsx apps/web/src/shell/ChatPaneEmptyState.tsx apps/web/src/shell/ConnectWizard.tsx apps/web/src/shell/ConnectClusterModal.tsx apps/web/src/shell/CreateClusterModal.tsx apps/web/src/shell/RemoveClusterDialog.tsx apps/web/src/shell/TerminalDrawer.tsx apps/web/src/shell/PaneComposer.tsx apps/web/src/shell/OnboardingWizard.tsx apps/web/src/shell/onboarding/AboutYouStep.tsx
git commit -m "refactor(web): migrate wizard/dialog chrome to Button"
```

---

## Task 4: Migrate shared components (`components/`, `panels/components/`)

**Files (modify):**
- `apps/web/src/components/ConfirmSheet.tsx`
- `apps/web/src/components/DiffView.tsx`
- `apps/web/src/components/InfoTooltip.tsx`
- `apps/web/src/components/ui/SegmentedTabs.tsx`
- `apps/web/src/panels/components/ListRow.tsx`
- `apps/web/src/panels/components/RelatedResources.tsx`

These are high blast-radius (used across most panels) — migrate carefully and
run the widest test pass of any batch.

- [ ] **Step 1: Apply the migration recipe to each file**

`ConfirmSheet.tsx` and `DiffView.tsx`'s "Copy" chip buttons are the
copy-chip pattern from the spec → `<Button variant="ghost" size="xs">`.
`ListRow.tsx`'s row-level click target (the expandable row itself) is the
row/card holdout from the spec — leave it native; only its kebab-menu /
action-icon triggers (if any are raw `<button>`) migrate to
`<Button variant="ghost" size="icon-sm">`. `SegmentedTabs.tsx` renders tab
buttons — evaluate whether these are closer to a toggle-group control
(candidate for `Button` with an active-state `className` override) or a
distinct tab affordance; if the visual treatment doesn't cleanly map to any
existing variant, leave `SegmentedTabs` as-is and note it in the commit
message rather than forcing a bad fit (per spec: only genuine control
affordances migrate).

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: No errors in the six files above.

- [ ] **Step 3: Run the widest affected test pass**

Run: `pnpm --filter web test -- ConfirmSheet DiffView InfoTooltip SegmentedTabs ListRow RelatedResources`
Expected: PASS. Also run a broader smoke pass since these are shared:
`pnpm --filter web test` (full suite) — expected PASS, since no props/exports
were removed, only internal markup.

- [ ] **Step 4: Grep verify**

Run: `grep -n "<button" apps/web/src/components/ConfirmSheet.tsx apps/web/src/components/DiffView.tsx apps/web/src/components/InfoTooltip.tsx apps/web/src/components/ui/SegmentedTabs.tsx apps/web/src/panels/components/ListRow.tsx apps/web/src/panels/components/RelatedResources.tsx`
Expected: No matches except documented row holdouts (`ListRow.tsx`'s row
button, if kept) and `SegmentedTabs.tsx` if deferred per Step 1.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ConfirmSheet.tsx apps/web/src/components/DiffView.tsx apps/web/src/components/InfoTooltip.tsx apps/web/src/components/ui/SegmentedTabs.tsx apps/web/src/panels/components/ListRow.tsx apps/web/src/panels/components/RelatedResources.tsx
git commit -m "refactor(web): migrate shared ConfirmSheet/DiffView/ListRow controls to Button"
```

---

## Task 5: Migrate `panels/assistant/*` batch

**Files (modify):**
- `apps/web/src/panels/assistant/ActivityCard.tsx`
- `apps/web/src/panels/assistant/AuditRow.tsx`
- `apps/web/src/panels/assistant/OwnedResources.tsx`
- `apps/web/src/panels/assistant/tabs/ActivityTab.tsx`
- `apps/web/src/panels/assistant/tabs/AutoFixTab.tsx`
- `apps/web/src/panels/assistant/tabs/OverviewTab.tsx`
- `apps/web/src/panels/assistant/tabs/ReportsTab.tsx`
- `apps/web/src/panels/assistant/tabs/RulesTab.tsx`
- `apps/web/src/panels/assistant/agents/CredentialsManager.tsx`
- `apps/web/src/panels/assistant/agents/CredentialSourceDialog.tsx`
- `apps/web/src/panels/assistant/agents/NamespaceMultiSelect.tsx`
- `apps/web/src/panels/assistant/components/LinkRepoModal.tsx`
- `apps/web/src/panels/assistant/AlertsCard.tsx` (footer only excluded — see below)

**Partial exclusion:** In `AlertsCard.tsx`, the "New alert" modal footer
("Cancel" `DialogClose` + "Create alert" accent button, lines ~600-612) is a
named Pencil exception — leave those two elements untouched. Migrate every
other `<button>` in the file normally.

- [ ] **Step 1: Apply the migration recipe to each file**

`OverviewTab.tsx`'s "Clear" button already uses `<Button variant="ghost"
size="sm">` — no change needed there. Its "N fixes awaiting approval" /
"Agent opened N pull requests" banners and "View all in Activity →" link are
in scope: the banners are full-width clickable cards (row/card holdout, leave
native per spec) but the "View all in Activity →" text action is a genuine
link-style control → `<Button variant="link" size="xs">`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: No errors in the 13 files above.

- [ ] **Step 3: Run affected tests**

Run: `pnpm --filter web test -- panels/assistant`
Expected: PASS (includes `OwnedResources.test.tsx`, `CredentialsManager.test.tsx`, `CredentialSourceDialog.test.tsx`, `NamespaceMultiSelect.test.tsx`).

- [ ] **Step 4: Grep verify (excluding the named AlertsCard footer)**

Run: `grep -n "<button" apps/web/src/panels/assistant/ActivityCard.tsx apps/web/src/panels/assistant/AuditRow.tsx apps/web/src/panels/assistant/OwnedResources.tsx apps/web/src/panels/assistant/tabs/ActivityTab.tsx apps/web/src/panels/assistant/tabs/AutoFixTab.tsx apps/web/src/panels/assistant/tabs/OverviewTab.tsx apps/web/src/panels/assistant/tabs/ReportsTab.tsx apps/web/src/panels/assistant/tabs/RulesTab.tsx apps/web/src/panels/assistant/agents/CredentialsManager.tsx apps/web/src/panels/assistant/agents/CredentialSourceDialog.tsx apps/web/src/panels/assistant/agents/NamespaceMultiSelect.tsx apps/web/src/panels/assistant/components/LinkRepoModal.tsx`

Then separately: `grep -n "<button" apps/web/src/panels/assistant/AlertsCard.tsx` — expect exactly the two footer elements (Cancel/Create alert) to remain.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/assistant
git commit -m "refactor(web): migrate assistant panel controls to Button (New alert modal footer kept bespoke)"
```

---

## Task 6: Migrate `panels/chat/*` batch

**Files (modify):**
- `apps/web/src/panels/chat/ActionProgressToast.tsx`
- `apps/web/src/panels/chat/ChatHistorySheet.tsx`
- `apps/web/src/panels/chat/CodeBlock.tsx`
- `apps/web/src/panels/chat/MessageBubble.tsx`
- `apps/web/src/panels/chat/SuggestedActionList.tsx`
- `apps/web/src/panels/chat/SuggestedAlertList.tsx`
- `apps/web/src/panels/chat/SuggestedPromptsRow.tsx`
- `apps/web/src/panels/chat/SuggestedQuestionList.tsx`
- `apps/web/src/panels/chat/ThinkingPane.tsx`
- `apps/web/src/panels/chat/ToolCard.tsx`

- [ ] **Step 1: Apply the migration recipe to each file**

This directory is the heaviest inline-`style={{}}` user (58 occurrences).
`SuggestedActionList.tsx`'s color-coded action buttons (`miniBtn(active)`
helper, the "All"/"None"/"Run selected" mini controls, the per-action
execute button) are genuine controls → migrate to `Button` with
`variant="outline"`/`"default"`/`"destructive"` chosen by the action's
existing color, using `className` for any per-action dynamic accent color
that can't collapse into a fixed variant. `SuggestedQuestionList.tsx`'s
per-option select rows (`rowStyle`) are single-select list rows → leave
native per the row/card holdout rule; only its "Submit" button (bounded,
icon+label) migrates. `ChatHistorySheet.tsx`'s per-chat delete/close icon
buttons migrate to `Button variant="ghost" size="icon-xs"`; its chat-list row
items stay native.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: No errors in the ten files above.

- [ ] **Step 3: Run affected tests**

Run: `pnpm --filter web test -- panels/chat`
Expected: PASS.

- [ ] **Step 4: Grep verify**

Run: `grep -n "<button" apps/web/src/panels/chat/ActionProgressToast.tsx apps/web/src/panels/chat/ChatHistorySheet.tsx apps/web/src/panels/chat/CodeBlock.tsx apps/web/src/panels/chat/MessageBubble.tsx apps/web/src/panels/chat/SuggestedActionList.tsx apps/web/src/panels/chat/SuggestedAlertList.tsx apps/web/src/panels/chat/SuggestedPromptsRow.tsx apps/web/src/panels/chat/SuggestedQuestionList.tsx apps/web/src/panels/chat/ThinkingPane.tsx apps/web/src/panels/chat/ToolCard.tsx`
Expected: Only documented row holdouts (`SuggestedQuestionList.tsx` option
rows, `ChatHistorySheet.tsx` list rows) remain; note them in the commit.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/chat
git commit -m "refactor(web): migrate chat panel controls to Button"
```

---

## Task 7: Migrate `panels/gitops/*` batch

**Files (modify):**
- `apps/web/src/panels/gitops/AddSourceDialog.tsx`
- `apps/web/src/panels/gitops/DeploymentRow.tsx`
- `apps/web/src/panels/gitops/GitOpsFileEditDialog.tsx`
- `apps/web/src/panels/gitops/RepoCombobox.tsx`
- `apps/web/src/panels/gitops/RepoPathBrowser.tsx`
- `apps/web/src/panels/gitops/GitOpsLinkWorkloadDialog.tsx` (footer excluded — see below)

**Partial exclusion:** In `GitOpsLinkWorkloadDialog.tsx`, the footer ("Cancel"
+ "Link workload", lines ~200-217) is a named Pencil exception — leave
untouched. The header close-X button (line ~86-93) is **not** named as an
exception and is a genuine bounded icon control → migrate to `<Button
variant="ghost" size="icon-sm">`. The workload-picker list rows (lines
~134-167) are the row/card holdout — leave native.

- [ ] **Step 1: Apply the migration recipe to each file**

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: No errors in the six files above.

- [ ] **Step 3: Run affected tests**

Run: `pnpm --filter web test -- panels/gitops`
Expected: PASS.

- [ ] **Step 4: Grep verify**

Run: `grep -n "<button" apps/web/src/panels/gitops/AddSourceDialog.tsx apps/web/src/panels/gitops/DeploymentRow.tsx apps/web/src/panels/gitops/GitOpsFileEditDialog.tsx apps/web/src/panels/gitops/RepoCombobox.tsx apps/web/src/panels/gitops/RepoPathBrowser.tsx`

Then: `grep -n "<button" apps/web/src/panels/gitops/GitOpsLinkWorkloadDialog.tsx` — expect the footer's two elements plus the workload-picker row buttons only (header close-X should be gone).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/gitops
git commit -m "refactor(web): migrate gitops panel controls to Button (Link workload modal footer kept bespoke)"
```

---

## Task 8: Migrate `panels/catalog/*` and `panels/helm/*` batch

**Files (modify):**
- `apps/web/src/panels/catalog/CatalogInstallWizard.tsx`
- `apps/web/src/panels/catalog/CatalogPanel.tsx`
- `apps/web/src/panels/catalog/LinkWorkloadPickerSheet.tsx`
- `apps/web/src/panels/catalog/NodeFitPanel.tsx`
- `apps/web/src/panels/catalog/steps/SecretsStep.tsx`
- `apps/web/src/panels/helm/BrowseChartsView.tsx`
- `apps/web/src/panels/helm/HelmConfirmModal.tsx`
- `apps/web/src/panels/helm/InstallChartView.tsx`
- `apps/web/src/panels/helm/ReleasesView.tsx`

- [ ] **Step 1: Apply the migration recipe to each file**

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: No errors in the nine files above.

- [ ] **Step 3: Run affected tests**

Run: `pnpm --filter web test -- panels/catalog panels/helm`
Expected: PASS (`HelmPanel.test.tsx` covers `ReleasesView`/related — update
any selector asserting hand-rolled `className`).

- [ ] **Step 4: Grep verify**

Run: `grep -n "<button" apps/web/src/panels/catalog/CatalogInstallWizard.tsx apps/web/src/panels/catalog/CatalogPanel.tsx apps/web/src/panels/catalog/LinkWorkloadPickerSheet.tsx apps/web/src/panels/catalog/NodeFitPanel.tsx apps/web/src/panels/catalog/steps/SecretsStep.tsx apps/web/src/panels/helm/BrowseChartsView.tsx apps/web/src/panels/helm/HelmConfirmModal.tsx apps/web/src/panels/helm/InstallChartView.tsx apps/web/src/panels/helm/ReleasesView.tsx`
Expected: No matches (or documented holdouts only).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/catalog apps/web/src/panels/helm
git commit -m "refactor(web): migrate catalog/helm panel controls to Button"
```

---

## Task 9: Migrate `panels/settings/*` batch

**Files (modify):**
- `apps/web/src/panels/settings/agents/AgentCard.tsx`
- `apps/web/src/panels/settings/agents/AgentSetup.tsx`
- `apps/web/src/panels/settings/MatrixConnectModal.tsx`
- `apps/web/src/panels/settings/MatrixSection.tsx`
- `apps/web/src/panels/settings/MatrixWizardParts.tsx`
- `apps/web/src/panels/settings/SignalSection.tsx`

- [ ] **Step 1: Apply the migration recipe to each file**

This directory is the second-heaviest inline-`style={{}}` user (135
occurrences) — the Matrix wizard parts in particular. Take it step-by-step
per component; `MatrixWizardParts.tsx` may have multiple wizard-step "Next"/
"Back" buttons reusing a shared style object, same pattern as
`OnboardingWizard.tsx` in Task 3.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: No errors in the six files above.

- [ ] **Step 3: Run affected tests**

Run: `pnpm --filter web test -- panels/settings`
Expected: PASS (`MatrixConnectModal.test.tsx` and any Signal/Agent tests).

- [ ] **Step 4: Grep verify**

Run: `grep -n "<button" apps/web/src/panels/settings/agents/AgentCard.tsx apps/web/src/panels/settings/agents/AgentSetup.tsx apps/web/src/panels/settings/MatrixConnectModal.tsx apps/web/src/panels/settings/MatrixSection.tsx apps/web/src/panels/settings/MatrixWizardParts.tsx apps/web/src/panels/settings/SignalSection.tsx`
Expected: No matches (or documented holdouts only).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/settings
git commit -m "refactor(web): migrate settings panel controls to Button"
```

---

## Task 10: Migrate `panels/configmaps/*`, `panels/secrets/*`, `panels/deployments/*` batch

**Files (modify):**
- `apps/web/src/panels/configmaps/ConfigMapDetail.tsx`
- `apps/web/src/panels/configmaps/ConfigMapsPanel.tsx`
- `apps/web/src/panels/secrets/SecretEditor.tsx`
- `apps/web/src/panels/secrets/SecretsPanel.tsx`
- `apps/web/src/panels/deployments/DeploymentEditor.tsx`
- `apps/web/src/panels/deployments/DeploymentRow.tsx`
- `apps/web/src/panels/deployments/ImagePullSecretsField.tsx`
- `apps/web/src/panels/configmaps/ConfigMapEditor.tsx` (footer likely-exception — verify first, see below)

**Before touching `ConfigMapEditor.tsx`:** per the spec, its footer
(`px-[22px] py-[11px]` accent CTA + `px-5 py-[11px]` outline cancel, lines
~270-284) is byte-identical to the two named Pencil exceptions. Check the
Pencil design (`panels/configmaps/ConfigMapDetail.tsx`'s "improved" redesign
frame, commit `959f7045`) before deciding: if it's confirmed part of the same
bespoke redesign family, leave the footer untouched and migrate only the
file's other buttons (if any); if not confirmed, migrate it like any other
file and note the deviation in the commit message.

- [ ] **Step 1: Apply the migration recipe to each file**

`ConfigMapDetail.tsx`'s "Copy" button (line ~200) is the copy-chip pattern →
`<Button variant="ghost" size="xs">`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: No errors in the eight files above.

- [ ] **Step 3: Run affected tests**

Run: `pnpm --filter web test -- ConfigMap Secret Deployment`
Expected: PASS.

- [ ] **Step 4: Grep verify**

Run: `grep -n "<button" apps/web/src/panels/configmaps/ConfigMapDetail.tsx apps/web/src/panels/configmaps/ConfigMapsPanel.tsx apps/web/src/panels/secrets/SecretEditor.tsx apps/web/src/panels/secrets/SecretsPanel.tsx apps/web/src/panels/deployments/DeploymentEditor.tsx apps/web/src/panels/deployments/DeploymentRow.tsx apps/web/src/panels/deployments/ImagePullSecretsField.tsx apps/web/src/panels/configmaps/ConfigMapEditor.tsx`
Expected: No matches, except `ConfigMapEditor.tsx`'s footer if confirmed as a kept exception.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/configmaps apps/web/src/panels/secrets apps/web/src/panels/deployments
git commit -m "refactor(web): migrate configmap/secret/deployment editor controls to Button"
```

---

## Task 11: Migrate `panels/workloads/*` and `panels/services/*` batch

**Files (modify):**
- `apps/web/src/panels/workloads/CronJobRow.tsx`
- `apps/web/src/panels/workloads/DaemonSetRow.tsx`
- `apps/web/src/panels/workloads/JobRow.tsx`
- `apps/web/src/panels/workloads/StatefulSetRow.tsx`
- `apps/web/src/panels/workloads/WorkloadsPanel.tsx`
- `apps/web/src/panels/services/ActiveForwardsList.tsx`
- `apps/web/src/panels/services/ServiceDetail.tsx`
- `apps/web/src/panels/services/ServicesPanel.tsx`

- [ ] **Step 1: Apply the migration recipe to each file**

The `*Row.tsx` files are row-detail expand/action controls (kebab menus,
scale/restart/delete triggers) — these are bounded icon/label controls, not
the row itself, so they're in scope even though they live inside a row
component. `variant="destructive"` for delete/scale-down type actions is
already the dominant pattern here (per spec, `StatefulSetRow.tsx`,
`JobRow.tsx`, `CronJobRow.tsx`, `DaemonSetRow.tsx` already use
`variant="destructive"` on `Button` for some actions — only the *remaining*
hand-rolled ones in these files need migrating).

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: No errors in the eight files above.

- [ ] **Step 3: Run affected tests**

Run: `pnpm --filter web test -- Workloads CronJob DaemonSet StatefulSet Job Service`
Expected: PASS.

- [ ] **Step 4: Grep verify**

Run: `grep -n "<button" apps/web/src/panels/workloads/CronJobRow.tsx apps/web/src/panels/workloads/DaemonSetRow.tsx apps/web/src/panels/workloads/JobRow.tsx apps/web/src/panels/workloads/StatefulSetRow.tsx apps/web/src/panels/workloads/WorkloadsPanel.tsx apps/web/src/panels/services/ActiveForwardsList.tsx apps/web/src/panels/services/ServiceDetail.tsx apps/web/src/panels/services/ServicesPanel.tsx`
Expected: No matches (or documented holdouts only).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/workloads apps/web/src/panels/services
git commit -m "refactor(web): migrate workload/service row controls to Button"
```

---

## Task 12: Migrate remaining small panels batch

**Files (modify):**
- `apps/web/src/panels/accounts/AccountsPanel.tsx`
- `apps/web/src/panels/certificates/CertificatesPanel.tsx`
- `apps/web/src/panels/connectivity/ConnectivityPanel.tsx`
- `apps/web/src/panels/databases/DatabasesPanel.tsx`
- `apps/web/src/panels/events/EventsPanel.tsx`
- `apps/web/src/panels/ingresses/IngressesPanel.tsx`
- `apps/web/src/panels/logs/LogsPanel.tsx`
- `apps/web/src/panels/namespaces/NamespacesPanel.tsx`
- `apps/web/src/panels/nodes/NodesPanel.tsx`
- `apps/web/src/panels/overview/OverviewPanel.tsx`
- `apps/web/src/panels/pods/PodsPanel.tsx`
- `apps/web/src/panels/purge/PurgePickerSheet.tsx`
- `apps/web/src/panels/purge/PurgeSheet.tsx`
- `apps/web/src/panels/rbac/RbacPanel.tsx`
- `apps/web/src/panels/rightsizing/MetricsInstallDialog.tsx`
- `apps/web/src/panels/rightsizing/RightSizingPanel.tsx`
- `apps/web/src/panels/storage/StoragePanel.tsx`

Each of these files has only 1-6 hand-rolled buttons (per audit), so this
batch is wide but shallow.

- [ ] **Step 1: Apply the migration recipe to each file**

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: No errors in the 17 files above.

- [ ] **Step 3: Run affected tests**

Run: `pnpm --filter web test -- Accounts Certificates Connectivity Databases Events Ingresses Logs Namespaces Nodes Overview Pods Purge Rbac Metrics RightSizing Storage`
Expected: PASS.

- [ ] **Step 4: Grep verify**

Run: `grep -n "<button" apps/web/src/panels/accounts/AccountsPanel.tsx apps/web/src/panels/certificates/CertificatesPanel.tsx apps/web/src/panels/connectivity/ConnectivityPanel.tsx apps/web/src/panels/databases/DatabasesPanel.tsx apps/web/src/panels/events/EventsPanel.tsx apps/web/src/panels/ingresses/IngressesPanel.tsx apps/web/src/panels/logs/LogsPanel.tsx apps/web/src/panels/namespaces/NamespacesPanel.tsx apps/web/src/panels/nodes/NodesPanel.tsx apps/web/src/panels/overview/OverviewPanel.tsx apps/web/src/panels/pods/PodsPanel.tsx apps/web/src/panels/purge/PurgePickerSheet.tsx apps/web/src/panels/purge/PurgeSheet.tsx apps/web/src/panels/rbac/RbacPanel.tsx apps/web/src/panels/rightsizing/MetricsInstallDialog.tsx apps/web/src/panels/rightsizing/RightSizingPanel.tsx apps/web/src/panels/storage/StoragePanel.tsx`
Expected: No matches (or documented holdouts only).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/accounts apps/web/src/panels/certificates apps/web/src/panels/connectivity apps/web/src/panels/databases apps/web/src/panels/events apps/web/src/panels/ingresses apps/web/src/panels/logs apps/web/src/panels/namespaces apps/web/src/panels/nodes apps/web/src/panels/overview apps/web/src/panels/pods apps/web/src/panels/purge apps/web/src/panels/rbac apps/web/src/panels/rightsizing apps/web/src/panels/storage
git commit -m "refactor(web): migrate remaining small panels to Button"
```

---

## Task 13: Final gate

- [ ] **Step 1: Full repo typecheck**

Run: `pnpm --filter web typecheck`
Expected: Zero errors.

- [ ] **Step 2: Full web test suite**

Run: `pnpm --filter web test`
Expected: PASS.

- [ ] **Step 3: Full web build**

Run: `pnpm --filter web build`
Expected: Success.

- [ ] **Step 4: Repo-wide grep for stray hand-rolled buttons**

Run:

```bash
grep -rln "<button" apps/web/src
```

Expected: only these remain, matching the spec's documented exceptions and
holdouts:
- `apps/web/src/panels/assistant/AlertsCard.tsx` (New alert modal footer)
- `apps/web/src/panels/gitops/GitOpsLinkWorkloadDialog.tsx` (Link workload
  modal footer + workload-picker rows)
- `apps/web/src/shell/AccountModal.tsx` (Sign out / Done footer)
- `apps/web/src/panels/configmaps/ConfigMapEditor.tsx` (if confirmed as the
  fourth Pencil exception in Task 10)
- Any row/card holdouts documented per-batch (e.g.
  `panels/components/ListRow.tsx`, `panels/chat/SuggestedQuestionList.tsx`,
  `panels/chat/ChatHistorySheet.tsx` list rows,
  `panels/assistant/tabs/OverviewTab.tsx` banner cards)

If anything else appears, go back and migrate it or add it to this list with
a documented reason (it's a genuine row/card, not a button).

- [ ] **Step 5: Confirm `Button` adoption**

Run: `grep -rl "<Button" apps/web/src | wc -l`
Expected: A count meaningfully higher than the pre-migration baseline of 64
(should approach the ~100+ files that had at least one migrated button).

- [ ] **Step 6: Commit (if Step 4 required any final touch-ups)**

```bash
git add apps/web/src
git commit -m "chore(web): final button-standardization cleanup pass"
```

---

## Self-review notes

- **Spec coverage:** Task 1 delivers the one `Button` primitive change
  (default hover -> `--accent-hover`) plus new tests, matching the spec's
  "Design changes to Button itself" section. Tasks 2-12 cover all 102
  audited hand-rolling files, grouped by area exactly as counted in the
  audit (shell ~54 buttons across 2 tasks, chat 18, gitops 13, catalog 12 +
  helm 14 combined, settings 17, assistant 33, configmaps/secrets/deployments
  9+3+3, workloads/services 5+3, remaining small panels 36 combined). Task 13
  implements the spec's Testing section gates verbatim (typecheck, test,
  build, grep sweep).
- **Named exceptions preserved:** all three ticket-named exceptions
  (`AlertsCard.tsx` New alert footer, `GitOpsLinkWorkloadDialog.tsx` Link
  workload footer, `AccountModal.tsx`) are called out with exact
  line-range context in their respective tasks (5, 7, and "excluded
  entirely" in Task 3) so an implementer can't accidentally migrate them.
  The unnamed but pattern-identical `ConfigMapEditor.tsx` footer gets an
  explicit verify-before-migrating instruction in Task 10 rather than a
  silent assumption either way.
- **Row/card scope boundary:** every task that touches a file with both
  real buttons and list-style rows (gitops picker, chat option rows,
  ListRow, OverviewTab banners) states explicitly which elements stay
  native, so the grep-verify steps don't false-positive on intentional
  holdouts.
