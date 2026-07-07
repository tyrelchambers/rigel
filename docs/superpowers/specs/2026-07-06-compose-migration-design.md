# Docker Compose to Kubernetes migration assistant

Plane: HELM-57
Status: Design approved, deterministic-only (no AI)
Date: 2026-07-06

## Problem

Rigel's target users (solo devs, homelabbers, small teams) almost all arrive from Docker Compose. Converting a compose file into working Kubernetes manifests is the most painful moment of K8s adoption, and no tool does it well. This is Rigel's best top-of-funnel feature: it captures users at the exact moment they leave Compose and feeds them straight into the existing catalog and apply pipeline.

## Goal

A user pastes or uploads a `docker-compose.yml` and gets a reviewable set of working Kubernetes manifests they can apply to the active cluster in one flow. The conversion is fully deterministic: no AI, no network dependency, works on a cold-start cluster during onboarding.

## Non-goals (first cut)

- AI enrichment of any kind. If a mapping cannot be done deterministically, it becomes a visible warning, not an AI guess.
- Swapping a matched service for the curated catalog install (that is a hint only in v1; see Catalog hints). The actual swap is a follow-up.
- Multi-file compose, `include`, profiles, `extends`, anchors beyond what a standard parser resolves.
- Round-tripping edits back to compose.
- Private registry auth translation.
- Auto-generating Ingress or NodePort for published ports (see Ports).

## Architecture

Four units, each with one job.

### 1. `packages/compose` (new) — conversion engine

Pure functions, zero cluster or network calls, fully unit-testable in isolation.

- Input: a raw compose YAML string.
- Output: a `ConversionResult`:
  ```
  ConversionResult {
    manifests: ManifestDoc[]      // { kind, name, yaml } per emitted resource
    warnings: Warning[]           // { severity, service?, message, directive? }
    catalogHints: CatalogHint[]   // { service, appId, appName }
  }
  ```
- Internally: parse compose with the `yaml` package into a typed model, build a JS object per Kubernetes resource, then serialize each with `yaml` at the end. Objects (not hand-written template strings) because compose structure varies widely. This diverges from the string-template builders elsewhere in `packages/k8s` on purpose; it is the right tool for variable-shaped output.
- Depends on: the `yaml` package (eemeli/yaml). Note: this is the monorepo's first YAML-library dependency; the rest of the repo hand-rolls simple line-based YAML handling (e.g. `listResources`), but real compose parsing (anchors, nesting, quoting) warrants a real parser. Also depends on `packages/catalog` for image matching (see Catalog hints).

### 2. `apps/web/src/panels/compose/ComposeMigratePanel.tsx` (new) — Tools panel

The always-available entry point, alongside Apply YAML / GitOps in the Tools nav group.

- Registration: add a `PANEL_META` record (`compose` -> `/compose`, an appropriate icon) and add `"compose"` to the `NAV_GROUPS` "Tools" group in `apps/web/src/shell/NavStrip.tsx`; add a `<Route path="/compose">` in `apps/web/src/App.tsx`; header via the shared `PanelHeader`.
- Layout: left pane is the source compose input (paste, type, upload, drag-drop). Right pane is the generated manifests in the same schema-aware Monaco editor ApplyYamlPanel uses (`useClusterYamlSchema`), editable before apply. Below or beside: the warnings list and catalog hints.
- Namespace target: the shared NamespaceBar dropdown (no free-text).
- Apply: builds the multi-doc manifest from the (possibly edited) right pane and sets a `pendingAction` of `{ kind: "applyManifest", label: "Apply migrated manifests", manifest }`, handed to the existing `<ConfirmSheet>`. No new apply path.

### 3. Onboarding entry

A card on the first-run / empty-cluster state ("Coming from Docker Compose? Import your stack.") that routes to `/compose`. No separate engine, just an entry point into the same panel.

### 4. Apply and confirm (reused, unchanged)

- Apply goes through `applyManifest` -> `POST /api/apply` (YAML piped over stdin, `apps/server/src/install.ts`), non-dry-run on confirm, dry-run for a "Validate" button (`--dry-run=server`), exactly like ApplyYamlPanel.
- The confirm step renders its resource summary via the existing `listResources(manifest)` from `packages/catalog`.

