# Standardized Dialog Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `apps/web/src/components/ui/dialog.tsx` the single styled source of truth for every dialog (one header treatment, one body, one title, one footer), retire `ui/modal.tsx`, and migrate all ~41 dialog consumers onto the standardized composition.

**Architecture:** `DialogContent` becomes a padding-free graphite flex-column shell. `DialogHeader` becomes a hairline header bar with a left slot (title, title+icon, or a tab row) that owns the close **X**. A new `DialogBody` is the one padded scroll region; `DialogFooter` becomes a sibling hairline bar. A new `DialogIcon` ports `ModalIcon`. `ui/modal.tsx` is deleted and its consumers hand-roll the composition. TypeScript's compiler drives the migration (removed exports + removed `showCloseButton` prop flag every call site).

**Tech Stack:** React 19, `@base-ui/react/dialog`, Tailwind v4, theme CSS variables in `index.css`, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-07-01-standardized-dialog-primitives-design.md`

---

## Migration recipe (reference for all Group A/B tasks)

**Group A — `ui/modal.tsx` consumers** (`import { Modal | TabModal | ModalIcon } from "@/components/ui/modal"`):

- `<Modal open onOpenChange title maxWidth icon iconBackground>{body}</Modal>` becomes:
  ```tsx
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className={maxWidth /* e.g. "max-w-md" */}>
      <DialogHeader>
        {icon && <DialogIcon background={iconBackground}>{icon}</DialogIcon>}
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody>{body}</DialogBody>
    </DialogContent>
  </Dialog>
  ```
  Note: `maxWidth` prop values were like `"!max-w-md"` / `"!max-w-2xl"`; drop the `!` — `className` on `DialogContent` overrides the default `max-w-md` without needing `!important`.
- `<TabModal open onOpenChange title tabs defaultTab maxWidth>` becomes local tab state + the tab row in the header slot:
  ```tsx
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.id ?? "");
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={maxWidth}>
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogHeader>
          <SegmentedTabs
            tabs={tabs.map((t) => ({ id: t.id, label: t.label }))}
            active={current?.id ?? ""}
            onChange={setActive}
          />
        </DialogHeader>
        <DialogBody>{current?.content}</DialogBody>
      </DialogContent>
    </Dialog>
  );
  ```
- `<ModalIcon>` becomes `<DialogIcon>` (same `background` prop).

**Group B — direct `ui/dialog.tsx` consumers:**

1. Wrap the content that sits between `<DialogHeader>` and `<DialogFooter>` (or end of content) in `<DialogBody>…</DialogBody>`.
2. If a `<DialogDescription>` was stacked inside the old flex-col `<DialogHeader>`, move it to the top of `<DialogBody>` (the header is now a horizontal bar and only holds the title/tabs).
3. Remove any `showCloseButton` prop passed to `<DialogContent>` — the header renders the **X** by default. If a dialog intentionally has no close affordance, put `showClose={false}` on its `<DialogHeader>`.
4. Replace hand-written hairlines/hex/inline padding that duplicated the shell (e.g. `style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}`, raw `#101012`) with the primitives. Keep genuinely content-specific inline styles.
5. Import `DialogBody` (and `DialogIcon` where an icon tile is used) from `@/components/ui/dialog`.

**After every task:** `pnpm --filter web typecheck` must be clean for the files touched, and the task's commit only lands once green.

---

## Task 1: Standardize the primitives in `dialog.tsx`

**Files:**
- Modify: `apps/web/src/components/ui/dialog.tsx`
- Test: `apps/web/src/components/ui/dialog.test.tsx` (create)

- [ ] **Step 1: Write failing tests for the new behavior**

Create `apps/web/src/components/ui/dialog.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogIcon,
} from "./dialog";

function open(children: React.ReactNode) {
  return render(
    <Dialog open onOpenChange={() => {}}>
      <DialogContent>{children}</DialogContent>
    </Dialog>,
  );
}

describe("DialogHeader", () => {
  it("renders a close button by default", () => {
    open(
      <>
        <DialogHeader>
          <DialogTitle>Hi</DialogTitle>
        </DialogHeader>
        <DialogBody>body</DialogBody>
      </>,
    );
    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
  });

  it("hides the close button when showClose is false", () => {
    open(
      <DialogHeader showClose={false}>
        <DialogTitle>Hi</DialogTitle>
      </DialogHeader>,
    );
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });
});

describe("DialogBody", () => {
  it("renders its children", () => {
    open(<DialogBody>hello body</DialogBody>);
    expect(screen.getByText("hello body")).toBeInTheDocument();
  });
});

describe("DialogIcon", () => {
  it("renders its children", () => {
    open(
      <DialogHeader>
        <DialogIcon>
          <svg data-testid="ic" />
        </DialogIcon>
        <DialogTitle>Hi</DialogTitle>
      </DialogHeader>,
    );
    expect(screen.getByTestId("ic")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web test -- dialog.test`
