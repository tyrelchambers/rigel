# RBAC write actions — edit, create, delete roles & bindings

**Date:** 2026-07-03
**Pencil frames:** `VXkeO` "RBAC — Role editor", `spBkt` "RBAC — Binding editor" (clankerlocal.pen)
**Status:** design approved, spec for implementation
**Builds on:** the read-only RBAC access analyzer (`docs/superpowers/specs/2026-07-03-rbac-access-analysis-design.md`, branch `feature/rbac-access-analysis`). Continues on the same branch.

## Problem

The RBAC panel is read-only: it resolves and flags access but can't change it. Users want to update RBAC in-app — edit a role's rules, add/remove who a binding grants to, delete roles/bindings, and create new ones — without dropping to `kubectl`.

## Goal

Add guarded write actions to the RBAC panel: **structured form editors** for the common cases plus a **raw-YAML escape hatch** for everything else, covering **edit rules, edit binding subjects, delete, and create**. Every write is confirmed and shows the exact `kubectl` command. Lifts the read-only footer.

## What already exists (reuse, no server changes)

- **`ConfirmSheet`** (`apps/web/src/components/ConfirmSheet.tsx`) — the universal guarded gate (a Dialog). It previews the exact kubectl command (`POST /api/action?preview=1`) and, for `applyManifest` actions, shows a resource summary and runs `kubectl apply -f -`.
- **`deleteResource` ActionBlock** — already handles `role | rolebinding | clusterrole | clusterrolebinding` (cluster-scoped set in `apps/server/src/actions.ts` omits `-n` for clusterrole/clusterrolebinding). It is in `ALWAYS_DESTRUCTIVE_KINDS`, so RBAC deletes render red automatically.
- **`editYaml(kind, name, namespace)`** (`apps/web/src/store/yamlViewer.ts` → `ResourceYamlViewer`) — opens the Monaco editor pre-filled with the server-cleaned manifest; its Apply builds an `applyManifest` ActionBlock and routes through `ConfirmSheet`. This IS the YAML escape hatch, unchanged.
- **`/api/apply`** — `kubectl apply -f -` (server-side), reached via the `applyManifest` ActionBlock, not directly.
- **Namespaces watch** — the source behind `NamespaceSelector`; reused for every namespace dropdown (per the app rule: namespace inputs are dropdowns, never free text).

## Guarded-apply decision

Both structured editors **build a manifest and hand an `applyManifest` ActionBlock to `ConfirmSheet`** (the same path as the YAML escape hatch and `ApplyYamlPanel`), rather than POSTing to `/api/apply` directly (the `ConfigMapEditor` shortcut). RBAC is security-sensitive: every write shows the exact `kubectl apply` and a resource summary before it runs. This also unifies the structured, YAML, and create paths on one confirm.

## Design (per the Pencil frames)

