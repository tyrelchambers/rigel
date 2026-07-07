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

## Autofixes (v1, folded into this branch)

Warnings become actionable. Fixes are deterministic and modeled as options on `convert()`, so applying a fix means re-running the conversion with an option flipped (idempotent, no in-place mutation). Nothing applies until the same ConfirmSheet.

`ConvertOptions` gains a `fixes` object (all default off / `"none"`):

```
ConvertOptions {
  namespace: string
  fixes?: {
    emitSecrets?: boolean                          // Secret manifests for secret-env
    bindMountsToPvc?: boolean                       // host bind mounts -> PVCs
    expose?: "none" | "loadbalancer" | "ingress"    // published ports
    ingressHost?: string                            // required when expose === "ingress"
    addWaitInit?: boolean                           // depends_on -> wait-for init containers
  }
}
```

Each fixable `Warning` gains an optional `fix`:

```
WarningFix { label: string, option: "emitSecrets" | "bindMountsToPvc" | "expose" | "addWaitInit" }
```

The four fixes:

1. **Generate Secret** (`emitSecrets`) — for each service with secret-looking env, emit an Opaque `Secret` named `sanitizeName(service)` whose `stringData` carries those env keys with the values from the compose file (the container already references them via `secretKeyRef`). Suppresses that service's secret-env warnings.
2. **Convert bind mount → PVC** (`bindMountsToPvc`) — for each host bind mount, emit an RWO 1Gi PVC named `<service>-<sanitize(mountPath)>` and add the matching `volumeMount` + `persistentVolumeClaim` volume to the Deployment. Suppresses the bind-mount warnings.
3. **Expose** (`expose`) — `"loadbalancer"`: Services with published ports become `type: LoadBalancer`. `"ingress"` (with `ingressHost`): Services stay ClusterIP and one `Ingress` is emitted (host `ingressHost`, one Prefix rule per exposed service — path `/` when a single service is exposed, else `/<service>` — backed by that service's first published port). Either value suppresses the published-port warnings; `"ingress"` with no host is a no-op that keeps the warnings.
4. **Add wait-for init containers** (`addWaitInit`) — for each service with `depends_on`, add one `busybox:1.36` initContainer per dependency that blocks until the dependency is reachable (`nc -z <dep> <port>` using the dependency's first container port, or `nslookup <dep>` when it exposes no port). Suppresses the depends_on warning.

Manifest emission order stays deterministic: Deployments, Services, PVCs, Secrets, Ingress.

**Panel UI:** the warnings/hints strip gains fix controls. A "Fix all" button enables the three zero-input fixes (`emitSecrets`, `bindMountsToPvc`, `expose: "loadbalancer"`, `addWaitInit`). Each fixable warning row has a "Fix" button that flips its option; the published-port fix offers LoadBalancer (one click) or Ingress (opens a hostname input, per the no-free-text-traps rule). Enabled fixes are reflected as lit toggles the user can turn back off; the manifests and remaining warnings re-render live. All fix state feeds the single `convert(compose, { namespace, fixes })` call.

## "What this will create" explainer (deterministic, folded into this branch)

Beginner hand-holding. A plain-language explanation of what the conversion produces, generated deterministically from the `ConversionResult` (no AI, no network — works during cold-start onboarding, and can never describe a resource that wasn't emitted). It re-derives live as the user edits or applies fixes.

Engine adds a pure function:

```
explainConversion(result: ConversionResult): Explanation
Explanation {
  summary: string                                     // one friendly lead sentence
  resources: { kind: string, count: number, text: string }[]  // one entry per emitted kind, plain-language
  attention: string[]                                 // plain-language notes derived from the warning TYPES present
}
```

- `summary` — e.g. "Your Compose file becomes 10 Kubernetes resources: 4 apps plus the pieces that keep them running, networked, and stored."
- `resources` — one entry per distinct emitted kind, counts from the manifests, each with a beginner-friendly gloss:
  - Deployment: "Runs your app containers and keeps them alive, restarting any that crash."
  - Service: "Gives each app a stable in-cluster address so your apps can reach each other by name."
  - PersistentVolumeClaim: "Reserves durable storage so your data survives restarts and updates."
  - Secret: "Holds sensitive values like passwords and tokens, separate from your app config."
  - Ingress: "Routes traffic from outside the cluster to your app at the hostname you set."
- `attention` — a plain-language line per warning TYPE currently present (so lines disappear as fixes are applied), each nudging toward the matching Fix:
  - published-port: "Your apps' ports are internal-only right now. Use a port's Fix (LoadBalancer or Ingress) to reach them from outside the cluster."
  - secret-env: "Some values look like passwords. Use Fix to have Rigel create a Secret to hold them, or create it yourself before applying."
  - bind mount: "A folder from your machine (a bind mount) can't move to Kubernetes as-is. Use Fix to turn it into cluster storage."
  - depends_on: "Kubernetes starts everything at once. Use Fix to make dependents wait for what they need."

Pure and unit-tested (counts, per-kind text present only for emitted kinds, attention lines gated on warning presence). Exported from `@rigel/compose`.

**Panel UI:** a collapsible "What this will create" card sits above the two-pane body, expanded by default (this is onboarding hand-holding), with a chevron to collapse for power users. It renders `summary` as a lead line, `resources` as a friendly icon list, and `attention` as a short "Heads up" list. It reads the same live conversion result, so it updates as the user edits the compose or toggles fixes. Tailwind + tokens, matches the panel's visual system.

## Open follow-ups (not this ticket)

- Suggest-and-swap: replace a matched service with the curated catalog install (helm/manifest + secrets fields) reconciled into the same review flow.
- Multi-file / `include` / profiles.
- AI enrichment of probes and resource guesses, if deterministic defaults prove insufficient in practice.
