# Recent deployments / Undo (rollback a Rigel apply) — HELM-60

## Problem

After applying something through Rigel (a Compose migration, a catalog manifest
install, or a raw Apply YAML), users want an easy "undo" the thing they just did.
Today the only cleanup is Purge, which is discovery-driven ("remove app X by
name"). Recent deployments / Undo is a different mental model: a time-ordered log
of what YOU applied through Rigel, each entry one-click undoable within a recent
window.

- **Purge** = "I know I have app X, remove it" (find + delete by name/label).
- **Recent deployments / Undo** = "roll back that thing I just did" (delete
  exactly the resources a specific apply created).

Kubernetes has no native "what did I recently apply" log — events age out in ~1h
and the API server records no apply batches. Rigel must record it itself.

## Decisions (from brainstorm)

- **Recording model: stamp the cluster with annotations** (not a local log, not a
  hybrid). Durable, multi-machine, self-describing; reuses the existing
  `rigel.dev/*` annotation convention. The cluster is the single source of truth.
- **Sources in v1: manifest applies only** — everything that flows through
  `POST /api/apply` (`kubectl apply -f -`): the Compose migration, the Apply YAML
  panel, and catalog manifest-mode installs. Helm installs (separate path, already
  uninstallable) and per-resource action-block edits are out of scope.
- **UI home: an Overview card only** — no dedicated panel/route in v1.
- **Undo covers CREATIONS only.** Reverting in-place edits (a batch that patched a
  pre-existing resource) is explicitly out of scope.

## Architecture

The feature is, structurally, "Purge but discovered by an apply-batch annotation
instead of by an instance label." It reuses the discover → confirm → delete
machinery almost wholesale.

### 1. Annotation constants (shared)

Add to `packages/catalog/src/types.ts`, following the established
`CATALOG_APP_ANNOTATION` / `boundAppID` pattern (one exported constant per key,
one single-reader helper), and re-export from `packages/catalog/src/index.ts`:

| Key                      | Meaning                                                    |
|--------------------------|------------------------------------------------------------|
| `rigel.dev/apply-batch`  | Batch id — server-generated `crypto.randomUUID()`.         |
| `rigel.dev/applied-at`   | ISO 8601 timestamp of the apply.                           |
| `rigel.dev/apply-source` | `compose-migration` \| `catalog-install` \| `apply-yaml`.  |

A single reader helper (e.g. `applyBatchOf(meta)`) returns the batch id or null,
mirroring `boundAppID`.

### 2. Stamping — apply, then annotate only what was created

Lives inside `applyManifest()` in `apps/server/src/install.ts`.

`kubectl apply` is create-or-update. Injecting annotations into the YAML before
applying would stamp pre-existing resources that the apply merely patched — and
Undo would then delete a resource this batch never created. That is the core
foot-gun and it is avoided as follows:

1. Apply the YAML **unchanged** (as today) via `kubectl apply -f -`.
2. Parse the apply's stdout. Each line has the form
   `<resource>.<group>/<name> <action>` where `<action>` is `created`,
   `configured`, or `unchanged`. Collect only the lines ending in `created`.
3. If one or more resources were created, generate a batch id + ISO timestamp and
   run `kubectl annotate` on exactly those created resources, setting the three
   annotations above. Group the annotate call(s) by namespace; cluster-scoped
   resources are annotated without `-n`.

Consequences:
- Resources that were `configured`/`unchanged` (pre-existing) are never stamped
  and are therefore never undoable. Undo can only ever delete things this apply
  brought into existence.
- This matches the existing convention that every `rigel.dev/*` annotation is set
  via post-hoc `kubectl annotate`, never injected into a manifest.
- Costs one extra `kubectl annotate` per apply that creates anything. An apply
  that creates nothing records no batch (correct — nothing to undo).

Stamping is gated off when `dryRun` is true and when no `source` is supplied.

`POST /api/apply` gains an optional `source` field (`compose-migration` |
`catalog-install` | `apply-yaml`). Each client caller passes the value for its
panel:
- `apps/web/src/panels/compose/ComposeMigratePanel.tsx` → `compose-migration`
- `apps/web/src/panels/apply/ApplyYamlPanel.tsx` → `apply-yaml`
- `apps/web/src/panels/catalog/*` manifest-mode install → `catalog-install`

The apply response returns the batch id (or null) and the created resource list so
the UI can reflect the freshly-created batch immediately.

No new stamping endpoint is added.

### 3. Recent deployments query (discovery)

Annotations cannot be selected with `kubectl -l`, so a purge-style one-shot
discovery is used (`packages/k8s/src/purge.ts` + `apps/server/src/purge.ts` are
the template):

- New pure logic (mirroring purge's `discoveryArgs` / `filterDiscovered`) that
  builds `kubectl get <DISCOVERY_KINDS> --all-namespaces -o json` (reusing purge's
  existing `DISCOVERY_KINDS` set) and, from the JSON, filters to resources that
  carry `rigel.dev/apply-batch` with an `applied-at` inside a **14-day window**,
  then groups them by batch id.
- New server route (e.g. `GET /api/deployments/recent`) that runs the query and
  returns an array of batches:
  `{ batchId, source, appliedAt, namespaces[], resources: [{ kind, name, namespace }] }`,
  newest first.
- Old batches simply fall out of the 14-day window. No annotation pruning is
  required (annotations are tiny and harmless); the window is the only retention
  mechanism.

### 4. Undo (delete)

Undo deletes every resource carrying a given `apply-batch` id:

- The batch's resource list comes from the discovery result (the cluster is the
  source of truth; no stored YAML blob).
- Deletion reuses purge's per-resource `deleteArgs(kind, name, namespace)` →
  `kubectl delete <kind> <name> -n <ns>`. Deleting an owning resource (Deployment)
  cascades its pods; separately-created PVCs/Secrets/etc. carry their own batch id
  and are deleted in the same pass.
- The flow is routed through the existing red destructive `ConfirmSheet`
  (`isDestructiveAction`), consistent with all other Rigel mutations. Undo can run
  through a purge-style execute route or a small dedicated one; it must re-verify
  the resource set at execute time (resources may have been deleted since the list
  was fetched — `kubectl delete` is tolerant of not-found).

### 5. UI — Overview card

A "Recent" card added to `apps/web/src/panels/overview/OverviewPanel.tsx`, wired
like the existing Purge flow (local `useState`, sheet mounted at the bottom of the
panel). Each row renders:

`2h ago · Compose migration · 10 resources · namespace default`   **[ Undo ]**

showing recent batches (newest first) within the 14-day window. The Undo button
opens the ConfirmSheet. Empty state when there are no recent batches.

Pixel-level design is produced in Pencil per the standard workflow before
implementation of the card; this spec fixes behavior and data only.

## Out of scope (v1 / follow-ups)

- Reverting in-place EDITS (a batch that modified a pre-existing resource) — needs
  the prior manifest stored (stash previous version, or lean on
  `kubectl.kubernetes.io/last-applied`).
- Helm / catalog-helm installs (undo would route to `helm uninstall`, a separate
  semantics).
- Per-resource action-block mutations (scale / setImage / setEnv / edit).
- A dedicated Recent/Activity panel or nav route (Overview card only for now).
- Active pruning of old annotations.

## Testing

- **Stamping (`install.ts`):** unit-test the stdout parser (created vs configured
  vs unchanged; grouped vs cluster-scoped; multi-namespace) and the resulting
  `kubectl annotate` argv, following the existing `install.test.ts` /
  `actions.test.ts` argv-assertion style. No live cluster.
- **Discovery (`packages/k8s`):** unit-test the query argv and the JSON →
  grouped-batches filter (window boundary, grouping by batch id, resource shaping),
  mirroring `purge.ts` tests.
- **Undo:** unit-test the per-resource delete argv reuse.
- **Client:** typecheck + vitest for the api helpers and the Overview card
  (rendering rows, empty state, Undo → ConfirmSheet). Verify via
  `pnpm --filter web typecheck/test/build` and `pnpm --filter @rigel/server test`;
  no dev server, no live mutation endpoints hit.

## Docs / tickets

Per the standing workflow: update the app's Outline docs for this feature and
derive/track the corresponding Plane tickets from HELM-60 as implementation lands.