### Role editor — frame `VXkeO`
A dialog (reusing the app's DialogHeader/Body/Footer chrome and tokens):
- **Header**: file-badge icon, "Edit role" / "New role", a mono name pill (`clusterrole/bootstrap-signer`), close X.
- **Body**:
  - **Create mode only**: a name input, a Role/ClusterRole kind toggle, and a namespace dropdown (shown only for Role). Edit mode shows these as a read-only meta line (`ClusterRole · cluster-scoped`) — identity is immutable; you edit rules.
  - **RULES** section with a count. A list of **rule cards**, each with three token-chip rows — **API GROUPS**, **RESOURCES**, **VERBS** — where each token is a removable chip plus an `add` control, and the card has a trash button to remove the whole rule. Rules classified `dangerous` by the existing `ruleRisk` get a red-tinted border (consistent with the analyzer).
  - **`+ Add rule`**.
- **Footer**: **Edit YAML** (left, opens the raw-YAML path seeded with the in-progress manifest) + **Cancel** + **Apply**.

### Binding editor — frame `spBkt`
- **Header**: link icon, "Edit binding" / "New binding", mono name pill, close X.
- **Body**:
  - **Create mode only**: name input, RoleBinding/ClusterRoleBinding kind toggle, namespace dropdown (RoleBinding only). Edit mode shows a read-only meta line (`RoleBinding · namespace default`).
  - **GRANTS ROLE**: a roleRef picker — a kind dropdown (Role/ClusterRole) + a role-name dropdown (populated from the watched roles/clusterroles of that kind and scope).
  - **SUBJECTS** section with a count. Each **subject row** is `kind ▾ · name · namespace ▾ · remove`, where kind is User/Group/ServiceAccount and the **namespace dropdown is enabled only for ServiceAccount** (dimmed/`n/a` for User/Group).
  - **`+ Add subject`**.
- **Footer**: **Edit YAML** + **Cancel** + **Apply**.

### Attach points (in the existing panel)
- **`RoleDetail` header**: Edit (opens Role editor), Edit YAML (`editYaml`), Delete (`deleteResource` → ConfirmSheet).
- **`BindingCard` header**: a small action menu — Edit (Binding editor), **Add subject** (Binding editor focused on the subjects list), Edit YAML, Delete.
- **`SubjectDetail`**: no direct edit (a "subject" is a computed identity, not one object); its edits happen via the per-binding actions on its `BindingCard`s.
- **Panel header (`RbacPanel`)**: a **New ▾** button (Role / ClusterRole / RoleBinding / ClusterRoleBinding) opening the matching editor in create mode.
- Remove the **"Read-only view"** footer.

## Manifest building

Pure helpers (`apps/web/src/panels/rbac/manifest.ts`, unit-tested):
- `buildRoleYaml({ kind, name, namespace?, labels?, annotations? }, rules: PolicyRule[]): string`
- `buildBindingYaml({ kind, name, namespace?, labels?, annotations? }, roleRef: RoleRef, subjects: Subject[]): string`

Both emit clean `rbac.authorization.k8s.io/v1` manifests. In **edit mode** the identity + `labels`/`annotations` are carried over from the store object (so an apply doesn't drop them); server-assigned fields (`uid`, `resourceVersion`, `creationTimestamp`, `managedFields`, `status`) are never emitted. In **create mode** labels/annotations start empty. Serialization uses the same YAML approach as `buildConfigMapYAML` (`packages/k8s`). The built string feeds both the `applyManifest` ActionBlock and the "Edit YAML" seed.

## Editor state

Each editor is a controlled form (`useState`) seeded from the selected store object in edit mode, or blank in create mode:
- Role editor: `rules: PolicyRule[]` (add/remove rules; add/remove tokens per field).
- Binding editor: `roleRef: RoleRef`, `subjects: Subject[]` (add/remove; per-row kind/name/namespace).
- "Apply" builds the manifest via the helper, wraps it in `{ kind: "applyManifest", label, manifest }`, and opens `ConfirmSheet`. "Edit YAML" hands the same manifest string to the editable YAML viewer.

## Delivery phases (one plan)

1. **Delete + Edit-YAML everywhere** — wire `deleteResource` and `editYaml` affordances into `RoleDetail`, `BindingCard`, and list rows; remove the read-only footer. (Nearly free; ships write-capability immediately.)
2. **Role editor + Create Role** — `manifest.ts` `buildRoleYaml` + the `RoleEditor` dialog + the New→Role entry.
3. **Binding editor + Create/Add-subject** — `buildBindingYaml` + the `BindingEditor` dialog + New→Binding + the per-binding "Add subject".

## Non-goals

- No visual diff of changes (ConfirmSheet shows the full manifest + apply command).
- No editing of `aggregationRule`, label selectors, or non-rule/subject fields via the forms — use the YAML escape hatch for those.
- No client-side RBAC validation beyond what `kubectl apply` (with server dry-run available) reports.
- No bulk edits.

## Testing

- `manifest.test.ts`: `buildRoleYaml`/`buildBindingYaml` for Role vs ClusterRole and RoleBinding vs ClusterRoleBinding; namespace present/omitted by scope; labels/annotations carried over; empty rules/subjects; round-trip shape (parse back to the expected object).
- Component render tests (jsdom + RTL) for `RoleEditor` (add/remove rule + token) and `BindingEditor` (add/remove subject, namespace enabled only for ServiceAccount, roleRef change) — assert the built manifest and that Apply opens ConfirmSheet with an `applyManifest` action.
- Reuse existing `ConfirmSheet`/`deleteResource` coverage; no server changes to test.
- Typecheck + full web vitest; no dev server (live checks via `pnpm --filter desktop dev` only if asked).