Expected: FAIL — `DialogBody` and `DialogIcon` are not exported; the close button assertions fail because the current `DialogContent` renders close via `showCloseButton` (default true) but as an absolute button that this new structure test may still find — the `DialogBody`/`DialogIcon` import errors will fail the file regardless.

- [ ] **Step 3: Rewrite `dialog.tsx` with the standardized primitives**

Replace the full contents of `apps/web/src/components/ui/dialog.tsx` with:

```tsx
import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

// Graphite shell — the app-wide default for every dialog. Padding-free flex
// column: DialogHeader / DialogBody / DialogFooter own their own spacing.
// Anchored a fixed distance from the top (not vertically centered) so the modal
// doesn't jump as its content height changes. The bespoke #101012 graphite
// (darker than --surface-primary on purpose) lives here and nowhere else.
function DialogContent({
  className,
  children,
  ...props
}: DialogPrimitive.Popup.Props) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-[8vh] left-1/2 z-50 flex max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col overflow-hidden rounded-2xl bg-[#101012] text-sm text-popover-foreground shadow-[0_30px_80px_rgba(0,0,0,0.45)] ring-1 ring-white/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

// The one header treatment: a hairline-separated bar. Children (a DialogTitle,
// a DialogIcon + DialogTitle, or a tab row) sit on the left; the close X is
// rendered here on the right unless showClose is false.
function DialogHeader({
  className,
  showClose = true,
  children,
  ...props
}: React.ComponentProps<"div"> & { showClose?: boolean }) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex shrink-0 items-center justify-between gap-4 border-b border-white/[0.07] px-[18px] py-3.5",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">{children}</div>
      {showClose && (
        <DialogPrimitive.Close
          data-slot="dialog-close"
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-[var(--fg-tertiary)] hover:text-[var(--fg-primary)]"
            />
          }
        >
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

// Leading-icon tile for a header (ports the old ModalIcon). background={false}
// for a bare icon. Icon inherits white via currentColor.
function DialogIcon({
  background = true,
  className,
  ...props
}: React.ComponentProps<"div"> & { background?: boolean }) {
  return (
    <div
      data-slot="dialog-icon"
      className={cn(
        "flex size-[30px] shrink-0 items-center justify-center text-white",
        background && "rounded-lg bg-white/[0.07]",
        className,
      )}
      {...props}
    />
  );
}

// The one padded scroll region. Everything between header and footer goes here.
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("flex-1 overflow-y-auto px-6 pt-6 pb-7", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t border-white/[0.07] px-6 py-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogIcon,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web test -- dialog.test`
Expected: PASS (all three describe blocks).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/dialog.tsx apps/web/src/components/ui/dialog.test.tsx
git commit -m "feat(web): standardize dialog primitives (header bar, DialogBody, DialogIcon)"
```

Note: `pnpm --filter web typecheck` will now report errors in every current consumer (they still pass `showCloseButton` and/or rely on the old header/padding). That is expected — the consumer migrations in Tasks 2-7 clear them. Do not attempt a repo-wide typecheck as this task's gate.

---

## Task 2: Migrate shell/* Modal consumers (Group A)

**Files (modify):**
- `apps/web/src/shell/AccountModal.tsx`
- `apps/web/src/shell/CreateClusterModal.tsx`
- `apps/web/src/shell/ConnectClusterModal.tsx`
- `apps/web/src/shell/AddClusterChooser.tsx`
- `apps/web/src/shell/RemoveClusterDialog.tsx`
- `apps/web/src/shell/ClusterIconPicker.tsx`

- [ ] **Step 1: Apply the Group A recipe to each file**

For each file, replace `Modal`/`TabModal`/`ModalIcon` usage with the composition from the Migration recipe. Import `Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody` (and `DialogIcon` where an icon was passed) from `@/components/ui/dialog`; remove the `@/components/ui/modal` import. Convert `maxWidth="!max-w-md"` style props to `className="max-w-md"` on `DialogContent`.

Example — `AccountModal.tsx` header/shell (body unchanged):

```tsx
import { User, LogOut } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from "@/components/ui/dialog";

// ...props unchanged...

