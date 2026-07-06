# RBAC editor hardening — per-cluster policies, drift, read baseline, partial toggle

Follow-ups from the code review of the RBAC editor (HELM-52 / branch `feature/rbac-editor`), tracked as **HELM-53**. F1 (silent apply-failure reported as success) is already fixed on master (`caed4472`). This spec covers the remaining four items plus a scope change agreed during design: policies become **per-cluster** with an explicit **copy-to-clusters** action, replacing the old "apply to all clusters" toggle.

## Background — current model

- Stored policy lives in the `assistant-config` ConfigMap, key `rbacPolicy`, value `serializePolicy(policy)` (`{ cells: string[] }`, each cell `"apiGroup|resource|verb"`). The ConfigMap is **namespaced and per-cluster-context** — the storage model is already per-cluster.
- `getRbac` (`apps/server/src/assistant.ts`) reads the stored policy (falls back to `DEFAULT_POLICY`) and, best-effort, the live ClusterRole rules via `readAppliedClusterRoleRules` → returns `{ policy, appliedRules }`.
- `setRbac` applies the rendered ClusterRole to every targeted context (`rbacTarget: "active" | "all"`) but `patchConfig`s the stored policy **only to the active context** — the multi-cluster persist bug.
- The final ClusterRole is `rbac(ns, policy)` in `packages/k8s/src/assistant.ts`, which concatenates `BASELINE_READ_RULES` with `policyToClusterRoleRules(policy)`. The two overlap on read verbs with no cross-dedup → 16 rules instead of 15.
- `usePermissions` fetches `appliedRules` but never surfaces it; no drift UI exists.
- HELM-49 "reconcile" (a job that keeps the live cluster at the stored policy) is **designed but not implemented**; `appliedRules` is its groundwork.

## Decisions (agreed during design)

- **Per-cluster policies.** Each cluster stores and runs its own assistant policy. A corporate operator can lock the assistant down on prod while granting more on dev; a solo user sets one policy and pushes it everywhere.
- **All mutations act on the current working (staged) policy.** No "save locally first" step — every save/copy pushes exactly what the editor currently shows, so in-progress edits reach other clusters in a single action.
- **Three explicit scopes, one action.** The `active | all` broadcast dropdown is removed in favor of explicit buttons: **Apply** (active cluster), **Save to all clusters** (every installed cluster), and **Copy to clusters…** (a chosen subset). All three go through the same guarded review/confirm surface and the same server action, differing only in the cluster list they pass.
- **Reads are a non-editable baseline floor.** The assistant can always read cluster state; "read" is no longer a toggle.
- **Drift is surfaced, with a manual re-apply** until HELM-49 reconcile lands.

## Item 3 — Per-cluster persist + copy-to-clusters

### Server (`apps/server/src/assistant.ts`, `rbacApply.ts`)

- Replace `setRbac`'s `rbacTarget` branch with a single action that takes an **explicit context list**: `setRbac(context, namespace, { policy, contexts: string[] })`. For each context in the list, run `patchConfig(ctx, rbacConfigUpdate(policy))` **and** `applyPolicy({ policy, contexts: [ctx] })` so stored + live agree on every cluster it touches. Collect per-context `{ context, ok, error? }` results and return them so the UI can show per-cluster outcome. Reuse `applyPolicy`/`clusterRoleOnly` — no new apply plumbing. This one action serves all three scopes; the client decides the list (`[active]`, all installed, or a picked subset).
- New action `installedContexts(namespace)`: expose `discoverInstalledContexts(namespace)` to the client as `{ name, active }[]` so the UI can build the "all clusters" list and the copy-subset picker (managed `rigel-assistant` deployment present).

### Frontend (`apps/web/src/panels/assistant/`)

- `PermissionsTab.tsx`: remove the `active | all` dropdown and `perms.setTarget`. Present three actions on the current staged policy:
  - **Apply** (primary button) → `setRbac({ policy: staged, contexts: [activeContext] })`.
  - **Save to all clusters** → `setRbac({ policy: staged, contexts: allInstalled })` (one click; includes in-progress edits).
  - **Copy to clusters…** → opens the picker dialog, then `setRbac({ policy: staged, contexts: pickedSubset })`.
  - To avoid toolbar clutter, "Save to all clusters" and "Copy to clusters…" hang off a caret/dropdown next to the primary Apply button. Both are hidden/disabled when there are no other installed clusters.
