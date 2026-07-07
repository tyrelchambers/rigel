# Recent deployments / Undo (rollback a Rigel apply) — HELM-60

## Problem

After applying something through Rigel (a Compose migration, a catalog manifest
install, or a raw Apply YAML), users want an easy "undo" of the thing they just
did. Today the only cleanup is Purge, which is discovery-driven ("remove app X by
name"). Recent deployments / Undo is a different mental model: a time-ordered log
of what YOU applied through Rigel, each entry one-click undoable within a recent
window.

- **Purge** = "I know I have app X, remove it" (find + delete by name/label).
- **Recent deployments / Undo** = "roll back that thing I just did" (delete
  exactly the resources a specific apply created).

Kubernetes has no native "what did I recently apply" log — events age out in ~1h
and the API server records no apply batches. Rigel must record it itself.

## Decisions (from brainstorm)

- **Recording model: an in-cluster batch ledger (Helm-style).** Each apply writes
  ONE ConfigMap recording the batch (id, timestamp, source) and the exact list of
  resources it created. This is how Helm itself tracks releases (release state in
  in-cluster objects). Chosen over per-resource annotations and over a local log
  because it is the most robust: a single write per apply (no partial-stamp
  failure across N resources), immune to GitOps drift on the workload resources,
  durable and visible across machines/reinstalls, cheap and precise to query
  (label-selected), and it stores the created-list directly so Undo is exact. It
  also gives raw manifest applies the same "release history + rollback" that Helm
  gives Helm installs.
- **Sources in v1: manifest applies only** — everything that flows through
  `POST /api/apply` (`kubectl apply -f -`): the Compose migration, the Apply YAML
  panel, and catalog manifest-mode installs. Helm installs (separate path, already
  uninstallable via `helm uninstall`) and per-resource action-block edits are out
  of scope.
- **UI home: an Overview card only** — no dedicated panel/route in v1.
- **Undo covers CREATIONS only.** Reverting in-place edits (a batch that patched a
  pre-existing resource) is out of scope for v1, but the ledger design leaves room
  to store the prior manifest later to enable it.

## Architecture

Structurally this is "Purge, but the resource list comes from a ledger object
instead of a label query, and it is written at apply time." Undo deletes each
recorded resource by its own kind via `kubectl delete`, independent of purge's
fixed kind list.

### 1. The ledger object

One ConfigMap per apply batch, **co-located with the batch's resources**: stored
in the batch's target namespace when the created resources all share one namespace
(the common case — compose migration, catalog install, single-namespace apply),
and in `default` only as a fallback when a batch spans multiple namespaces (or
none). Co-location means deleting a namespace also cleans up its ledgers (no
orphan records). The ConfigMap is a data record, not a native reference, so undo
reading a ledger in one namespace and deleting resources in another is fine —
`kubectl get`/`delete` are not namespace-bound; the co-location is for lifecycle,
not for reference validity.

- **Name:** `rigel-apply-<batchId>` where `batchId` is a `crypto.randomUUID()`
  (a valid DNS-1123 subdomain, so a valid ConfigMap name).
- **Label:** `rigel.dev/ledger: apply-batch` — the only thing discovery selects on.
- **Data:** a single key `batch.json` holding
  `{ batchId, appliedAt (ISO 8601), source, resources: [{ kind, name, namespace }] }`.
- The ledger's own namespace is read back during discovery (from the ConfigMap's
  `metadata.namespace`) and carried on each batch, so Undo targets the right
  namespace unambiguously.

Constants (`rigel.dev/ledger` key + `apply-batch` value, the name prefix, the data
key) and the `ApplySource` type live in `packages/k8s/src/applyBatch.ts`, following
the one-constant-plus-single-reader convention of `CATALOG_APP_ANNOTATION` /
`boundAppID`. (They live in `packages/k8s`, not `packages/catalog`: they are not
catalog-specific and both the server recorder and the k8s discovery logic sit at
or below the k8s layer; neither `packages/k8s` nor `apps/server` depends on
`@rigel/catalog`.)

A ConfigMap's ~1 MiB data budget is far larger than a resource list needs; storing
the full prior manifest for edit-revert remains a future option.

### 2. Recording at apply time

Lives inside `applyManifest()` in `apps/server/src/install.ts`, gated off when
`dryRun` is true and when no valid `source` is supplied.

1. Apply the YAML **unchanged** via `kubectl apply -f -` (as today).
2. Parse the apply's stdout, keeping only the lines ending in `created`. Each line
   is `<resource>.<group>/<name> <action>`; the kind is the token before the first
   `.`/`/`. Resolve each created resource's namespace from the applied manifest
   (parsed from the same YAML); a resource whose manifest omitted a namespace is
   recorded as `default`.
