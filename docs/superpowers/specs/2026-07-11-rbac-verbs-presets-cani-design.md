# RBAC panel — verb narrowing, role presets, and inline `auth can-i` (HELM-83/84/85)

Grow the RBAC "breakout" with three cohesive additions to the existing role/binding
editors and the role detail view. All three come from the "Ideas / future" section of
the RBAC Outline doc.

- **HELM-83** — narrow the VERBS combobox to the verbs a picked resource actually supports.
- **HELM-84** — offer starter role presets in the New role dialog.
- **HELM-85** — inline `auth can-i` test in the New binding dialog, and per-subject
  effective-access testing from a Role's detail view.

## Current state (what exists)

- `GET /api/api-resources` → `getApiResources(context)` in `apps/server/src/apiResources.ts`
  runs `kubectl api-resources --no-headers` and returns `{ resources, groups }`.
- Client hook `useApiResources()` (`apps/web/src/lib/api.ts`) feeds group/resource
  suggestions into `RoleEditor.tsx`'s three `TokenInput` comboboxes (API GROUPS / RESOURCES /
  VERBS). VERBS is a static list `RBAC_VERBS`.
- `RoleEditor.tsx` (New role dialog), `BindingEditor.tsx` (New binding dialog),
  `RoleDetail.tsx` (right-pane role view with a static "Bound to" subject list).
- Grant resolution lives in `apps/web/src/panels/rbac/access.ts` (`resolveRoleRules`,
  `subjectsForRole`, …). `RbacPanel.tsx` owns the `roles`/`clusterRoles` pools.
- Existing `auth can-i` precedent: `apps/server/src/access.ts` shells `kubectl auth can-i`.
  `commandPolicy.ts` already classifies `auth can-i` as a read (non-mutating) command.

## HELM-83 — narrow VERBS to a resource's supported verbs

`kubectl api-resources -o wide --no-headers` adds a **VERBS** column that is
**comma-separated with no internal spaces** (verified on the live cluster), e.g.:

```
pods   po   v1   true   Pod   create,delete,deletecollection,get,list,patch,update,watch   all
```

So the existing whitespace-split parser still works — the verbs are a single column at
`namespacedIdx + 2` (NAMESPACED, KIND, VERBS). No bracket handling needed.

**Server** (`apiResources.ts`):
- Change the kubectl call to `["api-resources", "-o", "wide", "--no-headers"]`.
- Extend the parser to also read `cols[namespacedIdx + 2]`, split on `,`, and **union** into
  `verbsByResource: Record<string, string[]>` keyed by resource name (same name can appear under
  multiple apiVersions — e.g. `pods`/PodMetrics — so union, then sort).
- Extend `ApiResourcesResult` with `verbsByResource`. Existing `resources`/`groups` unchanged.

**Client** (`lib/api.ts`): `ApiResourcesResponse` gains `verbsByResource` (default `{}`); tolerant
parse like today.

**RoleEditor** (`RoleEditor.tsx`): per rule, compute verb suggestions with a pure helper
`verbSuggestionsForResources(resources, verbsByResource)`:
- Union the supported verbs of the rule's currently-picked resources that we have data for.
- Always append `"*"`.
- If the rule has no resources picked, or none have verb data (unregistered CRD, or `*`), fall
  back to the full `RBAC_VERBS` list.
- Suggestions stay **free-typable** (TokenInput already accepts free entries), so `bind`,
  `escalate`, `impersonate`, `use`, and `*` remain enterable even when a resource doesn't
  report them.

## HELM-84 — role presets

A `ROLE_PRESETS` table (id, label, `rules: PolicyRule[]`) rendered as a **PRESET** row of three
pills at the top of the New role dialog, **create mode only** (`!isEdit`), above the RULES section.
Clicking a preset **replaces** the current rules with a deep copy of the preset's rules. Track the
last-picked preset id for a light active highlight; clear it on any manual rule edit.

Presets:

| Preset | Rules |
|--------|-------|
| **Read-only** | `apiGroups:["*"] resources:["*"] verbs:[get,list,watch]` |
| **Namespace admin** | `apiGroups:["*"] resources:["*"] verbs:["*"]` |
| **Deployer** | `apps: [deployments,replicasets,statefulsets,daemonsets]` + `core("") : [pods,services,configmaps,secrets]`, both `verbs:[get,list,watch,create,update,patch,delete]` |

