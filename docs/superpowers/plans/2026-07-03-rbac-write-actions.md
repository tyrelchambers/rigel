# RBAC Write Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add guarded write actions to the RBAC panel — delete, raw-YAML edit, and structured form editors to edit/create Roles, ClusterRoles, RoleBindings, and ClusterRoleBindings.

**Architecture:** Reuse the existing guarded machinery — `deleteResource` + `applyManifest` ActionBlocks routed through `ConfirmSheet`, and `editYaml` for the raw-YAML escape hatch. New work is two structured editor dialogs (`RoleEditor`, `BindingEditor`) that build a manifest with pure `buildRoleYaml`/`buildBindingYaml` helpers and hand an `applyManifest` action to `ConfirmSheet`. No server changes.

**Tech Stack:** React 19 + Vite + Tailwind v4 (tokens via arbitrary values), Zustand store, base-ui Dialog primitives, vitest (+ jsdom/RTL). Spec: `docs/superpowers/specs/2026-07-03-rbac-write-actions-design.md`. Pencil frames: `VXkeO` (Role editor), `spBkt` (Binding editor).

---

## Conventions (read before starting)

**Branch:** `feature/rbac-access-analysis` (continue on it; do NOT branch or touch master).

**Design source of truth:** Pencil frames `VXkeO` and `spBkt`. Reproduce them; don't invent.

**Styling:** Tailwind utilities only, tokens via arbitrary values (`bg-[var(--surface-elevated)]`, `text-[var(--fg-tertiary)]`, `border-[var(--status-failed)]/15`, white overlays as `bg-white/[0.05]`). No inline `style` except an unavoidable dynamic color. Pencil→token map is in the read-only RBAC plan (`docs/superpowers/plans/2026-07-03-rbac-access-analysis.md`).

**Guarded apply:** structured editors NEVER POST `/api/apply` directly. They build a YAML string and hand `{ kind: "applyManifest", label, manifest: yaml }` to `ConfirmSheet` (owned by `RbacPanel`). Deletes hand `{ kind: "deleteResource", resourceKind, name, namespace?, destructive: true, label }`.

**Reused signatures (verified):**
- `ActionBlock` type: `import type { ActionBlock } from "@/lib/api"`. Fields used: `kind`, `label`, `name`, `namespace`, `resourceKind`, `manifest`, `destructive`.
- `ConfirmSheet` (`@/components/ConfirmSheet`): `<ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />`. It internally previews the kubectl command and, for `applyManifest`, runs `kubectl apply -f -`.
- `editYaml(kind, name, namespace?, title?)` from `@/store/yamlViewer` — opens the editable Monaco viewer that applies through ConfirmSheet.
- `deleteResource` already supports `role` (namespaced) and `clusterrole`/`clusterrolebinding` (cluster-scoped) server-side — no server change.
- YAML is hand-built (no `yaml` npm package). Reuse `yamlSingleQuoted` from `@rigel/k8s` (exported in Task 5).

**Commands:**
- Single web test: `pnpm --filter web exec vitest run <path>`
- Typecheck: `pnpm --filter web typecheck`
- Full web tests: `pnpm --filter web test`

**Component test pattern:** first line `// @vitest-environment jsdom`, `afterEach(cleanup)`, mock `@/store/cluster`, `@/lib/ws`, `@/store/yamlViewer` as needed, render with `@testing-library/react`.

---

## File structure

- **Modify** `packages/k8s/src/configmapSecretEditor.ts` — `export` the private `yamlSingleQuoted`.
- **Modify** `packages/k8s/src/index.ts` — re-export `yamlSingleQuoted`.
- **Create** `apps/web/src/panels/rbac/rbacActions.ts` — pure `buildDeleteAction()` (ActionBlock builder) + tests.
- **Create** `apps/web/src/panels/rbac/manifest.ts` — pure `buildRoleYaml()`, `buildBindingYaml()` + tests.
- **Create** `apps/web/src/panels/rbac/components/NamespaceField.tsx` — a namespaces-watch-fed `<select>` (reused by both editors).
- **Create** `apps/web/src/panels/rbac/components/TokenInput.tsx` — chip list + add input (role rule fields).
- **Create** `apps/web/src/panels/rbac/components/RoleEditor.tsx` — the rule-builder dialog (frame `VXkeO`).
- **Create** `apps/web/src/panels/rbac/components/BindingEditor.tsx` — the subject/roleRef dialog (frame `spBkt`).
- **Modify** `apps/web/src/panels/rbac/components/BindingCard.tsx` — add Edit / Add-subject / Edit-YAML / Delete actions.
- **Modify** `apps/web/src/panels/rbac/components/RoleDetail.tsx` — add Edit / Edit-YAML / Delete actions.
- **Modify** `apps/web/src/panels/rbac/components/SubjectDetail.tsx` — thread action callbacks to `BindingCard`.
- **Modify** `apps/web/src/panels/rbac/RbacPanel.tsx` — own `pendingAction` + `<ConfirmSheet>` + editor state, add a **New ▾** button, remove the read-only footer.

---

## PHASE 1 — Delete + Edit-YAML everywhere

### Task 1: `buildDeleteAction` helper

**Files:**
- Create: `apps/web/src/panels/rbac/rbacActions.ts`
- Test: `apps/web/src/panels/rbac/rbacActions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/rbac/rbacActions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildDeleteAction } from "./rbacActions";

describe("buildDeleteAction", () => {
  it("builds a namespaced role delete", () => {
    expect(buildDeleteAction("role", "reader", "default")).toEqual({
      kind: "deleteResource",
      resourceKind: "role",
      name: "reader",
      namespace: "default",
      destructive: true,
      label: "Delete role reader",
    });
  });
  it("omits namespace for a clusterrole", () => {
    expect(buildDeleteAction("clusterrole", "admin")).toEqual({
      kind: "deleteResource",
      resourceKind: "clusterrole",
      name: "admin",
      destructive: true,
      label: "Delete clusterrole admin",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/panels/rbac/rbacActions.test.ts`
Expected: FAIL "Cannot find module './rbacActions'".

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/panels/rbac/rbacActions.ts`:

```ts
import type { ActionBlock } from "@/lib/api";

/** RBAC resource kinds accepted by the server's deleteResource action. */
export type RbacResourceKind = "role" | "clusterrole" | "rolebinding" | "clusterrolebinding";

/**
 * Build a guarded deleteResource ActionBlock for an RBAC object. Namespace is
 * included only when provided (cluster-scoped kinds pass it as undefined).
 */