3. If anything was created, choose the ledger namespace — the single distinct
   namespace of the created resources, or `default` when they span multiple (or
   none) — generate a batch id + ISO timestamp, and write the ledger ConfigMap
   with `kubectl apply -f -` (idempotent). Recording is **best-effort**: a failed
   ledger write does not fail the apply (the resources still exist; the batch is
   simply not in Recent).

Because only `created` resources are recorded, Undo can never delete a resource
the apply merely patched. Resources that were `configured`/`unchanged`
(pre-existing) never enter a ledger.

`POST /api/apply` gains an optional `source` field (`compose-migration` |
`catalog-install` | `apply-yaml`); each client caller passes the value for its
panel:
- `apps/web/src/panels/compose/ComposeMigratePanel.tsx` → `compose-migration`
- `apps/web/src/panels/apply/ApplyYamlPanel.tsx` → `apply-yaml`
- `apps/web/src/panels/catalog/*` manifest-mode install → `catalog-install`

The apply response returns the batch id (or null). No new recording endpoint is
added.

### 3. Recent deployments query

- New server route `GET /api/deployments/recent` runs
  `kubectl get configmap --all-namespaces -l rigel.dev/ledger=apply-batch -o json`,
  which returns ONLY ledger objects across all namespaces (still cheap — label
  selected, no cluster-wide scan of workload kinds).
- Pure logic (`packages/k8s`) parses each ledger's `batch.json`, records the
  ledger's own `metadata.namespace`, keeps batches whose `appliedAt` is within a
  **14-day window**, and returns them newest-first.
- Old batches fall out of the window in the list. Their ledger ConfigMaps are
  pruned lazily on Undo (below); an occasional GC of expired ledgers is a possible
  follow-up but not required for v1.

### 4. Undo (delete)

`POST /api/deployments/undo` with body `{ batchId, namespace }` (the ledger's own
namespace, carried from discovery):

1. Re-read the ledger ConfigMap `rigel-apply-<batchId>` in `namespace` (the ledger
   is the authoritative resource list — the client's copy could be stale).
2. Delete each recorded resource with `kubectl delete <kind> <name> -n <ns>
   --ignore-not-found`, using the recorded kind directly (any kind, including
   CRDs — not gated to a fixed kind list). `--ignore-not-found` makes a
   since-deleted resource a safe no-op. Deleting an owning resource cascades its
   pods; separately-created PVCs/Secrets are in the same recorded list and deleted
   in the same pass.
3. Delete the ledger ConfigMap **only when every resource delete succeeded** — on
   a partial failure the ledger is kept so the batch stays in Recent for a safe
   retry (retry re-attempts deletes; `--ignore-not-found` no-ops the already-gone).
   On full success the ledger is removed so the batch disappears from Recent.
4. Return per-resource results.

The flow is routed through the existing red destructive confirmation, consistent
with all other Rigel mutations.

### 5. UI — Overview card

A "Recent" card added to `apps/web/src/panels/overview/OverviewPanel.tsx`, wired
like the existing Purge flow (local state, sheet/dialog mounted in the panel). Each
row renders:

`2h ago · Compose migration · 10 resources · namespace default`   **[ Undo ]**

showing recent batches (newest first) within the 14-day window, with an empty
state. The Undo button opens the destructive confirmation and calls the undo route
with the batch id. Pixel-level design is produced in Pencil per the standard
workflow before the card is built; this spec fixes behavior and data only.

## Out of scope (v1 / follow-ups)

- Reverting in-place EDITS — the ledger can later store the prior manifest to
  enable a real revert.
- Helm / catalog-helm installs (undo would route to `helm uninstall`).
- Per-resource action-block mutations (scale / setImage / setEnv / edit).
- A dedicated Recent/Activity panel or nav route (Overview card only for now).
- Active GC of expired ledger ConfigMaps (lazy prune on Undo is enough for v1).

## Testing

- **Recording (`install.ts`):** unit-test the stdout parser (created vs configured
  vs unchanged), the created→namespace resolution, and the resulting ledger
  ConfigMap manifest, with injected runners (no live cluster), following the
  `install.test.ts` / `actions.test.ts` argv-assertion style.
- **Discovery (`packages/k8s`):** unit-test the query argv and the ledger-JSON →
  windowed, newest-first batches parsing.
- **Undo:** unit-test that it reads the ledger, builds the per-resource delete argv
  (with `--ignore-not-found`), and deletes the ledger CM.
- **Client:** typecheck + vitest for the api helpers and the Overview card
  (rendering rows, empty state, Undo → confirm → undo route). Verify via
  `pnpm --filter web typecheck/test/build` and `pnpm --filter @rigel/server test`;
  no dev server, no live mutation endpoints hit.

## Docs / tickets

Per the standing workflow: update the app's Outline docs for this feature and
derive/track the corresponding Plane tickets from HELM-60 as implementation lands.
