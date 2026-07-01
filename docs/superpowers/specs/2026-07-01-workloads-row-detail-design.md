# Workloads row drop-down detail — design

**Date:** 2026-07-01
**Status:** Approved design, pending spec review
**Area:** `apps/web/src/panels/workloads/`

## Problem

Every row in the Workloads panel (tabs: **StatefulSets, DaemonSets, Jobs,
CronJobs**) renders a chevron via the shared `ListRow` component. The chevron
toggles `isOpen` correctly, but `ListRow` only renders expanded content when
**both** `isOpen && expandedContent` are truthy:

```tsx
{isOpen && expandedContent && ( …detail panel… )}
```

None of the four workload row components (`StatefulSetRow`, `DaemonSetRow`,
`JobRow`, `CronJobRow`) pass `expandedContent`, so the chevron expands to
nothing. This is an **unfinished feature**, not dead UI: every other panel
(Deployments, Pods, Services, ConfigMaps, Secrets, Storage, Ingresses,
Namespaces, RBAC, Certificates, Databases, Events, RightSizing) fills its
drop-down. Workloads is the only panel that leaves it empty.

## Goal

Give all four workload kinds a rich expanded detail that matches the existing
`DeploymentDetail` drop-down (`apps/web/src/panels/deployments/DeploymentDetail.tsx`),
so Workloads is consistent with the rest of the app. Full parity, including
Related resources for all four kinds.

Non-goals: no Pencil design pass (the existing `DeploymentDetail` layout is the
visual reference); no new inline actions in the drop-down (actions stay in the
existing right-click / context menu, exactly as `DeploymentDetail` does today);
no server-side changes (the store already holds the full workload objects).

## Architecture

### New shared component: `WorkloadDetail`

`apps/web/src/panels/workloads/WorkloadDetail.tsx`

```ts
function WorkloadDetail({ workload, kind }: { workload: Workload; kind: WorkloadKind }): JSX.Element
```

Renders a common skeleton, matching `DeploymentDetail`'s section order:

1. **SPEC grid** — a 2-column `Field` grid whose rows are supplied per-kind by a
   descriptor function (see below).
2. **Container card(s)** — image + CPU/MEM request→limit, reusing the extracted
   shared container-card component. Source pod template differs by kind
   (resolved by a helper): sts/ds/job = `spec.template.spec.containers`,
   cronjob = `spec.jobTemplate.spec.template.spec.containers`.
3. **Kind-specific extras:**
   - StatefulSet → **volumeClaimTemplates** summary (name · size · storageClass).
   - Job → **Conditions** list (type `Complete`/`Failed` + reason/message).
   - CronJob → **Active jobs** list (names of currently-running jobs).
4. **Labels / Annotations** — `MetaChips` (reused as-is).
5. **Related resources** — `RelatedResources` with `sourceKind` = singular kind.