- `usePermissions.ts`: drop `target`/`setTarget`/`rbacTarget`. The apply mutation takes an explicit `contexts` argument and sends `{ action: "setRbac", namespace, policy: serializePolicy(staged), contexts }`. All three buttons call the same mutation with different lists.
- New `CopyToClustersDialog` (uses `ui/dialog.tsx`, per the Dialogs-not-Sheets convention): fetches `installedContexts`, renders a multi-select checkbox list of the **other** clusters (with a "select all"), shows the staged policy/diff being pushed (reuse the review/diff dialog content), and on confirm runs the mutation with the picked subset. Renders per-cluster success/failure on completion. Cluster selection is a checkbox list, never free text.
- Guarded actions: every scope runs through the existing review/confirm surface before it mutates. The confirm names the exact cluster set being written.

## Item 1 — Drift indicator

- `packages/k8s/src/rbacPolicy.ts`: add pure `liveMatchesPolicy(appliedRules: unknown[], policy: RbacPolicy): boolean` — normalize the live ClusterRole rules and the rules rendered from the stored policy (comparing the `rules` arrays as order-independent sets of `(apiGroup, resource, verb)` tuples, including the baseline). Returns `true` when they match, `false` when the live cluster diverges. Takes a non-null rules array; the null case is handled by the caller, not this function. Fully unit-tested.
- `usePermissions.ts`: surface `appliedRules` and a derived `drift: boolean`. `drift = appliedRules != null && !liveMatchesPolicy(appliedRules, applied)`.
- `PermissionsTab.tsx`: when `drift`, render a small banner — "This cluster's live permissions differ from your saved policy" — with a **Re-apply** button that re-applies the stored (`applied`) policy to the active cluster (calls the same `setRbac` path). This is the manual stand-in for HELM-49 reconcile.
- Because `drift` is false whenever `appliedRules` is null, a failed best-effort live read (or a missing ClusterRole) shows **no** banner — a failed read must never be reported as drift.

## Item 2 — Read baseline floor (de-dup to 15 rules)

- `packages/k8s/src/rbacPolicy.ts`:
  - Remove `"read"` from `DEFAULT_POLICY`'s capability list (keep `reversible`, `deletePods`, `cordon`).
  - Mark the `read` capability as non-editable/informational (e.g. a `baseline: true` flag on the capability, or move it out of the editable `CAPABILITIES` list into a separate `BASELINE_CAPABILITY` descriptor the Simple view renders as always-on).
  - `parsePolicy`: strip any read cells already covered by the baseline when loading a stored policy, so pre-existing configs de-dup on next render.
- `packages/k8s/src/assistant.ts`, `rbac()`: **structural cross-dedup** — before concatenating, subtract any `(apiGroup, resource, verb)` already present in `BASELINE_READ_RULES` from the policy-rendered rules. Guarantees no duplicate regardless of stored policy content. This is the load-bearing correctness fix; the UI change is cosmetic on top of it.
- `SimpleView.tsx`: render "Read everything" as an always-on, disabled informational row ("Always on — the assistant can always read cluster state").
- `AdvancedView.tsx`: baseline read cells (get/list/watch on baseline resources) render checked + disabled.
- Test: rendered ClusterRole for `DEFAULT_POLICY` has exactly 15 rules and no duplicate read rule; toggling has no read cells to toggle.

## Item 4 — Simple partial toggle clears in one click

- `SimpleView.tsx`, `CapabilityToggle`: when state is `"partial"`, `onClick` calls `onChange(false)` (clear the capability) instead of the current hardwired `onChange(true)`. One click removes a partially-granted capability; a second click (now `off`) grants it fully if desired. `setCapability(policy, id, false)` already supports removal.

## Out of scope

- HELM-49 reconcile job itself (this spec only wires the drift signal + manual re-apply).
- Per-cluster policy **divergence indicators** across the cluster rail (a cluster-list overview of who has what) — future.
- Editing secrets / roles / rolebindings (remains locked, unchanged).

## Testing

- `packages/k8s`: unit tests for `liveMatchesPolicy` (match, drift, null), the `rbac()` cross-dedup (15 rules, no dup, stale stored read cells still de-dup), `DEFAULT_POLICY` no longer contains read cells, `parsePolicy` strips baseline read cells.
- `apps/server`: `setRbac` persists + applies to **each** context in the passed list (single active, all installed, or a subset) and reports per-context failures; a failure on one context doesn't abort the others; `installedContexts` returns only managed contexts with the `active` flag set.
- `apps/web`: `usePermissions` exposes `drift` and no `target`; Apply / Save to all / Copy all push the current staged policy; Simple partial toggle clears in one click.
- `pnpm --filter web typecheck`, `pnpm --filter web test`, `pnpm --filter @rigel/server test`, `pnpm --filter @rigel/k8s test`.
