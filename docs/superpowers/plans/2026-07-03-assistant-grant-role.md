# Grant the Assistant a Role — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Grant a role" button to the Assistant panel that opens the existing RBAC `BindingEditor` pre-seeded with the `rigel-assistant` ServiceAccount, so the user can bind the assistant to a chosen Role/ClusterRole through the guarded apply flow.

**Architecture:** One new self-contained launcher component (`GrantRoleButton`) that renders `BindingEditor` + `ConfirmSheet`, seeds the assistant's ServiceAccount as the binding subject, computes `roleOptions` from the store, and routes Apply through `applyManifest → ConfirmSheet`. Then wire it into `OwnedResources`. No server changes.

**Tech Stack:** React 19 + Vite + Tailwind v4 (tokens via arbitrary values), Zustand store, vitest (+ jsdom/RTL). Spec: `docs/superpowers/specs/2026-07-03-assistant-grant-role-design.md`. Reuses the RBAC write-actions feature already on this branch.

---

## Conventions

**Branch:** `feature/rbac-access-analysis` (continue on it; do NOT branch or touch master).

**Styling:** Tailwind utilities only, tokens via arbitrary values (`bg-[var(--surface-sunken)]`, `text-[var(--fg-primary)]`, `border-[var(--border-strong)]`).

**Reused APIs (verified in the RBAC write-actions code on this branch):**
- `BindingEditor` (`@/panels/rbac/components/BindingEditor`) props: `{ target: BindingTarget | null, open: boolean, onClose: () => void, onApply: (r: { yaml: string; label: string }) => void, onEditYaml?: () => void, roleOptions?: RoleOption[] }`. Exports `BindingTarget` and `RoleOption`.
  - `BindingTarget`: `{ kind: "RoleBinding" | "ClusterRoleBinding"; name: string; namespace?: string; labels?; annotations?; roleRef: RoleRef; subjects: Subject[]; focusSubjects? }`.
  - `RoleOption`: `{ kind: "Role" | "ClusterRole"; name: string; namespace?: string }`.
  - Create mode is triggered when `target.name` is empty (`isEdit = target != null && target.name.trim() !== ""`), so seed `name: ""` to get the editable name field + kind toggle. Apply requires a non-empty name and a chosen `roleRef.name`.
- `ConfirmSheet` (`@/components/ConfirmSheet`): `<ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={...} />`. Pass `{ kind: "applyManifest", label, manifest }`; it runs `kubectl apply -f -`.
- `ActionBlock` type: `import type { ActionBlock } from "@/lib/api"`.
- Store roles/clusterroles: `useCluster((s) => s.resources)` then `Object.values(resources["roles"] ?? {})` / `["clusterroles"]`. Types `Role`/`ClusterRole` from `@/panels/rbac/types`.
- Watches: `subscribe`/`unsubscribe` from `@/lib/ws`, ref-counted by `${kind}/${namespace}` (safe to add alongside other watches).

**Commands:**
- Single test: `pnpm --filter web exec vitest run <path>`
- Typecheck: `pnpm --filter web typecheck`
- Full web tests: `pnpm --filter web test`

