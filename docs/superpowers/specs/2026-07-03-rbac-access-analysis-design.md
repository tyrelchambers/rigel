# RBAC panel — access analysis redesign

**Date:** 2026-07-03
**Pencil frame:** `dPDS8` "RBAC panel (improved)" in `clankerlocal.pen`
**Status:** design approved (Pencil is source of truth), spec for implementation

## Problem

The current RBAC panel (`apps/web/src/panels/rbac/RbacPanel.tsx`) is a flat browser: five kind-toggle pills (ServiceAccounts, Roles, RoleBindings, ClusterRoles, ClusterRoleBindings), a search box, and expanded rows that show a `<pre>` of policy rules or a plain role-ref/subjects list. Each kind is shown in isolation.

Kubernetes RBAC is a graph — `Subject → Binding → Role → Rules` — but the panel makes the user reconstruct that graph by hand across four tabs. The two questions operators actually ask are not directly answerable today:

1. **"What can this subject do?"** — pick a ServiceAccount/user/group, see its effective (resolved, deduped) permissions.
2. **"Who can do X?"** — pick a role, see who is bound to it.

And nothing surfaces **risk**: cluster-admin bindings, wildcard verbs/resources, or the escalation verbs (`escalate`, `bind`, `impersonate`) and secrets access.

## Goal

Replace the flat browser with a **subject/role-centric access analyzer** that resolves the RBAC graph for the user and flags dangerous grants. Stays **read-only** — no create/edit/delete (that is a separate follow-up spec).

## Design (per the `.pen`)

Two-pane layout inside the existing panel route (`/rbac`).

### Chrome
- **Header** (`jCCZq`): title "RBAC" / subtitle "Who can do what, to what"; right side has a namespace dropdown (reuse the shared namespaces watch — never free text) and a search input "Filter by subject, role, or resource…".
- **Status strip** (`M1w91`): count chips `SUBJECTS · ROLES · BINDINGS · DANGEROUS` (DANGEROUS rendered in `$status.failed`), plus a scope segmented toggle **All / Namespaced / Cluster** (`yvwTj`).
- **Footer** (`U4MyXc`): "Read-only view. RBAC is inspected here, not edited."

### Left pane — list (452px, `nlrak`)
- **View toggle** (`sHUgU`): **Subjects | Roles** — pivots what the list and detail pane are keyed on.
- Rows: subject/role name, type icon, namespace/scope, dangerous rows flagged. Selected row highlighted (accent-dim + accent border, see `KXAOT`).

### Right pane — detail (`x97yi`)
When a **subject** is selected:
- **Subject head** (`WbNpa`) + "Ask Rigel about access" button → chat handoff (`buildHandoffPrompt`).
- **Summary strip** (`NXU4J`): `N roles bound · N namespace + cluster · N dangerous grant` (dangerous segment red with `shield-alert`).
- **Access section** (`O2BGO`): caption "Roles bound to this subject, and the rules they grant" + legend (**dangerous** red dot, **wildcard** amber dot).
- **Binding cards** (`iwrKi`), one per binding referencing the subject: header shows `binding → RoleRef` (as an accent pill, e.g. `Role/rigel-agent`) and a scope pill (`Namespaced · default` or `Cluster`); then a **RULES** section rendering each policy rule as a row with three columns — **API GROUP** (`120px`), **RESOURCES** (`fill`), **VERBS** (`300px`). Dangerous rules get a red-tinted border (`#EF444426`).

When a **role** is selected (Roles view): the detail pane lists **subjects bound to this role** (reverse lookup) plus the role's own rules table.

## Access resolution (client-side)

All five RBAC kinds are already watched into the Zustand cluster store via the generic WS watch — no new server work required for reads. Add a pure resolver module `apps/web/src/panels/rbac/access.ts` (unit-tested, mirrors the `rbacDisplay.ts` pattern):

- **Subject key**: `(kind, name, namespace?)` — normalize ServiceAccount/User/Group into one comparable key.
- **`bindingsForSubject(subject)`**: scan all `RoleBinding` + `ClusterRoleBinding` whose `subjects[]` match the key.
- **`resolveRole(roleRef, bindingNamespace)`**: RoleRef → the `Role` (namespaced, use binding ns) or `ClusterRole` object; return its `rules[]`.
- **`effectiveGrants(subject)`**: bindings → resolved roles → flattened list of `{ binding, roleRef, scope, rules }`, feeding the binding cards.
- **`subjectsForRole(role)`**: reverse — all bindings referencing a given role, and their subjects (Roles view detail).
- **Counts** for the status strip derive from the store slices; DANGEROUS = distinct subjects with ≥1 dangerous grant.

### Risk classification
Pure predicate `ruleRisk(rule): 'dangerous' | 'wildcard' | null`:
- **dangerous**: verbs include any of `escalate`, `bind`, `impersonate`; OR `secrets` in resources with `get`/`list`/`watch`/`*`; OR the grant is `cluster-admin` (roleRef name) / wildcard verb **and** wildcard resource **and** cluster scope.
- **wildcard**: `*` in verbs or resources (that isn't already dangerous).

(Exact rule set to be confirmed against the `.pen` legend — dangerous + wildcard are the only two tiers shown.)

## Reverse query "who can do X?"

The Roles view answers "who is bound to this role". A verb+resource query ("who can `delete pods`?") is computable client-side by scanning every subject's effective grants, but is **out of scope for v1** — the `.pen` does not show a query builder. Note it as a follow-up so we do not silently imply it ships.

## Components / reuse
- New pane structure is bespoke (two-pane), not `ListRow` — but reuse `PanelHeader`, the shared `TabBar`/`Tab` for the Subjects/Roles + scope toggles (replace the current hand-rolled pills), `StatusBadge`, `MetaCard`-style caps, and `buildHandoffPrompt` for the Ask handoff.
- Keep `apps/web/src/panels/rbac/types.ts` (already models `PolicyRule`, `RoleRef`, `Subject`, etc.); extend as the resolver needs.
- All styling via Tailwind + tokens (no hand-written CSS, no raw hex/px), matching the `.pen` variable names (`$surface.*`, `$foreground.*`, `$status.failed`, `$accent.primary*`, `$border.*`, `$radius.*`).

## Non-goals (explicit)
- No write actions (create/edit/delete Roles or Bindings). Server already supports RBAC deletes (`actions.ts`); wiring them is a separate spec.
- No verb+resource "who can do X" query builder in v1.
- No `kubectl auth can-i` server endpoint — resolution is client-side from watched objects.

## Testing
- `access.test.ts`: subject-key normalization; bindingsForSubject across both binding kinds; resolveRole for namespaced vs cluster; effectiveGrants dedup; subjectsForRole reverse lookup; `ruleRisk` tiers (escalate/bind/impersonate, secrets, wildcard, cluster-admin).
- Keep existing `rbacDisplay.test.ts` green; extend display helpers as needed.
- Typecheck + vitest; no dev server (verify via `pnpm --filter desktop dev` only if asked).
