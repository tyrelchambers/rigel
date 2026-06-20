# Helm management: Releases manager + custom-chart install

Date: 2026-06-20
Status: Approved design, ready for implementation plan

## Summary

Add a **Helm** tab to Rigel with two sub-views:

1. **Releases** — manage every Helm release in the cluster regardless of how it
   was installed, with revision history, values, rendered manifest, and the
   rollback / upgrade / uninstall lifecycle actions.
2. **Install chart** — deploy a chart that is not in the curated Apps catalog,
   accepting four ways to point at a chart (repo URL + chart, OCI reference,
   Artifact Hub search, local `.tgz` or chart folder), plus a values editor.

A second, smaller piece of work ships alongside it: a single shared
segmented-rail tab component, applied to the `TabModal` header, the new Helm
sub-tabs, and the catalog's All / Installed scope control, so the three look
identical and cannot drift.

## Motivation

Rigel already matches or beats Lens across most of its surface. The clearest
remaining Lens parity gap is Helm. Today:

- The Apps catalog can install curated charts (`install.mode: "helm"` runs a real
  `helm repo add` then `repo update` then `upgrade --install` via
  `apps/server/src/install.ts`), but it is install-time only. After install it
  offers no revision history, no rollback, no in-place upgrade, and no view of
  the release's values or manifest. The update badge flags newer versions and
  purge-an-app can `helm uninstall`, and that is the full extent of post-install
  lifecycle.
- The catalog is blind to any release it did not install (Helm CLI, Argo CD,
  Flux, a chart applied by hand).
- There is no way to install an arbitrary chart the user chooses. The helm
  executor only ever runs from a baked catalog `InstallDescriptor`, and it is
  repo-based: it cannot take an OCI reference, a local `.tgz`, or a chart folder.

The Releases manager closes the lifecycle gap; the custom-chart install opens the
"deploy anything" door. The curated Apps catalog is unchanged and remains the
opinionated, secret-aware path.

## Non-goals