**Scope note (matches spec):** v1 opens create mode with a **blank, user-typed binding name** (the auto-suggested `rigel-assistant-<role>` name is deferred — it would require a mode/name change to `BindingEditor`, which we don't touch). The pre-seeded subject, default `ClusterRoleBinding`, role dropdown, and guarded apply are all delivered.

---

## File structure

- **Create** `apps/web/src/panels/assistant/GrantRoleButton.tsx` — the launcher (button + BindingEditor + ConfirmSheet, seeds assistant SA subject, computes roleOptions, owns its role watches).
- **Create** `apps/web/src/panels/assistant/GrantRoleButton.test.tsx`.
- **Modify** `apps/web/src/panels/assistant/OwnedResources.tsx` — render `<GrantRoleButton namespace={ns} />` in the "Resources" section header.

---

## Task 1: GrantRoleButton launcher

**Files:**
- Create: `apps/web/src/panels/assistant/GrantRoleButton.tsx`
- Test: `apps/web/src/panels/assistant/GrantRoleButton.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/assistant/GrantRoleButton.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/store/cluster", () => ({
  useCluster: (sel: (s: { resources: Record<string, Record<string, unknown>> }) => unknown) =>
    sel({
      resources: {
        namespaces: { default: {}, rigel: {} },
        roles: {},
        clusterroles: { "1": { metadata: { name: "view" } } },
      },
    }),
}));
vi.mock("@/components/ConfirmSheet", () => ({
  ConfirmSheet: ({ open, action }: { open: boolean; action: { label?: string; manifest?: string } | null }) =>
    open ? <div data-testid="confirm">{`${action?.label ?? ""}\n${action?.manifest ?? ""}`}</div> : null,
}));

import { GrantRoleButton } from "./GrantRoleButton";

afterEach(cleanup);

test("grants the assistant a clusterrole via a pre-seeded binding", () => {
  render(<GrantRoleButton namespace="rigel" />);
  fireEvent.click(screen.getByRole("button", { name: /Grant a role/ }));

  // Binding editor opens in create mode with the assistant SA pre-seeded.
  expect(screen.getByText("New binding")).toBeTruthy();
  expect((screen.getByLabelText("Subject name") as HTMLInputElement).value).toBe("rigel-assistant");

  // Name the binding and pick the clusterrole.
  fireEvent.change(screen.getByLabelText("Binding name"), { target: { value: "rigel-assistant-view" } });
  fireEvent.change(screen.getByLabelText("Role ref name"), { target: { value: "view" } });
  fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));

  const confirm = screen.getByTestId("confirm").textContent ?? "";
  expect(confirm).toContain("Apply ClusterRoleBinding rigel-assistant-view");
  expect(confirm).toContain("kind: ServiceAccount");
  expect(confirm).toContain("name: 'rigel-assistant'");
  expect(confirm).toContain("namespace: 'rigel'");
  expect(confirm).toContain("kind: ClusterRole");
  expect(confirm).toContain("name: 'view'");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/panels/assistant/GrantRoleButton.test.tsx`
Expected: FAIL "Cannot find module './GrantRoleButton'".

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/panels/assistant/GrantRoleButton.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { ShieldPlus } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import type { ActionBlock } from "@/lib/api";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import {
  BindingEditor,
  type BindingTarget,
  type RoleOption,
} from "@/panels/rbac/components/BindingEditor";
import type { ClusterRole, Role } from "@/panels/rbac/types";

function values<T>(rec: Record<string, T> | undefined): T[] {
  return Object.values(rec ?? {});
}

interface Props {
  /** The assistant's install namespace — where its ServiceAccount lives. */
  namespace: string;
}

/**
 * "Grant a role" — opens the RBAC BindingEditor pre-seeded with the assistant's
 * `rigel-assistant` ServiceAccount so the user can bind it to a chosen
 * Role/ClusterRole. Applies through the same guarded applyManifest → ConfirmSheet
 * path as every other RBAC write.
 */
export function GrantRoleButton({ namespace }: Props) {
  const resources = useCluster((s) => s.resources);
  const [open, setOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);

  // The roleRef dropdown needs the cluster's roles/clusterroles — own the watch
  // while the editor is open so it works even if the RBAC panel was never opened.
  useEffect(() => {
    if (!open) return;
    subscribe("roles", "*");
    subscribe("clusterroles", "*");
    return () => {
      unsubscribe("roles", "*");
      unsubscribe("clusterroles", "*");
    };
  }, [open]);

  const roleOptions: RoleOption[] = useMemo(
    () => [
      ...values<Role>(resources["roles"] as Record<string, Role>).map((r) => ({
        kind: "Role" as const,
        name: r.metadata.name,
        namespace: r.metadata.namespace,
      })),
      ...values<ClusterRole>(resources["clusterroles"] as Record<string, ClusterRole>).map((r) => ({
        kind: "ClusterRole" as const,
        name: r.metadata.name,
      })),
    ],
    [resources],
  );

  const target: BindingTarget = useMemo(
    () => ({
      kind: "ClusterRoleBinding",
      name: "",
      roleRef: { kind: "ClusterRole", name: "" },
      subjects: [{ kind: "ServiceAccount", name: "rigel-assistant", namespace }],
    }),
    [namespace],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-sunken)] px-3 py-1.5 text-[13px] font-medium text-[var(--fg-primary)] transition-colors hover:bg-white/[0.08]"
      >
        <ShieldPlus className="size-[14px]" /> Grant a role
      </button>
      {open && (
        <BindingEditor
          target={target}
          open
          roleOptions={roleOptions}
          onClose={() => setOpen(false)}
          onApply={(result) => {
            setOpen(false);
            setPendingAction({ kind: "applyManifest", label: result.label, manifest: result.yaml });
          }}
        />
      )}
      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run src/panels/assistant/GrantRoleButton.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS. (If `ShieldPlus` isn't in the installed lucide-react version, substitute the closest valid icon — e.g. `KeyRound` or `Plus` — and note it.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/assistant/GrantRoleButton.tsx apps/web/src/panels/assistant/GrantRoleButton.test.tsx
git commit -m "feat(assistant): GrantRoleButton — bind the assistant SA to a chosen role"
```

---

## Task 2: Wire into OwnedResources

**Files:**
- Modify: `apps/web/src/panels/assistant/OwnedResources.tsx`

`OwnedResources` reads the install namespace from `useAssistantCtx()` as `ns = d.installedNamespace ?? ""` and returns `null` when not installed, so the button only renders for an installed assistant.

- [ ] **Step 1: Add the import**

At the top of `apps/web/src/panels/assistant/OwnedResources.tsx`, add:

```tsx
import { GrantRoleButton } from "./GrantRoleButton";
```

- [ ] **Step 2: Render the button in the section header**

In the `return` of `OwnedResources`, change the header row so the button sits to the right of the title + count. Replace:

```tsx
      <div className="flex items-center gap-2">
        <h3 className="text-base font-semibold text-[var(--fg-primary)]">Resources</h3>
        <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-2 py-0.5 font-mono text-xs font-semibold text-[var(--fg-secondary)]">
          {total}
        </span>
      </div>
```

with:

```tsx
      <div className="flex items-center gap-2">
        <h3 className="text-base font-semibold text-[var(--fg-primary)]">Resources</h3>
        <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-2 py-0.5 font-mono text-xs font-semibold text-[var(--fg-secondary)]">
          {total}
        </span>
        <GrantRoleButton namespace={ns} />
      </div>
```

(`GrantRoleButton`'s own `ml-auto` pushes it to the right edge of the header row.)

- [ ] **Step 3: Typecheck + full suite**

Run: `pnpm --filter web typecheck`
Expected: PASS.
Run: `pnpm --filter web test`
Expected: PASS (all, including the new GrantRoleButton test). No dedicated OwnedResources render test is added — it depends on the `useAssistantCtx` provider, and the button is fully covered standalone in Task 1.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/panels/assistant/OwnedResources.tsx
git commit -m "feat(assistant): surface Grant a role in the owned-resources header"
```

---

## Task 3: Verify

**Files:** none unless verification surfaces a defect.

- [ ] **Step 1: Full suite + typecheck + build**

Run: `pnpm --filter web test`
Expected: PASS.
Run: `pnpm --filter web typecheck`
Expected: PASS.
Run: `pnpm --filter web build`
Expected: succeeds.

- [ ] **Step 2: Visual/behaviour check (reuse)**

The dialog is the already-shipped `BindingEditor` (frame `spBkt`). Confirm the "Grant a role" button appears in the Assistant → Overview "Resources" header, opens the binding editor with the `rigel-assistant` ServiceAccount pre-seeded as the one subject and `ClusterRoleBinding` selected, that picking a ClusterRole + naming the binding + Apply opens the guarded `ConfirmSheet` showing the `kubectl apply`, and that after apply the new binding shows the assistant's grant in the RBAC analyzer (flagged dangerous if applicable). Do not start the web dev server; live checks via `pnpm --filter desktop dev` only if the user asks.

- [ ] **Step 3: Update Outline + Plane**

Document the "grant the assistant a role" capability in the app's Outline doc and derive a Plane ticket under the Rigel (HELM) project.

---

## Self-review notes (author)

- **Spec coverage:** entry point in `OwnedResources` (T2) ✓; opens `BindingEditor` pre-seeded with the `rigel-assistant` SA in the install namespace (T1) ✓; default `ClusterRoleBinding` + `ClusterRole` roleRef, user picks the role from the dropdown (T1, reuses BindingEditor) ✓; guarded `applyManifest → ConfirmSheet` (T1) ✓; roleOptions from the store with self-owned watch (T1) ✓; active-cluster scope + reuse-only, no server changes ✓; revoke = existing delete (no task needed) ✓. **Deviation:** the spec's auto-suggested binding name (`rigel-assistant-<role>`) is deferred to keep `BindingEditor` untouched — create mode uses a blank, user-typed name (flagged in Conventions). The pre-seeded subject and role picker deliver the core value.
- **Placeholder scan:** none. The only conditional is the `ShieldPlus` icon fallback, called out explicitly in T1 Step 5.
- **Type consistency:** `BindingTarget`/`RoleOption`/`ActionBlock` used exactly as exported by the RBAC write-actions code; `roleOptions` shape and the `applyManifest` action shape match `RbacPanel`'s usage. `ns` in T2 is the existing `d.installedNamespace ?? ""`.