export function buildDeleteAction(
  resourceKind: RbacResourceKind,
  name: string,
  namespace?: string,
): ActionBlock {
  const action: ActionBlock = {
    kind: "deleteResource",
    resourceKind,
    name,
    destructive: true,
    label: `Delete ${resourceKind} ${name}`,
  };
  if (namespace) action.namespace = namespace;
  return action;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run src/panels/rbac/rbacActions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/rbac/rbacActions.ts apps/web/src/panels/rbac/rbacActions.test.ts
git commit -m "feat(rbac): buildDeleteAction ActionBlock helper"
```

---

### Task 2: BindingCard actions

**Files:**
- Modify: `apps/web/src/panels/rbac/components/BindingCard.tsx`
- Test: `apps/web/src/panels/rbac/components/BindingCard.test.tsx`

Add an actions row to the card header: **Edit**, **Add subject**, **Edit YAML**, **Delete**. `BindingCard` stays presentational — it maps `grant` to the right callbacks.

- [ ] **Step 1: Extend the failing test**

Append to `apps/web/src/panels/rbac/components/BindingCard.test.tsx`:

```tsx
import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";

test("fires edit and delete with the binding identity", () => {
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const onEditYaml = vi.fn();
  render(
    <BindingCard grant={grant} onEdit={onEdit} onDelete={onDelete} onEditYaml={onEditYaml} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit binding" }));
  expect(onEdit).toHaveBeenCalledWith(grant);
  fireEvent.click(screen.getByRole("button", { name: "Delete binding" }));
  expect(onDelete).toHaveBeenCalledWith(grant);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/panels/rbac/components/BindingCard.test.tsx`
Expected: FAIL (props don't exist / buttons not found).

- [ ] **Step 3: Add the actions**

In `apps/web/src/panels/rbac/components/BindingCard.tsx`, extend the props and add an actions cluster. Change the signature to:

```tsx
import { Link2, ArrowRight, FileBadge, Box, Pencil, UserPlus, Code, Trash2 } from "lucide-react";
import type { Grant } from "../types";
import { RuleRow } from "./RuleRow";

interface Props {
  grant: Grant;
  onEdit?: (grant: Grant) => void;
  onAddSubject?: (grant: Grant) => void;
  onEditYaml?: (grant: Grant) => void;
  onDelete?: (grant: Grant) => void;
}

function IconBtn({
  label,
  Icon,
  onClick,
  danger,
}: {
  label: string;
  Icon: typeof Pencil;
  onClick?: () => void;
  danger?: boolean;
}) {
  if (!onClick) return null;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border-subtle)] hover:bg-white/[0.05] ${
        danger ? "text-[var(--status-failed)]" : "text-[var(--fg-tertiary)]"
      }`}
    >
      <Icon className="size-[13px]" />
    </button>
  );
}

export function BindingCard({ grant, onEdit, onAddSubject, onEditYaml, onDelete }: Props) {
  const rules = grant.rules;
```

Then inside the header's right-hand group (after the roleRef pill `</span>` that closes the `grants → roleRef` block, still inside the `justify-between` header row), add an actions cluster. Wrap the existing right group and the new actions so they sit together; add just before the header's closing `</div>`:

```tsx
        <div className="flex shrink-0 items-center gap-[6px]">
          <IconBtn label="Edit binding" Icon={Pencil} onClick={onEdit && (() => onEdit(grant))} />
          <IconBtn label="Add subject" Icon={UserPlus} onClick={onAddSubject && (() => onAddSubject(grant))} />
          <IconBtn label="Edit YAML" Icon={Code} onClick={onEditYaml && (() => onEditYaml(grant))} />
          <IconBtn label="Delete binding" Icon={Trash2} danger onClick={onDelete && (() => onDelete(grant))} />
        </div>
```

Place this cluster as a third child of the header `flex flex-wrap items-center justify-between` row (after the existing `grants → roleRef` group). It renders nothing when no callbacks are passed (read-only contexts).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run src/panels/rbac/components/BindingCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/rbac/components/BindingCard.tsx apps/web/src/panels/rbac/components/BindingCard.test.tsx
git commit -m "feat(rbac): binding card edit/add-subject/yaml/delete actions"
```

---

### Task 3: RoleDetail actions

**Files:**
- Modify: `apps/web/src/panels/rbac/components/RoleDetail.tsx`
- Test: `apps/web/src/panels/rbac/components/RoleDetail.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/rbac/components/RoleDetail.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RoleDetail } from "./RoleDetail";

afterEach(cleanup);

test("fires edit and delete actions", () => {
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  render(
    <RoleDetail
      roleName="admin"
      roleKind="ClusterRole"
      rules={[{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }]}
      boundSubjects={[]}
      onEdit={onEdit}
      onDelete={onDelete}
      onEditYaml={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit role" }));
  expect(onEdit).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete role" }));
  expect(onDelete).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/panels/rbac/components/RoleDetail.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add the actions**

In `apps/web/src/panels/rbac/components/RoleDetail.tsx`, add optional callback props and an actions cluster in the header. Update imports and the Props interface:

```tsx
import { Server, User, Users, Pencil, Code, Trash2 } from "lucide-react";
import type { PolicyRule, Subject, Grant } from "../types";
import { RuleRow } from "./RuleRow";

interface Props {
  roleName: string;
  roleKind: "Role" | "ClusterRole";
  roleNamespace?: string;
  rules: PolicyRule[];
  boundSubjects: { subject: Subject; bindingName: string; scope: Grant["scope"] }[];
  onEdit?: () => void;
  onEditYaml?: () => void;
  onDelete?: () => void;
}
```

Change the destructure to include `onEdit, onEditYaml, onDelete`, and wrap the header so the name block and an actions cluster sit on one `justify-between` row:

```tsx
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-[14px] gap-y-1">
          <span className="break-all font-[var(--font-mono)] text-[18px] font-semibold text-[var(--fg-primary)]">
            {roleName}
          </span>
          <span className="text-[13px] text-[var(--fg-tertiary)]">
            {roleKind === "Role" ? `Role · ${roleNamespace ?? ""}` : "ClusterRole"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-[6px]">
          {onEdit && (
            <button type="button" aria-label="Edit role" title="Edit role" onClick={onEdit}
              className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] px-3 py-1.5 text-[13px] text-[var(--fg-primary)] hover:bg-white/[0.04]">
              <Pencil className="size-[13px]" /> Edit
            </button>
          )}
          {onEditYaml && (
            <button type="button" aria-label="Edit role YAML" title="Edit YAML" onClick={onEditYaml}
              className="flex size-8 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border-subtle)] text-[var(--fg-tertiary)] hover:bg-white/[0.05]">
              <Code className="size-[14px]" />
            </button>
          )}
          {onDelete && (
            <button type="button" aria-label="Delete role" title="Delete role" onClick={onDelete}
              className="flex size-8 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border-subtle)] text-[var(--status-failed)] hover:bg-white/[0.05]">
              <Trash2 className="size-[14px]" />
            </button>
          )}
        </div>
      </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run src/panels/rbac/components/RoleDetail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/rbac/components/RoleDetail.tsx apps/web/src/panels/rbac/components/RoleDetail.test.tsx
git commit -m "feat(rbac): role detail edit/yaml/delete actions"
```

---

### Task 4: Wire Phase-1 actions into SubjectDetail + RbacPanel

**Files:**
- Modify: `apps/web/src/panels/rbac/components/SubjectDetail.tsx`
- Modify: `apps/web/src/panels/rbac/RbacPanel.tsx`
- Test: `apps/web/src/panels/rbac/RbacPanel.test.tsx`

- [ ] **Step 1: Thread callbacks through SubjectDetail**

In `apps/web/src/panels/rbac/components/SubjectDetail.tsx`, add optional per-binding callbacks to `Props` and pass them to each `BindingCard`:

```tsx
interface Props {
  subject: ListSubject;
  grants: Grant[];
  onAsk: (subject: ListSubject) => void;
  onEditBinding?: (grant: Grant) => void;
  onAddSubject?: (grant: Grant) => void;
  onEditBindingYaml?: (grant: Grant) => void;
  onDeleteBinding?: (grant: Grant) => void;
}
```

Destructure them and update the cards map:

```tsx
        {grants.map((g, i) => (
          <BindingCard
            key={`${g.bindingKind}:${g.bindingName}:${i}`}
            grant={g}
            onEdit={onEditBinding}
            onAddSubject={onAddSubject}
            onEditYaml={onEditBindingYaml}
            onDelete={onDeleteBinding}
          />
        ))}
```

- [ ] **Step 2: Write the failing panel test**

Add to `apps/web/src/panels/rbac/RbacPanel.test.tsx` (it already mocks `@/lib/ws`, `@/lib/chatHandoff`, `@/shell/NamespaceBar`, `@/store/cluster`). Add mocks for the viewer + ConfirmSheet at the top with the other `vi.mock` calls:

```tsx
vi.mock("@/store/yamlViewer", () => ({ editYaml: vi.fn(), viewYaml: vi.fn() }));
vi.mock("@/components/ConfirmSheet", () => ({
  ConfirmSheet: ({ open, action }: { open: boolean; action: { label?: string } | null }) =>
    open ? <div data-testid="confirm">{action?.label}</div> : null,
}));
```

Then add a test using the existing `setResources` helper:

```tsx
test("deleting a role opens the confirm sheet", () => {
  setResources({
    clusterroles: {
      "2": { metadata: { name: "admin", uid: "2" }, rules: [{ verbs: ["*"], resources: ["*"] }] },
    },
    clusterrolebindings: {
      "1": {
        metadata: { name: "cadmin", uid: "1" },
        roleRef: { kind: "ClusterRole", name: "admin" },
        subjects: [{ kind: "Group", name: "system:masters" }],
      },
    },
  });
  render(<RbacPanel />);
  fireEvent.click(screen.getByRole("tab", { name: "Roles" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete role" }));
  expect(screen.getByTestId("confirm").textContent).toContain("Delete clusterrole admin");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/panels/rbac/RbacPanel.test.tsx`
Expected: FAIL (no ConfirmSheet / no Delete button wired).

- [ ] **Step 4: Wire RbacPanel**

In `apps/web/src/panels/rbac/RbacPanel.tsx`:

Add imports:

```tsx
import { useState } from "react"; // already imported alongside useEffect/useMemo
import type { ActionBlock } from "@/lib/api";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { editYaml } from "@/store/yamlViewer";
import { buildDeleteAction } from "./rbacActions";
import type { Grant } from "./types";
```

Add state near the other `useState`s:

```tsx
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
```

Add handlers (before the `return`):

```tsx
  function deleteRoleItem(r: RoleItem) {
    setPendingAction(
      buildDeleteAction(r.kind === "ClusterRole" ? "clusterrole" : "role", r.name, r.namespace),
    );
  }
  function editRoleYaml(r: RoleItem) {
    editYaml(r.kind === "ClusterRole" ? "clusterrole" : "role", r.name, r.namespace);
  }
  function bindingResourceKind(g: Grant) {
    return g.bindingKind === "RoleBinding" ? ("rolebinding" as const) : ("clusterrolebinding" as const);
  }
  function bindingNamespace(g: Grant) {
    return g.scope.kind === "Namespaced" ? g.scope.namespace : undefined;
  }
  function deleteBinding(g: Grant) {
    setPendingAction(buildDeleteAction(bindingResourceKind(g), g.bindingName, bindingNamespace(g)));
  }
  function editBindingYaml(g: Grant) {
    editYaml(bindingResourceKind(g), g.bindingName, bindingNamespace(g));
  }
```

Pass the subject-detail callbacks:

```tsx
            <SubjectDetail
              subject={selectedSubject}
              grants={grants}
              onAsk={askAboutSubject}
              onEditBindingYaml={editBindingYaml}
              onDeleteBinding={deleteBinding}
            />
```

Pass the role-detail callbacks:

```tsx
            <RoleDetail
              roleName={selectedRole.name}
              roleKind={selectedRole.kind}
              roleNamespace={selectedRole.namespace}
              rules={roleRules}
              boundSubjects={boundSubjects}
              onEditYaml={() => editRoleYaml(selectedRole)}
              onDelete={() => deleteRoleItem(selectedRole)}
            />
```

(`onEdit`/`onEditBinding`/`onAddSubject` are wired in Phase 2/3 — leave them unset for now.)

Remove the read-only footer block (the `<div>` with the `Eye` icon and "Read-only view. RBAC is inspected here, not edited."), and drop the now-unused `Eye` import.

Render `<ConfirmSheet>` as the last child inside the outer `<div className="flex h-full flex-col">`, after the content wrapper:

```tsx
      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter web exec vitest run src/panels/rbac/RbacPanel.test.tsx`
Expected: PASS.
Run: `pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/rbac
git commit -m "feat(rbac): wire delete + edit-yaml actions, drop read-only footer"
```

---

## PHASE 2 — Role editor + Create Role

### Task 5: Export `yamlSingleQuoted`

**Files:**
- Modify: `packages/k8s/src/configmapSecretEditor.ts`
- Modify: `packages/k8s/src/index.ts`

- [ ] **Step 1: Export the helper**

In `packages/k8s/src/configmapSecretEditor.ts`, change `function yamlSingleQuoted(` to `export function yamlSingleQuoted(` (around line 270).

- [ ] **Step 2: Re-export from the package index**

In `packages/k8s/src/index.ts`, find the line that re-exports `buildConfigMapYAML` (near line 216) and add `yamlSingleQuoted` to that same `export { ... } from "./configmapSecretEditor"` list.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/k8s/src/configmapSecretEditor.ts packages/k8s/src/index.ts
git commit -m "chore(k8s): export yamlSingleQuoted for reuse"
```

---

### Task 6: `buildRoleYaml`

**Files:**
- Create: `apps/web/src/panels/rbac/manifest.ts`
- Test: `apps/web/src/panels/rbac/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/rbac/manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildRoleYaml } from "./manifest";

describe("buildRoleYaml", () => {
  it("builds a namespaced Role with rules", () => {
    const yaml = buildRoleYaml(
      { kind: "Role", name: "reader", namespace: "default" },
      [{ apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] }],
    );
    expect(yaml).toBe(
      [
        "apiVersion: rbac.authorization.k8s.io/v1",
        "kind: Role",
        "metadata:",
        "  name: 'reader'",
        "  namespace: 'default'",
        "rules:",
        "  - apiGroups: ['']",
        "    resources: ['pods']",
        "    verbs: ['get', 'list']",
        "",
      ].join("\n"),
    );
  });

  it("omits namespace for a ClusterRole, carries labels, and empties rules", () => {
    const yaml = buildRoleYaml(
      { kind: "ClusterRole", name: "admin", labels: { team: "sre" } },
      [],
    );
    expect(yaml).toContain("kind: ClusterRole");
    expect(yaml).not.toContain("namespace:");
    expect(yaml).toContain("  labels:\n    'team': 'sre'");
    expect(yaml).toContain("rules: []");
  });

  it("defaults an empty apiGroups to the core group", () => {
    const yaml = buildRoleYaml({ kind: "Role", name: "r", namespace: "d" }, [
      { resources: ["pods"], verbs: ["get"] },
    ]);
    expect(yaml).toContain("apiGroups: ['']");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/panels/rbac/manifest.test.ts`
Expected: FAIL "Cannot find module './manifest'".

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/panels/rbac/manifest.ts`:

```ts
import { yamlSingleQuoted } from "@rigel/k8s";
import type { PolicyRule } from "./types";

export interface RbacMeta {
  kind: "Role" | "ClusterRole" | "RoleBinding" | "ClusterRoleBinding";
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

const q = yamlSingleQuoted;

/** Inline YAML flow sequence with single-quoted items; `[]` when empty. */
function flowSeq(items: string[] | undefined): string {
  if (!items || items.length === 0) return "[]";
  return `[${items.map((i) => q(i)).join(", ")}]`;
}

function metaBlock(meta: RbacMeta): string[] {
  const lines = ["metadata:", `  name: ${q(meta.name)}`];
  if (meta.namespace && meta.namespace.trim() !== "") {
    lines.push(`  namespace: ${q(meta.namespace)}`);
  }
  const mapBlock = (key: string, m?: Record<string, string>) => {
    if (!m || Object.keys(m).length === 0) return;
    lines.push(`  ${key}:`);
    for (const k of Object.keys(m).sort()) lines.push(`    ${q(k)}: ${q(m[k]!)}`);
  };
  mapBlock("labels", meta.labels);
  mapBlock("annotations", meta.annotations);
  return lines;
}

/** Build a Role/ClusterRole manifest. Empty apiGroups defaults to the core group. */
export function buildRoleYaml(meta: RbacMeta, rules: PolicyRule[]): string {
  const lines = ["apiVersion: rbac.authorization.k8s.io/v1", `kind: ${meta.kind}`, ...metaBlock(meta)];
  if (rules.length === 0) {
    lines.push("rules: []");
  } else {
    lines.push("rules:");
    for (const r of rules) {
      const groups = r.apiGroups && r.apiGroups.length > 0 ? r.apiGroups : [""];
      lines.push(`  - apiGroups: ${flowSeq(groups)}`);
      lines.push(`    resources: ${flowSeq(r.resources)}`);
      lines.push(`    verbs: ${flowSeq(r.verbs)}`);
    }
  }
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run src/panels/rbac/manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/rbac/manifest.ts apps/web/src/panels/rbac/manifest.test.ts
git commit -m "feat(rbac): buildRoleYaml manifest builder"
```

---

### Task 7: `NamespaceField`

**Files:**
- Create: `apps/web/src/panels/rbac/components/NamespaceField.tsx`
- Test: `apps/web/src/panels/rbac/components/NamespaceField.test.tsx`

A `<select>` fed by the namespaces watch (per the app rule: namespace inputs are dropdowns). Owns its own `subscribe("namespaces","*")`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/rbac/components/NamespaceField.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/store/cluster", () => ({
  useCluster: (sel: (s: { resources: Record<string, Record<string, unknown>> }) => unknown) =>
    sel({ resources: { namespaces: { default: {}, "kube-system": {} } } }),
}));

import { NamespaceField } from "./NamespaceField";

afterEach(cleanup);

test("lists namespaces and fires onChange", () => {
  const onChange = vi.fn();
  render(<NamespaceField value="default" onChange={onChange} />);
  const select = screen.getByRole("combobox");
  expect(screen.getByRole("option", { name: "kube-system" })).toBeTruthy();
  fireEvent.change(select, { target: { value: "kube-system" } });
  expect(onChange).toHaveBeenCalledWith("kube-system");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/panels/rbac/components/NamespaceField.test.tsx`
Expected: FAIL "Cannot find module './NamespaceField'".

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/panels/rbac/components/NamespaceField.tsx`:

```tsx
import { useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";

interface Props {
  value: string;
  onChange: (namespace: string) => void;
  disabled?: boolean;
  className?: string;
}

/** Namespace dropdown fed by the namespaces watch. Owns its own subscription. */
export function NamespaceField({ value, onChange, disabled, className }: Props) {
  const resources = useCluster((s) => s.resources);
  useEffect(() => {
    subscribe("namespaces", "*");
    return () => unsubscribe("namespaces", "*");
  }, []);
  const namespaces = Object.keys(resources["namespaces"] ?? {}).sort((a, b) => a.localeCompare(b));
  const options = namespaces.length > 0 ? namespaces : value ? [value] : [];
  return (
    <div className={`relative ${disabled ? "pointer-events-none opacity-40" : ""} ${className ?? ""}`}>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] py-[9px] pl-[11px] pr-8 text-[12.5px] text-[var(--fg-primary)] outline-none"
      >
        {options.map((ns) => (
          <option key={ns} value={ns}>
            {ns}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-[14px] -translate-y-1/2 text-[var(--fg-tertiary)]" />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run src/panels/rbac/components/NamespaceField.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/rbac/components/NamespaceField.tsx apps/web/src/panels/rbac/components/NamespaceField.test.tsx
git commit -m "feat(rbac): NamespaceField dropdown fed by the namespaces watch"
```

---

### Task 8: `TokenInput` + `RoleEditor`

**Files:**
- Create: `apps/web/src/panels/rbac/components/TokenInput.tsx`
- Create: `apps/web/src/panels/rbac/components/RoleEditor.tsx`
- Test: `apps/web/src/panels/rbac/components/RoleEditor.test.tsx`

- [ ] **Step 1: Write `TokenInput`**

Create `apps/web/src/panels/rbac/components/TokenInput.tsx`:

```tsx
import { useState } from "react";
import { X, Plus } from "lucide-react";

interface Props {
  label: string;
  tokens: string[];
  onChange: (tokens: string[]) => void;
  danger?: (t: string) => boolean;
  placeholder?: string;
}

/** A labelled removable-chip list with an add input. */
export function TokenInput({ label, tokens, onChange, danger, placeholder }: Props) {
  const [draft, setDraft] = useState("");
  function add() {
    const v = draft.trim();
    if (v && !tokens.includes(v)) onChange([...tokens, v]);
    setDraft("");
  }
  return (
    <div className="flex w-full items-start gap-[10px]">
      <span className="w-[78px] shrink-0 pt-1.5 font-[var(--font-mono)] text-[9.5px] tracking-[0.6px] text-[var(--fg-tertiary)]">
        {label}
      </span>
      <div className="flex flex-1 flex-wrap items-center gap-[6px]">
        {tokens.map((t) => (
          <span
            key={t}
            className={`flex items-center gap-[5px] rounded-[var(--radius-sm)] border bg-[var(--surface-elevated)] px-[7px] py-[3px] font-[var(--font-mono)] text-[11px] ${
              danger?.(t)
                ? "border-[var(--status-failed)]/25 text-[var(--status-failed)]"
                : "border-[var(--border-subtle)] text-[var(--fg-secondary)]"
            }`}
          >
            {t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(tokens.filter((x) => x !== t))}>
              <X className="size-[10px] text-[var(--fg-tertiary)]" />
            </button>
          </span>
        ))}
        <span className="flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-[7px] py-[3px]">
          <Plus className="size-[10px] text-[var(--fg-tertiary)]" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add();
              }
            }}
            onBlur={add}
            placeholder={placeholder ?? "add"}
            aria-label={`Add ${label}`}
            className="w-16 bg-transparent font-[var(--font-mono)] text-[11px] text-[var(--fg-primary)] outline-none placeholder:text-[var(--fg-tertiary)]"
          />
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the failing `RoleEditor` test**

Create `apps/web/src/panels/rbac/components/RoleEditor.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RoleEditor } from "./RoleEditor";

afterEach(cleanup);

const role = {
  kind: "ClusterRole" as const,
  name: "reader",
  rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }],
};

test("edits a rule token and applies the built manifest", () => {
  const onApply = vi.fn();
  render(<RoleEditor target={role} open onClose={vi.fn()} onApply={onApply} />);
  // add a verb
  const addVerb = screen.getByLabelText("Add VERBS");
  fireEvent.change(addVerb, { target: { value: "list" } });
  fireEvent.keyDown(addVerb, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
  expect(onApply).toHaveBeenCalledTimes(1);
  const { yaml, label } = onApply.mock.calls[0][0];
  expect(label).toBe("Apply ClusterRole reader");
  expect(yaml).toContain("verbs: ['get', 'list']");
  expect(yaml).toContain("kind: ClusterRole");
});

test("adds and removes a rule", () => {
  render(<RoleEditor target={role} open onClose={vi.fn()} onApply={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  expect(screen.getAllByText(/^Rule \d/).length).toBe(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Remove rule" })[1]);
  expect(screen.getAllByText(/^Rule \d/).length).toBe(1);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/panels/rbac/components/RoleEditor.test.tsx`
Expected: FAIL "Cannot find module './RoleEditor'".

- [ ] **Step 4: Write `RoleEditor`**

Create `apps/web/src/panels/rbac/components/RoleEditor.tsx`:

```tsx
import { useState } from "react";
import { FileBadge, Plus, Trash2, Code } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogIcon,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { PolicyRule } from "../types";
import { ruleRisk } from "../risk";
import { buildRoleYaml } from "../manifest";
import { NamespaceField } from "./NamespaceField";
import { TokenInput } from "./TokenInput";

export interface RoleTarget {
  kind: "Role" | "ClusterRole";
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  rules: PolicyRule[];
}

interface Props {
  /** null = create mode. */
  target: RoleTarget | null;
  open: boolean;
  onClose: () => void;
  onApply: (result: { yaml: string; label: string }) => void;
  onEditYaml?: () => void;
}

function blankRule(): PolicyRule {
  return { apiGroups: [""], resources: [], verbs: [] };
}

export function RoleEditor({ target, open, onClose, onApply, onEditYaml }: Props) {
  const isEdit = target != null;
  const [kind, setKind] = useState<"Role" | "ClusterRole">(target?.kind ?? "Role");
  const [name, setName] = useState(target?.name ?? "");
  const [namespace, setNamespace] = useState(target?.namespace ?? "default");
  const [rules, setRules] = useState<PolicyRule[]>(
    target?.rules?.length ? target.rules.map((r) => ({ ...r })) : [blankRule()],
  );

  function setRule(i: number, patch: Partial<PolicyRule>) {
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  const valid = name.trim() !== "";

  function apply() {
    const yaml = buildRoleYaml(
      {
        kind,
        name: name.trim(),
        namespace: kind === "Role" ? namespace.trim() : undefined,
        labels: target?.labels,
        annotations: target?.annotations,
      },
      rules,
    );
    onApply({ yaml, label: `Apply ${kind} ${name.trim()}` });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[86vh] w-[calc(100%-2rem)] max-w-[560px]">
        <DialogHeader>
          <DialogIcon>
            <FileBadge className="size-[15px] text-[var(--accent-primary)]" />
          </DialogIcon>
          <DialogTitle>{isEdit ? `Edit role · ${target!.name}` : "New role"}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {isEdit ? (
            <p className="text-[12px] text-[var(--fg-secondary)]">
              {kind === "ClusterRole" ? "ClusterRole · cluster-scoped" : `Role · namespace ${namespace}`}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="name"
                aria-label="Role name"
                className="min-w-[160px] flex-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[11px] py-[9px] font-[var(--font-mono)] text-[12.5px] text-[var(--fg-primary)] outline-none"
              />
              <div className="flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
                {(["Role", "ClusterRole"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={`px-3 py-[9px] text-[12px] ${kind === k ? "bg-white/[0.08] text-[var(--fg-primary)]" : "text-[var(--fg-tertiary)]"}`}
                  >
                    {k}
                  </button>
                ))}
              </div>
              {kind === "Role" && (
                <NamespaceField value={namespace} onChange={setNamespace} className="w-[160px]" />
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="font-[var(--font-mono)] text-[11px] font-semibold tracking-[1px] text-[var(--fg-secondary)]">
              RULES
            </span>
            <span className="font-[var(--font-mono)] text-[11px] text-[var(--fg-tertiary)]">{rules.length}</span>
            <div className="h-px flex-1 bg-[var(--border-subtle)]" />
          </div>

          {rules.map((r, i) => {
            const dangerous = ruleRisk(r) === "dangerous";
            return (
              <div
                key={i}
                className={`flex flex-col gap-[10px] rounded-[var(--radius-md)] border bg-[var(--surface-sunken)] p-[13px] ${
                  dangerous ? "border-[var(--status-failed)]/25" : "border-[var(--border-subtle)]"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-[var(--font-mono)] text-[11px] font-semibold text-[var(--fg-secondary)]">
                    Rule {i + 1}
                  </span>
                  <button
                    type="button"
                    aria-label="Remove rule"
                    onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
                    className="flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--fg-tertiary)] hover:bg-white/[0.05]"
                  >
                    <Trash2 className="size-[13px]" />
                  </button>
                </div>
                <TokenInput label="API GROUPS" tokens={r.apiGroups ?? []} onChange={(t) => setRule(i, { apiGroups: t })} placeholder="core" />
                <TokenInput label="RESOURCES" tokens={r.resources ?? []} onChange={(t) => setRule(i, { resources: t })} danger={(t) => t === "secrets" || t === "*"} />
                <TokenInput label="VERBS" tokens={r.verbs ?? []} onChange={(t) => setRule(i, { verbs: t })} danger={(t) => ["*", "escalate", "bind", "impersonate"].includes(t)} />
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => setRules((rs) => [...rs, blankRule()])}
            className="flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] py-[10px] text-[12px] font-medium text-[var(--fg-secondary)] hover:bg-white/[0.04]"
          >
            <Plus className="size-[13px]" /> Add rule
          </button>
        </DialogBody>
        <DialogFooter showCloseButton={false}>
          {isEdit && onEditYaml && (
            <Button variant="outline" onClick={onEditYaml} className="mr-auto">
              <Code className="size-[13px]" /> Edit YAML
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} onClick={apply}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

Note: if `DialogFooter` doesn't accept `showCloseButton`, drop that prop — verify against `apps/web/src/components/ui/dialog.tsx` (the reviewer in Task 4's exploration confirmed the prop exists; if the real signature differs, match it). Confirm `Button` accepts `variant="outline"` (it does — see `@/components/ui/button`).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run src/panels/rbac/components/RoleEditor.test.tsx`
Expected: PASS. (If the base-ui Dialog needs a portal target in jsdom and a query fails, the mock-free render still mounts content in the portal — `screen` queries the whole document, so it works. If `DialogTitle` requires a `Description`, add a `<DialogDescription className="sr-only">` — check the console warning.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/rbac/components/TokenInput.tsx apps/web/src/panels/rbac/components/RoleEditor.tsx apps/web/src/panels/rbac/components/RoleEditor.test.tsx
git commit -m "feat(rbac): RoleEditor rule-builder dialog + TokenInput"
```

---

### Task 9: Wire RoleEditor into RbacPanel (edit + create)

**Files:**
- Modify: `apps/web/src/panels/rbac/RbacPanel.tsx`
- Test: `apps/web/src/panels/rbac/RbacPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/panels/rbac/RbacPanel.test.tsx`:

```tsx
test("editing a role opens the RoleEditor and applying opens the confirm sheet", () => {
  setResources({
    clusterroles: {
      "2": { metadata: { name: "admin", uid: "2" }, rules: [{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }] },
    },
  });
  render(<RbacPanel />);
  fireEvent.click(screen.getByRole("tab", { name: "Roles" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit role" }));
  // RoleEditor mounted
  expect(screen.getByText(/Edit role · admin/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
  expect(screen.getByTestId("confirm").textContent).toContain("Apply ClusterRole admin");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/panels/rbac/RbacPanel.test.tsx`
Expected: FAIL (no editor wired).

- [ ] **Step 3: Wire it**

In `apps/web/src/panels/rbac/RbacPanel.tsx`:

Import the editor and its target type:

```tsx
import { RoleEditor, type RoleTarget } from "./components/RoleEditor";
```

Add editor state:

```tsx
  const [roleEditor, setRoleEditor] = useState<{ target: RoleTarget | null } | null>(null);
```

Add a handler to open the editor for the selected role (resolve its full object + rules from the store):

```tsx
  function openRoleEditor(r: RoleItem) {
    const pool = r.kind === "ClusterRole" ? clusterRoles : roles;
    const obj = pool.find(
      (x) => x.metadata.name === r.name && (r.kind === "ClusterRole" || x.metadata.namespace === r.namespace),
    );
    setRoleEditor({
      target: {
        kind: r.kind,
        name: r.name,
        namespace: r.namespace,
        labels: obj?.metadata.labels,
        annotations: obj?.metadata.annotations,
        rules: obj?.rules ?? [],
      },
    });
  }
  function applyFromEditor(result: { yaml: string; label: string }) {
    setRoleEditor(null);
    setBindingEditorClose();
    setPendingAction({ kind: "applyManifest", label: result.label, manifest: result.yaml });
  }
```

(For now define `function setBindingEditorClose() {}` as a no-op placeholder; Task 12 replaces it with real binding-editor state teardown. This keeps `applyFromEditor` shared.)

Pass `onEdit` to `RoleDetail`:

```tsx
              onEdit={() => openRoleEditor(selectedRole)}
```

Render the editor near `<ConfirmSheet>`:

```tsx
      {roleEditor && (
        <RoleEditor
          target={roleEditor.target}
          open
          onClose={() => setRoleEditor(null)}
          onApply={applyFromEditor}
          onEditYaml={
            roleEditor.target
              ? () => {
                  const t = roleEditor.target!;
                  setRoleEditor(null);
                  editYaml(t.kind === "ClusterRole" ? "clusterrole" : "role", t.name, t.namespace);
                }
              : undefined
          }
        />
      )}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter web exec vitest run src/panels/rbac/RbacPanel.test.tsx`
Expected: PASS.
Run: `pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/rbac/RbacPanel.tsx apps/web/src/panels/rbac/RbacPanel.test.tsx
git commit -m "feat(rbac): wire RoleEditor for editing roles"
```

---

## PHASE 3 — Binding editor + Create + Add-subject + New menu

### Task 10: `buildBindingYaml`

**Files:**
- Modify: `apps/web/src/panels/rbac/manifest.ts`
- Test: `apps/web/src/panels/rbac/manifest.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `apps/web/src/panels/rbac/manifest.test.ts`:

```ts
import { buildBindingYaml } from "./manifest";

describe("buildBindingYaml", () => {
  it("builds a RoleBinding with mixed subjects", () => {
    const yaml = buildBindingYaml(
      { kind: "RoleBinding", name: "b1", namespace: "default" },
      { kind: "ClusterRole", name: "admin" },
      [
        { kind: "ServiceAccount", name: "app", namespace: "default" },
        { kind: "Group", name: "system:masters" },
      ],
    );
    expect(yaml).toBe(
      [
        "apiVersion: rbac.authorization.k8s.io/v1",
        "kind: RoleBinding",
        "metadata:",
        "  name: 'b1'",
        "  namespace: 'default'",
        "roleRef:",
        "  apiGroup: rbac.authorization.k8s.io",
        "  kind: ClusterRole",
        "  name: 'admin'",
        "subjects:",
        "  - kind: ServiceAccount",
        "    name: 'app'",
        "    namespace: 'default'",
        "  - kind: Group",
        "    apiGroup: rbac.authorization.k8s.io",
        "    name: 'system:masters'",
        "",
      ].join("\n"),
    );
  });

  it("omits namespace for a ClusterRoleBinding and empties subjects", () => {
    const yaml = buildBindingYaml(
      { kind: "ClusterRoleBinding", name: "cb" },
      { kind: "ClusterRole", name: "view" },
      [],
    );
    expect(yaml).toContain("kind: ClusterRoleBinding");
    expect(yaml).not.toContain("namespace:");
    expect(yaml).toContain("subjects: []");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/panels/rbac/manifest.test.ts`
Expected: FAIL "buildBindingYaml is not a function".

- [ ] **Step 3: Add the implementation**

Append to `apps/web/src/panels/rbac/manifest.ts`:

```ts
import type { RoleRef, Subject } from "./types";

/** Build a RoleBinding/ClusterRoleBinding manifest. */
export function buildBindingYaml(meta: RbacMeta, roleRef: RoleRef, subjects: Subject[]): string {
  const lines = ["apiVersion: rbac.authorization.k8s.io/v1", `kind: ${meta.kind}`, ...metaBlock(meta)];
  lines.push("roleRef:");
  lines.push("  apiGroup: rbac.authorization.k8s.io");
  lines.push(`  kind: ${roleRef.kind ?? "Role"}`);
  lines.push(`  name: ${q(roleRef.name ?? "")}`);
  if (subjects.length === 0) {
    lines.push("subjects: []");
  } else {
    lines.push("subjects:");
    for (const s of subjects) {
      const kind = s.kind ?? "ServiceAccount";
      lines.push(`  - kind: ${kind}`);
      if (kind === "User" || kind === "Group") lines.push("    apiGroup: rbac.authorization.k8s.io");
      lines.push(`    name: ${q(s.name ?? "")}`);
      if (kind === "ServiceAccount" && s.namespace) lines.push(`    namespace: ${q(s.namespace)}`);
    }
  }
  return lines.join("\n") + "\n";
}
```

Add `RoleRef, Subject` to the existing `import type { PolicyRule } from "./types";` line (make it `import type { PolicyRule, RoleRef, Subject } from "./types";`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run src/panels/rbac/manifest.test.ts`
Expected: PASS (both describe blocks).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/rbac/manifest.ts apps/web/src/panels/rbac/manifest.test.ts
git commit -m "feat(rbac): buildBindingYaml manifest builder"
```

---

### Task 11: `BindingEditor`

**Files:**
- Create: `apps/web/src/panels/rbac/components/BindingEditor.tsx`
- Test: `apps/web/src/panels/rbac/components/BindingEditor.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/rbac/components/BindingEditor.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/store/cluster", () => ({
  useCluster: (sel: (s: { resources: Record<string, Record<string, unknown>> }) => unknown) =>
    sel({ resources: { namespaces: { default: {} } } }),
}));

import { BindingEditor } from "./BindingEditor";

afterEach(cleanup);

const binding = {
  kind: "RoleBinding" as const,
  name: "b1",
  namespace: "default",
  roleRef: { kind: "ClusterRole", name: "admin" },
  subjects: [{ kind: "ServiceAccount", name: "app", namespace: "default" }],
};

test("applying builds a manifest with the subjects", () => {
  const onApply = vi.fn();
  render(<BindingEditor target={binding} open onClose={vi.fn()} onApply={onApply} />);
  fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
  const { yaml, label } = onApply.mock.calls[0][0];
  expect(label).toBe("Apply RoleBinding b1");
  expect(yaml).toContain("kind: ServiceAccount");
  expect(yaml).toContain("name: 'app'");
  expect(yaml).toContain("kind: ClusterRole");
});

test("removing a subject drops it from the manifest", () => {
  const onApply = vi.fn();
  render(<BindingEditor target={binding} open onClose={vi.fn()} onApply={onApply} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove subject app" }));
  fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
  expect(onApply.mock.calls[0][0].yaml).toContain("subjects: []");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/panels/rbac/components/BindingEditor.test.tsx`
Expected: FAIL "Cannot find module './BindingEditor'".

- [ ] **Step 3: Write `BindingEditor`**

Create `apps/web/src/panels/rbac/components/BindingEditor.tsx`:

```tsx
import { useState } from "react";
import { Link2, Plus, X, Code } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogIcon,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { RoleRef, Subject } from "../types";
import { buildBindingYaml } from "../manifest";
import { NamespaceField } from "./NamespaceField";

export interface BindingTarget {
  kind: "RoleBinding" | "ClusterRoleBinding";
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  roleRef: RoleRef;
  subjects: Subject[];
  /** Optional focus hint — scroll/emphasise the subjects section. */
  focusSubjects?: boolean;
}

interface Props {
  target: BindingTarget | null;
  open: boolean;
  onClose: () => void;
  onApply: (result: { yaml: string; label: string }) => void;
  onEditYaml?: () => void;
}

const SUBJECT_KINDS = ["ServiceAccount", "User", "Group"] as const;

function selectClass(w: string) {
  return `${w} appearance-none rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[11px] py-[9px] text-[12.5px] text-[var(--fg-primary)] outline-none`;
}

export function BindingEditor({ target, open, onClose, onApply, onEditYaml }: Props) {
  const isEdit = target != null;
  const [kind] = useState<"RoleBinding" | "ClusterRoleBinding">(target?.kind ?? "RoleBinding");
  const [name, setName] = useState(target?.name ?? "");
  const [namespace, setNamespace] = useState(target?.namespace ?? "default");
  const [roleRef, setRoleRef] = useState<RoleRef>(target?.roleRef ?? { kind: "Role", name: "" });
  const [subjects, setSubjects] = useState<Subject[]>(
    (target?.subjects ?? []).map((s) => ({ ...s })),
  );

  function setSubject(i: number, patch: Partial<Subject>) {
    setSubjects((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  const valid = name.trim() !== "" && (roleRef.name ?? "").trim() !== "";

  function apply() {
    const yaml = buildBindingYaml(
      {
        kind,
        name: name.trim(),
        namespace: kind === "RoleBinding" ? namespace.trim() : undefined,
        labels: target?.labels,
        annotations: target?.annotations,
      },
      roleRef,
      subjects,
    );
    onApply({ yaml, label: `Apply ${kind} ${name.trim()}` });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[86vh] w-[calc(100%-2rem)] max-w-[560px]">
        <DialogHeader>
          <DialogIcon>
            <Link2 className="size-[15px] text-[var(--accent-primary)]" />
          </DialogIcon>
          <DialogTitle>{isEdit ? `Edit binding · ${target!.name}` : "New binding"}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {isEdit ? (
            <p className="text-[12px] text-[var(--fg-secondary)]">
              {kind === "ClusterRoleBinding" ? "ClusterRoleBinding · cluster-scoped" : `RoleBinding · namespace ${namespace}`}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="name"
                aria-label="Binding name"
                className="min-w-[160px] flex-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[11px] py-[9px] font-[var(--font-mono)] text-[12.5px] text-[var(--fg-primary)] outline-none"
              />
              {kind === "RoleBinding" && (
                <NamespaceField value={namespace} onChange={setNamespace} className="w-[160px]" />
              )}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="font-[var(--font-mono)] text-[11px] font-semibold tracking-[1px] text-[var(--fg-secondary)]">
              GRANTS ROLE
            </span>
            <div className="flex items-center gap-2">
              <select
                aria-label="Role ref kind"
                value={roleRef.kind ?? "Role"}
                onChange={(e) => setRoleRef({ ...roleRef, kind: e.target.value })}
                className={selectClass("w-[160px]")}
              >
                <option value="Role">Role</option>
                <option value="ClusterRole">ClusterRole</option>
              </select>
              <input
                aria-label="Role ref name"
                value={roleRef.name ?? ""}
                onChange={(e) => setRoleRef({ ...roleRef, name: e.target.value })}
                placeholder="role name"
                className="flex-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[11px] py-[9px] font-[var(--font-mono)] text-[12.5px] text-[var(--fg-primary)] outline-none"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="font-[var(--font-mono)] text-[11px] font-semibold tracking-[1px] text-[var(--fg-secondary)]">
              SUBJECTS
            </span>
            <span className="font-[var(--font-mono)] text-[11px] text-[var(--fg-tertiary)]">{subjects.length}</span>
            <div className="h-px flex-1 bg-[var(--border-subtle)]" />
          </div>

          {subjects.map((s, i) => {
            const isSa = (s.kind ?? "ServiceAccount") === "ServiceAccount";
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Subject kind"
                  value={s.kind ?? "ServiceAccount"}
                  onChange={(e) => setSubject(i, { kind: e.target.value })}
                  className={selectClass("w-[150px]")}
                >
                  {SUBJECT_KINDS.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
                <input
                  aria-label="Subject name"
                  value={s.name ?? ""}
                  onChange={(e) => setSubject(i, { name: e.target.value })}
                  placeholder="name"
                  className="min-w-[120px] flex-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[11px] py-[9px] font-[var(--font-mono)] text-[12.5px] text-[var(--fg-primary)] outline-none"
                />
                <NamespaceField
                  value={s.namespace ?? "default"}
                  onChange={(ns) => setSubject(i, { namespace: ns })}
                  disabled={!isSa}
                  className="w-[130px]"
                />
                <button
                  type="button"
                  aria-label={`Remove subject ${s.name ?? ""}`}
                  onClick={() => setSubjects((ss) => ss.filter((_, j) => j !== i))}
                  className="flex size-[30px] items-center justify-center rounded-[var(--radius-md)] border border-[var(--border-subtle)] text-[var(--fg-tertiary)] hover:bg-white/[0.05]"
                >
                  <X className="size-[13px]" />
                </button>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => setSubjects((ss) => [...ss, { kind: "ServiceAccount", name: "", namespace: "default" }])}
            className="flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] py-[10px] text-[12px] font-medium text-[var(--fg-secondary)] hover:bg-white/[0.04]"
          >
            <Plus className="size-[13px]" /> Add subject
          </button>
        </DialogBody>
        <DialogFooter showCloseButton={false}>
          {isEdit && onEditYaml && (
            <Button variant="outline" onClick={onEditYaml} className="mr-auto">
              <Code className="size-[13px]" /> Edit YAML
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid} onClick={apply}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run src/panels/rbac/components/BindingEditor.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/rbac/components/BindingEditor.tsx apps/web/src/panels/rbac/components/BindingEditor.test.tsx
git commit -m "feat(rbac): BindingEditor subject/roleRef dialog"
```

---

### Task 12: Wire BindingEditor + New menu into RbacPanel

**Files:**
- Modify: `apps/web/src/panels/rbac/RbacPanel.tsx`
- Test: `apps/web/src/panels/rbac/RbacPanel.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/panels/rbac/RbacPanel.test.tsx`:

```tsx
test("editing a binding opens the BindingEditor and applies", () => {
  setResources({
    rolebindings: {
      "1": {
        metadata: { name: "b1", namespace: "default", uid: "1" },
        roleRef: { kind: "ClusterRole", name: "admin" },
        subjects: [{ kind: "ServiceAccount", name: "app", namespace: "default" }],
      },
    },
    clusterroles: { "2": { metadata: { name: "admin", uid: "2" }, rules: [{ verbs: ["*"], resources: ["*"] }] } },
  });
  render(<RbacPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Edit binding" }));
  expect(screen.getByText(/Edit binding · b1/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
  expect(screen.getByTestId("confirm").textContent).toContain("Apply RoleBinding b1");
});

test("New menu creates a role", () => {
  setResources({});
  render(<RbacPanel />);
  fireEvent.click(screen.getByRole("button", { name: "New RBAC object" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "ClusterRole" }));
  expect(screen.getByText("New role")).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter web exec vitest run src/panels/rbac/RbacPanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Wire it**

In `apps/web/src/panels/rbac/RbacPanel.tsx`:

Imports:

```tsx
import { Plus } from "lucide-react";
import { BindingEditor, type BindingTarget } from "./components/BindingEditor";
import type { RoleRef } from "./types";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
```

Replace the Task-9 `setBindingEditorClose` no-op with real state:

```tsx
  const [bindingEditor, setBindingEditor] = useState<{ target: BindingTarget | null } | null>(null);
```

Update `applyFromEditor` to close both editors:

```tsx
  function applyFromEditor(result: { yaml: string; label: string }) {
    setRoleEditor(null);
    setBindingEditor(null);
    setPendingAction({ kind: "applyManifest", label: result.label, manifest: result.yaml });
  }
```

(Remove the `setBindingEditorClose` placeholder function.)

Add a helper to resolve a `Grant` back to its stored binding object and open the editor:

```tsx
  function openBindingEditor(g: Grant, focusSubjects = false) {
    const pool = g.bindingKind === "RoleBinding" ? roleBindings : clusterRoleBindings;
    const ns = g.scope.kind === "Namespaced" ? g.scope.namespace : undefined;
    const obj = pool.find(
      (x) => x.metadata.name === g.bindingName && (g.bindingKind === "ClusterRoleBinding" || x.metadata.namespace === ns),
    );
    setBindingEditor({
      target: {
        kind: g.bindingKind,
        name: g.bindingName,
        namespace: ns,
        labels: obj?.metadata.labels,
        annotations: obj?.metadata.annotations,
        roleRef: obj?.roleRef ?? g.roleRef,
        subjects: obj?.subjects ?? [],
        focusSubjects,
      },
    });
  }
  function newObject(kind: "Role" | "ClusterRole" | "RoleBinding" | "ClusterRoleBinding") {
    if (kind === "Role" || kind === "ClusterRole") {
      setRoleEditor({ target: null });
      // create mode uses a blank RoleEditor; seed kind via a create default
    } else {
      const roleRef: RoleRef = { kind: "Role", name: "" };
      setBindingEditor({
        target: null,
      });
    }
    // capture desired create-kind for the editors:
    setCreateKind(kind);
  }
```

For create mode the editors need to know the chosen kind. Add a `createKind` prop to both editors (Task 8/11) OR seed via the target. The simplest wiring that matches the Task-8/11 code above (which reads `target?.kind`) is to pass a non-null blank target in create mode. Add state and pass blank targets:

```tsx
  const [createKind, setCreateKind] = useState<"Role" | "ClusterRole" | "RoleBinding" | "ClusterRoleBinding">("Role");
```

Rewrite `newObject` to seed blank targets so the editors open in the right kind (RoleEditor/BindingEditor treat a target with empty name + no rules/subjects as create):

```tsx
  function newObject(kind: "Role" | "ClusterRole" | "RoleBinding" | "ClusterRoleBinding") {
    if (kind === "Role" || kind === "ClusterRole") {
      setRoleEditor({ target: { kind, name: "", namespace: "default", rules: [] } });
    } else {
      setBindingEditor({
        target: { kind, name: "", namespace: "default", roleRef: { kind: "Role", name: "" }, subjects: [] },
      });
    }
  }
```

Because the editors show the read-only meta line only when `isEdit` (target != null), a blank-but-non-null target would render as edit. To make create mode explicit, change both editors' `isEdit` derivation to `target != null && target.name !== ""` — update Task 8 and Task 11 accordingly (the editor shows create fields when the name is empty). Add this note to those tasks: **`const isEdit = target != null && target.name.trim() !== "";`**. This keeps create/edit from a single `target`.

Wire the binding callbacks on `SubjectDetail`:

```tsx
              onEditBinding={(g) => openBindingEditor(g)}
              onAddSubject={(g) => openBindingEditor(g, true)}
              onEditBindingYaml={editBindingYaml}
              onDeleteBinding={deleteBinding}
```

Add the **New ▾** button in the `PanelHeader` children (beside the search input — wrap both in a flex row):

```tsx
        <div className="flex items-center gap-2">
          <input /* existing search input unchanged */ />
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="New RBAC object"
              className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] px-3 py-1.5 text-sm text-[var(--fg-primary)] hover:bg-white/[0.04]"
            >
              <Plus className="size-[14px]" /> New
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => newObject("Role")}>Role</DropdownMenuItem>
              <DropdownMenuItem onClick={() => newObject("ClusterRole")}>ClusterRole</DropdownMenuItem>
              <DropdownMenuItem onClick={() => newObject("RoleBinding")}>RoleBinding</DropdownMenuItem>
              <DropdownMenuItem onClick={() => newObject("ClusterRoleBinding")}>ClusterRoleBinding</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
```

Render the BindingEditor near the RoleEditor:

```tsx
      {bindingEditor && (
        <BindingEditor
          target={bindingEditor.target}
          open
          onClose={() => setBindingEditor(null)}
          onApply={applyFromEditor}
          onEditYaml={
            bindingEditor.target && bindingEditor.target.name
              ? () => {
                  const t = bindingEditor.target!;
                  setBindingEditor(null);
                  editYaml(t.kind === "RoleBinding" ? "rolebinding" : "clusterrolebinding", t.name, t.namespace);
                }
              : undefined
          }
        />
      )}
```

Verify `@/components/ui/dropdown-menu` exports `DropdownMenu/Trigger/Content/Item` (it's a shadcn primitive already in the repo — the RBAC panel's context menus use `@/components/ui/context-menu`; confirm the dropdown-menu names, adjust if the trigger needs `asChild`).

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter web exec vitest run src/panels/rbac/RbacPanel.test.tsx`
Expected: PASS.
Run: `pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/rbac
git commit -m "feat(rbac): wire BindingEditor, add-subject, and New menu (create)"
```

---

### Task 13: Full verification + docs

**Files:** none unless verification surfaces a defect.

- [ ] **Step 1: Full suite + typecheck + build**

Run: `pnpm --filter web test`
Expected: PASS (all, including new rbac tests).
Run: `pnpm --filter web typecheck`
Expected: PASS.
Run: `pnpm --filter web build`
Expected: succeeds.

- [ ] **Step 2: Visual verification vs the `.pen`**

Compare the mounted editors to Pencil frames `VXkeO` (Role editor) and `spBkt` (Binding editor): rule cards with token chips + trash + Add rule; dangerous rules red-tinted; footer Edit YAML + Cancel + Apply; binding subject rows with kind select + name + namespace dropdown (dimmed for User/Group) + remove; GRANTS ROLE picker; New ▾ menu; Edit/Delete/Edit-YAML affordances on RoleDetail/BindingCard; read-only footer gone. Fix spacing/token mismatches inline (Tailwind tokens only). Do not start the web dev server; live checks via `pnpm --filter desktop dev` only if the user asks.

- [ ] **Step 3: Update Outline + Plane**

Document the RBAC write actions in the app's Outline doc and derive a Plane ticket under the Rigel (HELM) project.

- [ ] **Step 4: Final commit (if fixes were made)**

```bash
git add -A && git commit -m "fix(rbac): visual polish for editors vs Pencil frames"
```

---

## Self-review notes (author)

- **Spec coverage:** delete (T1–T4) ✓; Edit-YAML escape hatch (T4 editYaml wiring; editors' Edit YAML button T8/T11/T9/T12) ✓; RoleEditor rule builder + create (T8/T9/T12) ✓; BindingEditor subjects+roleRef + create + add-subject (T11/T12) ✓; guarded applyManifest→ConfirmSheet (T4/T9/T12) ✓; namespace dropdowns (T7, used in both editors) ✓; buildRoleYaml/buildBindingYaml carrying labels/annotations (T6/T10) ✓; New menu (T12) ✓; read-only footer removed (T4) ✓. Non-goals (diff view, aggregationRule, bulk) intentionally absent ✓.
- **Placeholder scan:** the only intentional temporary is Task 9's `setBindingEditorClose` no-op, explicitly replaced in Task 12. `isEdit = target != null && target.name.trim() !== ""` is called out in T12 as an amendment to T8/T11 — implementers should apply it when doing T12 (create mode). No other TODOs.
- **Type consistency:** `ActionBlock` fields (`kind`/`label`/`name`/`namespace`/`resourceKind`/`manifest`/`destructive`) match the verified server type. `RoleTarget`/`BindingTarget` defined in T8/T11 and consumed in T9/T12. `buildRoleYaml`/`buildBindingYaml`/`RbacMeta`/`yamlSingleQuoted` consistent across T5/T6/T10. Editor `onApply` shape `{ yaml, label }` consistent across T8/T9/T11/T12.
- **Ordering:** Phase 1 ships delete+YAML with no new components; Phase 2 adds the Role editor; Phase 3 the Binding editor + create + New menu. Each phase is independently green.
- **Verify at T12:** confirm `@/components/ui/dropdown-menu` and `DialogFooter`'s `showCloseButton` prop against the real files; the plan flags both.