export function AccountModal({ open, onOpenChange, name, email, plan = "Free" }: AccountModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {/* existing body markup, unchanged */}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Typecheck the touched files**

Run: `pnpm --filter web typecheck`
Expected: No errors originating in the six files above (errors remaining in other not-yet-migrated consumers are fine).

- [ ] **Step 3: Run the affected tests**

Run: `pnpm --filter web test -- AccountModal RemoveClusterDialog ConnectClusterModal`
Expected: PASS. If a test queried the close button by its old absolute position or a `Modal` role, update the selector to `screen.getByRole("button", { name: /close/i })`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/shell
git commit -m "refactor(web): migrate shell modals to standardized dialog primitives"
```

---

## Task 3: Migrate panel Modal consumers (Group A) and delete `modal.tsx`

**Files (modify):**
- `apps/web/src/panels/assistant/tabs/ReportsTab.tsx`
- `apps/web/src/panels/rightsizing/MetricsRemoveDialog.tsx`
- `apps/web/src/panels/rightsizing/MetricsInstallDialog.tsx`
- `apps/web/src/panels/helm/ReleasesView.tsx`
- `apps/web/src/panels/helm/HelmConfirmModal.tsx`

**Files (delete):**
- `apps/web/src/components/ui/modal.tsx`

- [ ] **Step 1: Apply the Group A recipe to each panel file**

Same transformation as Task 2. If any of these used `TabModal`, apply the `TabModal` branch of the recipe (local `useState` + `SegmentedTabs` in the header slot, imported from `@/components/ui/SegmentedTabs`).

- [ ] **Step 2: Verify nothing imports `ui/modal` anymore**

Run: `grep -rn "components/ui/modal" apps/web/src`
Expected: No matches.

- [ ] **Step 3: Delete `modal.tsx`**

```bash
git rm apps/web/src/components/ui/modal.tsx
```

- [ ] **Step 4: Typecheck the touched files**

Run: `pnpm --filter web typecheck`
Expected: No errors in the five panel files above or from the deleted module (errors remaining in Group B consumers are fine).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels apps/web/src/components/ui/modal.tsx
git commit -m "refactor(web): migrate panel modals; delete ui/modal.tsx"
```

---

## Task 4: Migrate Group B batch 1 — confirm/purge sheets

**Files (modify):**
- `apps/web/src/components/ConfirmSheet.tsx`
- `apps/web/src/components/BatchConfirmSheet.tsx`
- `apps/web/src/panels/purge/PurgeSheet.tsx`
- `apps/web/src/panels/purge/PurgePickerSheet.tsx`
- `apps/web/src/components/ResourceYamlViewer.tsx`

- [ ] **Step 1: Apply the Group B recipe to each file**

Wrap the between-header-and-footer content in `<DialogBody>`; move any `<DialogDescription>` from inside `<DialogHeader>` to the top of `<DialogBody>`; remove `showCloseButton` from `<DialogContent>` (add `showClose={false}` on `<DialogHeader>` only if a dialog intentionally omits the X); add the `DialogBody` import.

Example — a `ConfirmSheet`-style header+body+footer before/after:

```tsx
// before
<DialogContent>
  <DialogHeader>
    <DialogTitle>Run command</DialogTitle>
    <DialogDescription>This runs the exact command below.</DialogDescription>
  </DialogHeader>
  <div className="…command preview…">…</div>
  <DialogFooter>…buttons…</DialogFooter>
</DialogContent>

// after
<DialogContent>
  <DialogHeader>
    <DialogTitle>Run command</DialogTitle>
  </DialogHeader>
  <DialogBody>
    <DialogDescription>This runs the exact command below.</DialogDescription>
    <div className="…command preview…">…</div>
  </DialogBody>
  <DialogFooter>…buttons…</DialogFooter>
</DialogContent>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: No errors in the five files above.

- [ ] **Step 3: Run affected tests**

Run: `pnpm --filter web test -- ConfirmSheet BatchConfirmSheet Purge`
Expected: PASS (update close-button/structure selectors if needed).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components apps/web/src/panels/purge
git commit -m "refactor(web): migrate confirm/purge sheets to DialogBody"
```

---

## Task 5: Migrate Group B batch 2 — editors & catalog

**Files (modify):**
- `apps/web/src/panels/configmaps/ConfigMapEditor.tsx`
- `apps/web/src/panels/secrets/SecretEditor.tsx`
- `apps/web/src/panels/ingresses/IngressEditor.tsx`
- `apps/web/src/panels/deployments/DeploymentEditor.tsx`
- `apps/web/src/panels/catalog/CatalogInstallWizard.tsx`
- `apps/web/src/panels/catalog/CatalogDetailSheet.tsx`
- `apps/web/src/panels/catalog/LinkWorkloadPickerSheet.tsx`

- [ ] **Step 1: Apply the Group B recipe to each file**

Same as Task 4. These are larger dialogs; be careful to wrap only the scrollable body in `<DialogBody>` and keep header/footer as siblings.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: No errors in the seven files above.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels
git commit -m "refactor(web): migrate editor/catalog dialogs to DialogBody"
```

---

## Task 6: Migrate Group B batch 3 — gitops, scale, misc panels

**Files (modify):**
- `apps/web/src/panels/gitops/GitOpsLinkWorkloadDialog.tsx`
- `apps/web/src/panels/gitops/AddSourceDialog.tsx`
- `apps/web/src/panels/gitops/AddDeploymentDialog.tsx`
- `apps/web/src/panels/gitops/GitOpsFileEditDialog.tsx`
- `apps/web/src/panels/gitops/SyncDialog.tsx`
- `apps/web/src/panels/services/PortForwardDialog.tsx`
- `apps/web/src/panels/deployments/MoveToNamespaceDialog.tsx`
- `apps/web/src/panels/deployments/DeploymentScaleDialog.tsx`
- `apps/web/src/panels/workloads/WorkloadScaleDialog.tsx`
- `apps/web/src/panels/namespaces/NamespacesPanel.tsx`
- `apps/web/src/panels/accounts/AccountsPanel.tsx`

- [ ] **Step 1: Apply the Group B recipe to each file**

Same as Task 4.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: No errors in the eleven files above.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels
git commit -m "refactor(web): migrate gitops/scale/misc dialogs to DialogBody"
```

---

## Task 7: Migrate Group B batch 4 — assistant & settings, then final gate

**Files (modify):**
- `apps/web/src/panels/assistant/AssistantContext.tsx`
- `apps/web/src/panels/assistant/AlertsCard.tsx`
- `apps/web/src/panels/assistant/agents/CredentialSourceDialog.tsx`
- `apps/web/src/panels/assistant/agents/CredentialsManager.tsx`
- `apps/web/src/panels/assistant/agents/AssistantConfigSection.tsx`
- `apps/web/src/panels/assistant/components/LinkRepoModal.tsx`
- `apps/web/src/panels/settings/MatrixWizardParts.tsx`
- `apps/web/src/panels/settings/MatrixConnectModal.tsx`

- [ ] **Step 1: Apply the Group B recipe to each file**

Same as Task 4. `MatrixWizardParts` / the Matrix wizard may render multi-step content — keep each step's scroll region inside `<DialogBody>` and the step nav/title in `<DialogHeader>`.

- [ ] **Step 2: Full repo typecheck (all consumers now migrated)**

Run: `pnpm --filter web typecheck`
Expected: Zero errors across the whole web package.

- [ ] **Step 3: Full web test suite**

Run: `pnpm --filter web test`
Expected: PASS. Fix any remaining close-button/structure selector assertions in dialog/modal tests (`AccountModal.test.tsx`, `RemoveClusterDialog.test.tsx`, `ConnectClusterModal.test.tsx`, `MatrixConnectModal.test.tsx`, `LinkRepoModal.test.tsx`, `CredentialSourceDialog.test.tsx`).

- [ ] **Step 4: Full web build**

Run: `pnpm --filter web build`
Expected: Success.

- [ ] **Step 5: Verify no stragglers**

Run: `grep -rn "components/ui/modal\|showCloseButton" apps/web/src`
Expected: No matches (all `Modal`/`TabModal`/`ModalIcon` and `showCloseButton` usage removed).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "refactor(web): migrate assistant/settings dialogs; complete dialog standardization"
```

---

## Self-review notes

- **Spec coverage:** Task 1 delivers all six primitive changes + `DialogBody`/`DialogIcon` from the spec table. Tasks 2-3 cover Group A (11 files) and the `modal.tsx` deletion. Tasks 4-7 cover Group B (30 files), including the `*Sheet` components. Task 7 has the typecheck/test/build gates from the spec's Testing section. All spec sections map to a task.
- **Naming consistency:** `DialogBody`, `DialogIcon`, `DialogHeader` (with `showClose`), `DialogFooter` (with `showCloseButton`), `DialogContent` — names identical across Task 1's exports and every consumer task's imports.
- **`showClose` vs `showCloseButton`:** intentional and distinct — `showClose` gates the header's X (default true); `showCloseButton` gates the footer's text "Close" button (default false). Both preserved from prior behavior.
