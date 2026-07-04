# Grant the assistant a role — bind its ServiceAccount to an RBAC role

**Date:** 2026-07-03
**Reuses:** the RBAC write-actions feature (`BindingEditor`, `buildBindingYaml`, `applyManifest → ConfirmSheet`) on branch `feature/rbac-access-analysis`. Continues on the same branch.
**Pencil frame:** `spBkt` "RBAC — Binding editor" (reused as-is; the only new UI is the entry-point button).

## Problem

The in-cluster Rigel assistant runs as the `rigel-assistant` ServiceAccount with **hard-coded** RBAC (a ClusterRole for cluster-wide reads + patch/scale/delete on a few kinds, and a namespaced Role for its own state). There's no in-app way to give the assistant additional access (or scope it) — e.g. to let it read a CRD, patch a StatefulSet, or operate in a namespace the built-in rules don't cover. Today that means hand-writing a RoleBinding and `kubectl apply`.

## Goal

A guided **"Grant a role"** action that binds the assistant's ServiceAccount to a Role or ClusterRole the user picks, through the same guarded flow as every other RBAC write. Each grant is a **dedicated, revocable binding**, so the extra access sits visibly on top of the install RBAC and can be removed with one delete.

## Design (Approach A — dedicated binding per grant)

### Entry point
A **"Grant a role"** button in the Assistant panel's `OwnedResources` section (`apps/web/src/panels/assistant/OwnedResources.tsx`) — the panel that already lists the assistant's ServiceAccount / ClusterRole / ClusterRoleBinding and knows the **install namespace** (`ns` prop). Placing it there keeps the assistant's identity and namespace in scope.

### Flow
Clicking opens the existing **`BindingEditor`** (frame `spBkt`) in create mode, **pre-seeded**:
- **subject**: `[{ kind: "ServiceAccount", name: "rigel-assistant", namespace: <installNs> }]` (locked as the one subject; the user is granting the assistant, not editing arbitrary subjects).
- **kind**: default `ClusterRoleBinding` with `roleRef.kind: ClusterRole` (the assistant is a cluster-wide agent, so a ClusterRole is the common case). The user may switch to `RoleBinding` (then picks a namespace + a namespaced Role) via the editor's existing kind toggle.
- **name**: suggested `rigel-assistant-<roleName>` (recomputed as the role is chosen; user-editable).
- **roleRef.name**: empty — the user picks the Role/ClusterRole from the editor's existing roleRef dropdown (populated from the watched roles/clusterroles).

Apply routes through the same guarded path as all RBAC writes: `buildBindingYaml` → `{ kind: "applyManifest", label, manifest }` → **`ConfirmSheet`** (shows the exact `kubectl apply`). No server changes.

### Feedback loop (the safety net)
Granting the assistant a dangerous role (e.g. one with `secrets` access or cluster-admin) is a real privilege escalation — but it's user-initiated and guarded. After apply, the **RBAC analyzer** immediately shows the assistant's new grant and flags it `dangerous`/`wildcard` via the existing `ruleRisk` classifier. So the analyzer is the review surface; no separate warning UI is needed for v1.

### Revoke
Not a new feature. The dedicated `rigel-assistant-<role>` binding appears in the RBAC panel (and in `OwnedResources` presence) and deletes via the guarded delete already built.

## Components

- **New** `apps/web/src/panels/assistant/GrantRoleButton.tsx` — a small launcher: the "Grant a role" button + a `BindingEditor` instance + a `ConfirmSheet`, owning the `pendingAction` state and computing `roleOptions` from the store (`useCluster((s) => s.resources)` roles + clusterroles), exactly as `RbacPanel` does. It subscribes to `roles`/`clusterroles`/`clusterrolebindings` while mounted (via `@/lib/ws` `subscribe`/`unsubscribe`) so the roleRef dropdown and the created binding are populated even if the RBAC panel was never opened. On apply it wraps the manifest in an `applyManifest` ActionBlock and opens `ConfirmSheet`.
- **Modify** `apps/web/src/panels/assistant/OwnedResources.tsx` — render `<GrantRoleButton namespace={ns} />` in the section header (it already receives `ns`).
- **Reuse unchanged**: `BindingEditor` (+ its `roleOptions` prop), `buildBindingYaml`, `ConfirmSheet`, `deleteResource` (for revoke).

BindingEditor already supports a pre-seeded create target and a locked-feeling single subject; no change needed. If the launcher needs the subject to be non-removable, it can simply omit passing an `onDelete`-style removal — but the plain create flow (one seeded subject the user can still add to) is acceptable for v1.

## Scope notes / constraints

- **Active cluster only.** The binding applies through the normal `/api/apply` path against the cluster whose resources are watched. The assistant's *control* route (install/config) has a separate multi-cluster gap (`apps/server/src/index.ts` uses the boot context), but creating a binding does not — so this works on whatever cluster is active in the rail.
- **Only the primary SA.** v1 grants `rigel-assistant`. The `rigel-fix-runner` SA (used for fix Jobs, `automountServiceAccountToken: false`) is out of scope.

## Non-goals

- Not editing the assistant's built-in ClusterRole rules (that's the separate "editable permissions" idea).
- No new server action — reuses `/api/apply` via `applyManifest`.
- No multi-cluster assistant control-route fix.
- No bespoke "dangerous grant" warning UI — the analyzer covers it.
- No automatic revoke/expiry — revoke is deleting the binding.

## Testing

- `GrantRoleButton` render test (jsdom + RTL): the button opens `BindingEditor` pre-seeded with the `rigel-assistant` ServiceAccount subject in the install namespace and a `ClusterRoleBinding` default; picking a role and applying opens `ConfirmSheet` with an `applyManifest` action whose manifest contains `kind: ServiceAccount` / `name: 'rigel-assistant'` and the chosen `roleRef`.
- Reuse existing `BindingEditor`/`buildBindingYaml`/`ConfirmSheet` coverage.
- Typecheck + full web vitest; no dev server (live checks via `pnpm --filter desktop dev` only if asked).
