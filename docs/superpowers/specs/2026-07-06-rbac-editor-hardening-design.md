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

- **Per-cluster policies.** Each cluster stores and runs its own assistant policy. A corporate operator can lock the assistant down on prod while granting more on dev; a solo user sets one policy and copies it everywhere.
- **Copy, not broadcast.** The `active | all` target selector is removed. Editing and Apply always act on the **active** cluster only. Cross-cluster replication is an explicit, opt-in "Copy to clusters…" action.
- **Copy the applied policy, not staged edits.** Copy is disabled while there are unsaved staged edits — the user Applies to the active cluster first, then copies what is actually saved.
- **Reads are a non-editable baseline floor.** The assistant can always read cluster state; "read" is no longer a toggle.
- **Drift is surfaced, with a manual re-apply** until HELM-49 reconcile lands.

## Item 3 — Per-cluster persist + copy-to-clusters

### Server (`apps/server/src/assistant.ts`, `rbacApply.ts`)

- `setRbac`: drop `rbacTarget`. Always `contexts = [context]`. Both `patchConfig(context, …)` and `applyPolicy({ policy, contexts: [context] })` run against the active context. Stored + live agree for that one cluster.
- New action `copyRbac(context, namespace, { policy, targetContexts: string[] })`: for each target context, run `patchConfig(ctx, rbacConfigUpdate(policy))` **and** `applyPolicy({ policy, contexts: [ctx] })`. Collect per-context `{ context, ok, error? }` results; return them so the UI can show per-cluster outcome. Reuse `applyPolicy`/`clusterRoleOnly` — no new apply plumbing.
- New action `installedContexts(namespace)`: expose `discoverInstalledContexts(namespace)` to the client as `{ name, active }[]` so the copy picker can list eligible clusters (managed `rigel-assistant` deployment present). Excludes the active cluster from copy targets.

### Frontend (`apps/web/src/panels/assistant/`)

- `PermissionsTab.tsx`: remove the `active | all` dropdown and `perms.setTarget`. Add a **"Copy to clusters…"** button next to Apply, disabled when `diff.count > 0` (unsaved edits) or when there are no other installed clusters.
- `usePermissions.ts`: drop `target`/`setTarget`/`rbacTarget`. `apply` sends `{ action: "setRbac", namespace, policy }` (no target).
- New `CopyToClustersDialog` (uses `ui/dialog.tsx`, per the Dialogs-not-Sheets convention): fetches `installedContexts`, renders a multi-select checkbox list of the other clusters, shows the policy being copied (reuse the review/diff dialog content), and on confirm calls `copyRbac`. Renders per-cluster success/failure on completion. Cluster selection is a checkbox list, never free text.
- Guarded action: copy runs through the existing review/confirm surface before it mutates, consistent with every other mutation.

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
- `apps/server`: `setRbac` persists + applies to active only; `copyRbac` persists + applies to each target and reports per-context failures; `installedContexts` excludes the active/foreign contexts.
- `apps/web`: `usePermissions` exposes `drift` and no `target`; Simple partial toggle clears; copy button disabled with unsaved edits.
- `pnpm --filter web typecheck`, `pnpm --filter web test`, `pnpm --filter @rigel/server test`, `pnpm --filter @rigel/k8s test`.