The existing red-tint danger flags on `*`/`secrets` naturally mark the Namespace-admin and
Deployer presets, so the danger surfaces without extra work.

## HELM-85 — inline `auth can-i` test

### Server engine + route

New `apps/server/src/rbacCanI.ts` (pure, testable helpers + a runner):

- `CanICheck = { verb, resource, apiGroup?, namespace? }`
- `CanIResult = CanICheck & { allowed: boolean | null }`
- `impersonationArgs(subject)` →
  - ServiceAccount → `--as=system:serviceaccount:<namespace>:<name>`
  - User → `--as=<name>`
  - Group → `--as=rigel:can-i-probe --as-group=<name>` (kubectl requires a `--as` user alongside
    `--as-group`; a synthetic username in the target group yields the group's effective access).
- `resourceArg(check)` → `resource.apiGroup` when apiGroup is a real non-empty, non-`*` group
  (e.g. `deployments.apps`), else bare `resource`.
- `runCanI(context, subject, checks, run)` → runs `kubectl auth can-i <verb> <resourceArg>
  [<impersonation>] [-n <ns>]` per check. Parse: last non-empty stdout line `=== "yes"` → true,
  `=== "no"` → false, else `null`. If stderr signals an impersonation/forbidden failure, `allowed:
  null` and set a shared `note` on the response so the client can hint "needs impersonate
  permission".

Route: `POST /api/rbac/can-i`, body `{ subjects: Subject[], checks: CanICheck[] }` →
`{ results: Array<{ subject, checks: CanIResult[] }>, note?: string }`. Read-only — no confirm
sheet, uses `kubectl(context, …)` directly like `access.ts`. Client caller
`postCanICheck(subjects, checks)` in `lib/api.ts` (via `apiFetch`, context header).

### Client: expand rules → checks

Pure helper `apps/web/src/panels/rbac/canI.ts`: `rulesToChecks(rules, namespace?)` expands a role's
`PolicyRule[]` into deduped `CanICheck[]` (first apiGroup per rule, cap ~24 to bound work),
keeping `*` verb/resource entries (a valid, meaningful `can-i '*' '*'`).

### Shared `AccessTest` component

`apps/web/src/panels/rbac/components/AccessTest.tsx` — takes `{ subject, checks }`, owns its own
run/loading/results state, and renders a **Test access** trigger plus, once run, a row per check:

- `allowed === true` → `✓ already allowed`
- `allowed === false` → `✗ → granted by this binding`
- `allowed === null` → `? unknown` (+ the `note` hint when present)

Styled with design tokens (`var(--fg-*)`, `var(--status-*)`) so it reads correctly in both the
hex-styled binding dialog and the token-styled role detail pane.

### Wiring

- **BindingEditor**: a **TEST ACCESS** section after SUBJECTS, rendering one `AccessTest` per
  subject (checks = `rulesToChecks` of the granted role's rules for the current namespace).
  BindingEditor gets the granted role's rules via a new optional prop `rulesForRole?(kind, name,
  namespace) => PolicyRule[]`, which `RbacPanel` supplies from `resolveRoleRules` over its pools.
  The section is disabled until roleRef.name and at least one subject name are set.
- **RoleDetail**: each "Bound to" subject row gets a per-subject `AccessTest` (checks =
  `rulesToChecks` of the role's own rules). Same component, on demand.

## Testing

- `apiResources.test.ts` — extend for `-o wide` verbs parsing + `verbsByResource` union across
  same-named resources.
- `rbacCanI.test.ts` — `impersonationArgs` (all 3 kinds), `resourceArg` (grouped/core/`*`),
  and stdout/stderr → `allowed` mapping (yes/no/unknown/impersonation-forbidden).
- `canI.test.ts` — `rulesToChecks` dedupe + cap + `*` handling.
- `RoleEditor` — preset replaces rules; `verbSuggestionsForResources` narrows/falls back.
- Existing RBAC tests stay green.

## Out of scope / YAGNI

- No live `SelfSubjectRulesReview` graph; the static analyzer stays as-is.
- No preset editing/persistence; presets are constant seeds.
- No batching cleverness beyond one request per Test-access click.
```