The panel decides the section wiring by `kind`; there is ONE component, not four
near-duplicate detail files (per the repo's "reuse over near-dupes" convention).

### Per-kind SPEC grid content

- **StatefulSets** — Namespace · Age · Replicas (desired) · Ready · Service name
  (`spec.serviceName`) · Update strategy · Selector.
- **DaemonSets** — Namespace · Age · Desired · Ready · Available · Up-to-date ·
  Node selector · Update strategy · Selector.
- **Jobs** — Namespace · Age · Status (phase) · Completions (x/y) · Parallelism ·
  Succeeded / Failed · Start time · Completion time · Duration · Backoff limit.
- **CronJobs** — Namespace · Age · Schedule · Suspend · Concurrency policy ·
  Last schedule · Active count · History limits (successful / failed).

### Row wiring

Each `*Row` component adds `expandedContent={<WorkloadDetail workload={x} kind={…} />}`
to its `ListRow`. No change to the existing `isOpen` / `toggleExpand` plumbing in
`WorkloadsPanel.tsx` (already present).

## Reuse & targeted refactors

These extractions are in direct service of building `WorkloadDetail` without
duplicating markup — not unrelated cleanup.

1. **Extract container card + `Field` from `DeploymentDetail`** into shared
   components under `apps/web/src/panels/components/`:
   - `ContainerCards` (the container card list + `ResourceCell`).
   - `Field` / field-grid helper.
   `DeploymentDetail` is refactored to consume the extracted components
   (verbatim markup, no visual change).
2. **Generalize `containerSummaries`** so it accepts a pod-template spec (or
   container array) rather than a `Deployment`. Deployments and all four
   workload kinds then share one implementation. Keep the existing
   `containerSummaries(deployment)` call sites working (thin wrapper or updated
   call).
3. **Reuse as-is:** `MetaChips`, `SectionCard`, `StatusBadge`, `TagPill`,
   `RelatedResources`, and the `workloadsDisplay.ts` helpers that already exist
   (`relativeAge`, `readyFraction`, `statefulSet*`/`daemonSet*` ready/desired,
   `jobPhase`, `jobDuration`, `jobCompletionsLabel`, `lastScheduleAgo`,
   `cronJobActiveCount`, `isCronJobSuspended`).

## relatedResources extension (full-parity work)

`apps/web/src/lib/relatedResources.ts` currently handles source kinds
`deployment`, `statefulset`, `daemonset`, `pod`, `ingress`, `service`. Add:

- **`case "job":`** → related **pods** (pods whose `ownerReferences` point at the
  job) plus **configmaps / secrets** referenced by the job's pod template
  (`podRefs`), matching how workloads resolve related config.
- **`case "cronjob":`** → related **jobs** (jobs whose `ownerReferences` point at
  the cronjob).

Update `relatedKindsFor` and `computeRelated` for both. Confirm whether
`WORKLOAD_KINDS` (currently `["deployments","statefulsets","daemonsets"]`, used
for pod→owner resolution) needs `jobs` added so a pod can resolve its owning job;
adjust if required.

## Types

Extend `apps/web/src/panels/workloads/types.ts` to type the fields the detail
reads — no `any` casts:

- Shared pod-template shape (containers with name/image/ports/resources).
- StatefulSet: `spec.serviceName`, `spec.updateStrategy`, `spec.selector`,
  `spec.volumeClaimTemplates[]` (name, resources.requests.storage,
  storageClassName).
- DaemonSet: `spec.template`, `spec.updateStrategy`, `status` fields
  (numberAvailable, updatedNumberScheduled, desiredNumberScheduled, numberReady).
- Job: `spec.parallelism`, `spec.backoffLimit`, `spec.template`,
  `status.failed`, `status.conditions[].reason/message`.
- CronJob: `spec.concurrencyPolicy`, `spec.successfulJobsHistoryLimit`,
  `spec.failedJobsHistoryLimit`, `spec.jobTemplate…`, `status.active[]`.

The store already delivers these at runtime (the current thin types are just a
partial view); this only widens the TS view.

## Styling

Reuse the existing shared components (they carry the app's established styles).
Write any **new** markup — Job conditions, CronJob active-jobs list, StatefulSet
volumeClaimTemplates — in Tailwind utilities with token arbitrary values
(e.g. `bg-[var(--surface-sunken)]`), not new `style={{}}` raw hex. Do not
introduce new `index.css` component-class systems.

## Data flow

- `WorkloadsPanel` already tracks expand state and passes `isOpen` /
  `toggleExpand` to rows. Rows gain `expandedContent`.
- `WorkloadDetail` reads container/spec data directly from the workload object in
  the Zustand store (already present).
- `RelatedResources` manages its own ref-counted `subscribe`/`unsubscribe` for
  related kinds; no extra subscription plumbing needed in `WorkloadDetail`.
- No REST or server changes.

## Error handling / edge cases

- Missing `spec`/`status` → helpers return `—` / `0` (existing pattern).
- Suspended Job/CronJob → surfaced as a field/badge.
- Mid-stream objects without a pod template → guard, render what's available.
- Empty related groups → `RelatedResources` already renders "No related resources."

## Testing

- **Display helpers** (vitest, `workloads/workloads.test.ts` or a sibling): new
  helpers — container summaries from a pod-template spec, volumeClaimTemplates
  parse, job conditions extraction, cronjob active-jobs/concurrency/history.
- **relatedResources** (`src/lib/relatedResources.test.ts`): `relatedKindsFor`
  and `computeRelated` for the new `job` and `cronjob` source kinds.
- **Row smoke tests:** each `*Row` now renders `WorkloadDetail` when `isOpen`;
  render each kind against a fixture without crashing.
- **Regression:** `DeploymentDetail` still renders identically after the
  container-card / `Field` extraction.
- Gates: `pnpm --filter web typecheck`, `pnpm --filter web test`,
  `pnpm --filter web build`.

## Files touched

New:
- `apps/web/src/panels/workloads/WorkloadDetail.tsx`
- `apps/web/src/panels/components/ContainerCards.tsx` (extracted)
- `apps/web/src/panels/components/Field.tsx` (extracted; or a field-grid module)

Modified:
- `apps/web/src/panels/workloads/StatefulSetRow.tsx` (+ DaemonSet/Job/CronJob rows)
- `apps/web/src/panels/workloads/types.ts`
- `apps/web/src/panels/workloads/workloadsDisplay.ts` (new helpers)
- `apps/web/src/panels/deployments/DeploymentDetail.tsx` (consume extracted pieces)
- `apps/web/src/panels/deployments/deploymentDisplay.ts` (generalize `containerSummaries`)
- `apps/web/src/lib/relatedResources.ts` (job + cronjob cases)
- tests noted above