- No change to the curated Apps catalog install flow or its catalog entries.
- No multi-cluster support (consistent with the product's single-cluster scope).
- No Helm repository manager UI (a place to persist a named list of repos). Repo
  URLs are entered or come from Artifact Hub at install time. `helm repo add` is
  still run under the hood, but we do not surface a repo CRUD screen.
- No support for Helm v2 release storage (ConfigMap driver). v3 Secret storage
  only, which is the default and what the cluster uses.

## Architecture

The work follows the existing app conventions (`apps/CLAUDE.md`):

- **Reads ride the WebSocket.** Release data is derived from the Helm release
  Secrets that the server already watches. Panels read the live list from the
  Zustand store, not from polling queries.
- **Mutations ride guarded REST.** Install, upgrade, rollback, and uninstall
  shell out to the real `helm` binary through new REST routes, each fronted by
  the standard confirm Sheet that shows the exact `helm` command before it runs.
  This matches how the catalog install and every other mutation already work, and
  is consistent with the chat command policy that auto-denies
  `helm install/upgrade/uninstall/rollback` on the Bash path so they must go
  through the sanctioned executor.

### Reading releases: decode the release Secrets

Helm v3 stores each release revision as a Secret in the release's namespace,
named `sh.helm.release.v1.<release>.v<revision>`, with `type:
helm.sh/release.v1` and labels `owner=helm`, `name`, `version`, `status`. We
already watch Secrets over the WebSocket and already detect these in `purge.ts`
(`helmReleaseFromSecretName`).

The Secret's `data.release` value decodes as follows:

1. base64 decode (the standard Kubernetes Secret encoding) to get a string.
2. That string is itself base64 of gzip of JSON. base64 decode it to bytes.
3. If the bytes start with the gzip magic `0x1f 0x8b`, gunzip them; otherwise use
   them as-is. (Handling the rare ungzipped case is decode correctness, not a
   product fallback.)
4. `JSON.parse` the result to get the release object.

The release object yields everything the UI needs without shelling to `helm`:

- `name`, `namespace`, `version` (revision number).
- `info`: `status`, `first_deployed`, `last_deployed`, `description`, `notes`.
- `chart.metadata`: `name`, `version`, `appVersion`. `chart.values`: the chart
  default values.
- `config`: the user-supplied values for this revision.
- `manifest`: the rendered manifest for this revision.

Because every revision is its own Secret, the full **history** is available by
grouping the `sh.helm.release.v1.<release>.v*` Secrets by release. The current
revision is the one whose `status` is `deployed` (fall back to the highest
revision number if none is marked deployed).

This logic lives in a new pure module `packages/k8s/src/helm.ts`, unit-tested
against captured Secret payloads the way `assistant.ts` and `purge.ts` are
tested. It exposes:

- `decodeReleaseSecret(secretData: string): HelmReleasePayload | null`
- `groupReleases(secrets: ReleaseSecret[]): HelmRelease[]` where `HelmRelease`
  carries the latest revision plus the ordered revision list.
- Argv builders `buildHelmRollbackArgs` and `buildHelmUpgradeArgs` that sit next
  to the existing `buildHelmArgs` in `apps/server/src/install.ts` so all helm
  argv construction lives together. Uninstall reuses the existing
  `helmUninstallArgs` from `purge.ts` rather than adding a new builder.

### Mutations and server routes

New REST routes in `apps/server/src/`:

- `POST /api/helm/install` — extend the existing `installHelm`. Today it handles
  repo mode. Add OCI mode (skip `repo add`, install the `oci://` ref directly)
  and local-path mode (install from a `.tgz` or folder path). Same
  `helm upgrade --install` with a temp values file at the end. The request gains
  a `source` discriminator: `{ kind: "repo", repoName, repoURL, chart, version }`
  or `{ kind: "oci", ref, version }` or `{ kind: "local", path }`, plus the
  shared `releaseName`, `namespace`, `values`.
- `POST /api/helm/upgrade` — `helm upgrade <name> <chartref> -n <ns> -f values`.
  Needs a chart reference. Prefilled when we know the source (anything installed
  through Rigel); for a release whose source we cannot determine, the upgrade
  form falls back to a values-only redeploy using the existing chart and says so
  in the UI.
- `POST /api/helm/rollback` — `helm rollback <name> <revision> -n <ns>`. Always
  available, needs no chart reference.
- `POST /api/helm/uninstall` — `helm uninstall <name> -n <ns>`.

Every route is reached only through the confirm Sheet, which renders the exact
argv before running. Reads do not get routes; they come from the WS Secret watch
plus the decode layer feeding the store.

### Artifact Hub client

A thin typed server client (`apps/server/src/artifactHub.ts`) calls the public
Artifact Hub search API so there is no browser CORS issue:

`GET https://artifacthub.io/api/v1/packages/search?kind=0&ts_query_web=<q>&limit=20`

`kind=0` is Helm charts. Each result carries `name`, `version`, and
`repository: { name, url, kind }`. When the user picks a result, the install form
is prefilled: an `oci://` repository URL becomes an OCI-mode install; an HTTP
repository URL becomes a repo-mode install (repo name + URL + chart name). The
client has a parsing test against a captured response. This is a network read, so
it is exposed as `GET /api/helm/search?q=` rather than the WS.

## UI

### The Helm tab

A new entry in `PANEL_META` (`apps/web/src/shell/NavStrip.tsx`) and a route under
`apps/web/src/panels/helm/`. The panel hosts the shared segmented-rail tabs with
two sub-views: **Releases** and **Install chart**.

### Releases sub-view

- **List**: every release, optionally filtered by the shared namespace bar. Each
  row shows name, namespace, current revision, chart version + app version,
  status, and last updated. Fed live from the store.
- **Detail**: the revision history (one entry per revision Secret) with status,
  chart version, app version, updated time, and description. Selecting a revision
  shows its rendered manifest and its values (read-only, reusing the code/YAML
  viewer the app already uses for Apply YAML and ConfigMap viewing).
- **Actions** (each through the confirm Sheet): Rollback to a chosen revision,
  Upgrade (opens the values editor and optional version change), Uninstall.

### Install chart sub-view

A single flow with a source picker offering four inputs:

1. **Repo URL + chart** (+ optional version). Repo mode, reuses today's executor.
2. **OCI reference** (`oci://...`). OCI mode.
3. **Artifact Hub search**. A search box backed by `/api/helm/search`; selecting
   a result prefills input 1 or 2.
4. **Local `.tgz` or chart folder**. An Electron file dialog picks a path; because
   the server runs on the same machine as the desktop app, the path is passed
   straight to `helm install`.

After the chart is chosen, a **values editor** (reusing the Apply YAML code
editor) is seeded with the chart's default values via `helm show values <chart>`,
plus fields for release name and namespace. Apply runs the guarded
`helm upgrade --install`.

### Shared segmented-rail tab component

A new `apps/web/src/components/ui/SegmentedTabs.tsx` (or similar) renders a rail
track with rounded tabs, used in three places: the `TabModal` header
(`components/ui/modal.tsx`), the Helm sub-tabs, and the catalog All / Installed
scope control (`CatalogPanel.tsx`, replacing `.catalog-scope-control`). The
catalog category pill rail is intentionally left as-is; it is a filter, not tabs.

Styling (subtle, per the brand):

- **Rail track**: `inline-flex`, `border-radius: 10px` (rounded-lg), a slightly
  lighter gray background using a faint white overlay over the surface
  (`rgba(255,255,255,0.04)`), about 3px of inner padding, ~3px gap between tabs.
  No hard border, no internal dividers.
- **Tab button**: `border-radius: 7px` (rounded-md), padding ~6px 12px, font-size
  13. Inactive uses the muted gray (`var(--fg-tertiary)` / `#6B6B73`) and
  brightens toward `--fg-secondary` on hover with a `rgba(255,255,255,0.03)`
  hover fill. Active gets white text (`--fg-primary`) on a faint filled pill
  (`rgba(255,255,255,0.08)`).
- Optional trailing count badge slot (the catalog's Installed count reuses it).

Updating `TabModal` to use this component is intentional: it makes the "branded
modal" the canonical example of the look rather than the current near-miss.

## Testing

- `packages/k8s/src/helm.test.ts`: decode of a captured gzipped release Secret
  (and an ungzipped one), `groupReleases` ordering and current-revision
  selection, and the rollback / upgrade / uninstall argv builders.
- `apps/server/src/install.test.ts` (extended): `buildHelmArgs` for the new OCI
  and local-path source modes.
- `apps/server/src/artifactHub.test.ts`: parse a captured search response into the
  prefill shape (repo vs OCI).
- Web: `wizardLogic`-style pure tests for the install-form source state and for
  the upgrade prefill (known source vs values-only fallback). Component smoke
  tests are out of scope, matching the existing panels.

## Files touched or created

Created:

- `packages/k8s/src/helm.ts`, `packages/k8s/src/helm.test.ts`
- `apps/server/src/artifactHub.ts`, `apps/server/src/artifactHub.test.ts`
- `apps/web/src/panels/helm/` (panel, Releases view, Install view, detail)
- `apps/web/src/components/ui/SegmentedTabs.tsx`

Modified:

- `apps/server/src/install.ts` (OCI + local-path modes; rollback/upgrade argv),
  `apps/server/src/index.ts` (new routes)
- `apps/web/src/shell/NavStrip.tsx` (Helm tab in `PANEL_META` + route)
- `apps/web/src/components/ui/modal.tsx` (`TabModal` uses `SegmentedTabs`)
- `apps/web/src/panels/catalog/CatalogPanel.tsx` (scope control uses
  `SegmentedTabs`); remove the now-unused `.catalog-scope-control` CSS

## Risks and notes

- **Upgrade needs a chart reference.** Helm does not store the source repo in the
  release, only the resolved chart contents. For releases Rigel did not install
  we cannot always reconstruct the repo, so upgrade degrades to a values-only
  redeploy of the existing chart and the UI states this. Rollback is unaffected.
- **Bitnami default repo.** Lens ships Bitnami as a default chart repo. As of late
  2025 the Bitnami free catalog is gutted (charts remain at
  `docker.io/bitnamicharts` but receive no updates and will not deploy without
  image overrides; the maintained set is behind a Broadcom subscription). We do
  not ship Bitnami as a default. Discovery is Artifact Hub plus user-entered
  repos and OCI refs.
- **Release payload size.** Watching all release Secrets pulls their full
  payloads (manifest + values) into the store. If this proves heavy, the decode
  can be narrowed to metadata for the list and the full manifest/values fetched
  per-release on detail open. Start with full decode; revisit only if needed.