## Conversion mapping (deterministic)

Per compose service, in one pass:

| Compose | Kubernetes | Notes |
|---|---|---|
| `service` (image) | Deployment | one Deployment per service |
| `service` + named `volume` | Deployment + PVC (RWO) + volumeMount | Default is Deployment + PVC, not StatefulSet. Matches how homelab single-replica stateful apps run. A StatefulSet is recommended via a warning only when the service also requests multiple replicas. |
| `ports: "8080:80"` | ClusterIP Service | Always ClusterIP. A published (host-side) port emits a non-blocking warning pointing at the Ingress editor rather than guessing NodePort or Ingress, because host and ingress class are unknown. |
| `expose` | ClusterIP Service port | internal only, no warning |
| `environment` / `env_file` | container env vars inline | plain values inline |
| `environment` values matching a secret heuristic (`*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*_KEY`, `*APIKEY*`, case-insensitive) | flagged, offered as a Secret + `secretKeyRef` | heuristic warning; user confirms in the review UI |
| `depends_on` | ordering warning only | K8s has no ordering primitive; surface it |
| `restart` | omitted (Deployment restartPolicy is always Always) | note only if value is `no` |
| `deploy.resources` limits/reservations | requests/limits | mapped when present |
| `command` | container `args` (or `command` when it replaces entrypoint) | follow the catalog command/args trap: prefer `args` |
| `container_name` | ignored (name derives from service key) | K8s names come from the service key, sanitized to RFC 1123 |
| host bind mount (`./x:/y`), `network_mode: host`, `privileged`, `devices`, `cap_add`, `pid`, `userns_mode` | not translated, explicit warning | surfaced per service, never silently dropped |

Rules:
- Every unmapped or lossy directive produces a `Warning`. Nothing is dropped silently.
- Resource names are sanitized to RFC 1123 (lowercase, dashes) and collisions are disambiguated deterministically.
- Emission order is stable, so output is diffable and golden-testable.
- Namespace: `/api/apply` runs `kubectl apply -f -` with no `-n`, so the namespace must live in the manifests. The engine takes the target namespace as an argument and stamps `metadata.namespace` on every namespaced resource it emits. The panel supplies it from the NamespaceBar dropdown selection.

## Catalog hints (deterministic, hint-only in v1)

For each service image, reuse `repoPathsMatch` / `matchImages` from `packages/catalog/src/detection.ts` to detect a known catalog app. When matched, emit a `CatalogHint` rendered as a non-blocking note in the review UI: "service `db` looks like PostgreSQL, the catalog has a hardened version," linking to the catalog entry. The generated raw manifests are still emitted for every service. Swapping in the curated install is out of scope for v1 (follow-up).

## Error handling

- Invalid or unparseable compose YAML: the panel shows a parse error inline (no partial apply), same posture as an invalid Apply YAML input.
- Empty compose or zero services: a clear empty result message, no manifests.
- Unsupported top-level compose keys (`configs`, `secrets` top-level, `networks` with custom drivers): a single informational warning that they were ignored.
- Apply-time failures surface through the existing ConfirmSheet / `/api/apply` error path unchanged.

## Testing

`packages/compose` carries the bulk of the coverage:

- Unit tests over the mapping table: service to Deployment, named volume to Deployment + PVC + mount, env inline, secret-env heuristic to Secret + `secretKeyRef`, ports to ClusterIP Service, `expose`, each unmapped-directive warning (host mount, host networking, privileged, devices, cap_add), `depends_on` ordering warning, command to args.
- Name sanitization and collision-disambiguation tests.
- A golden end-to-end fixture: web + postgres + redis + a named volume + env, asserting the emitted multi-doc manifest is valid and apply-ready and that expected warnings and catalog hints are produced.
- Parse-error and empty-input tests.

Web panel: a light test that the panel wires input to the engine and hands the result to the confirm action; no heavy UI testing.

Gate: typecheck + tests + build green.

## Open follow-ups (not this ticket)

- Suggest-and-swap: replace a matched service with the curated catalog install (helm/manifest + secrets fields) reconciled into the same review flow.
- Multi-file / `include` / profiles.
- AI enrichment of probes and resource guesses, if deterministic defaults prove insufficient in practice.
