# Shared contracts (manager-owned — handed identically to both apps)

These three surfaces MUST be byte-identical across the Swift and web apps.
Neither sub-agent may re-derive or extend them per app.

## 1. Chat action-block protocol

Claude never runs mutations itself. For any cluster change it appends a fenced
` ```action ` block; the app hides the raw block, renders a one-click button, and
runs the change through its own confirm sheet (exact kubectl shown first). Prose
still explains what/why.

Action JSON (`SuggestedAction`):
- `label` (string, required) — button text.
- `kind` (string, required) — one of:
  `restart`, `scale`, `rollback`, `setEnv`, `setImage`, `setResources`,
  `pause`, `resume`, `deletePod`, `deleteWorkload`, `cordon`, `uncordon`,
  `drain`, `suspendCronJob`, `resumeCronJob`, `triggerCronJob`,
  `createNamespace`, `deleteNamespace`, `deleteResource`, `purge`, `command`.
- Target fields (presence depends on kind):
  - `name` — controller / cronjob / namespace / resource target.
    (`deployment` is accepted as a back-compat alias; `target = name ?? deployment`.)
  - `pod`, `node`, `namespace`.
  - `replicas` (int) — scale.
  - `env` (object string→string) — setEnv.
  - `container`, `image` — setImage. `container`, `requests`, `limits` — setResources
    (kubectl quantity strings, e.g. `cpu=250m,memory=512Mi`).
  - `resourceKind` — deleteResource (e.g. `service`, `configmap`, `secret`,
    `pvc`, `pv`, `ingress`, `clusterrole`).
  - `args` (string[]) — `command` only: literal kubectl args WITHOUT the `kubectl`
    binary or `--context` (app prepends both), e.g. `["cnpg","destroy","pg","pg-1","-n","default"]`.
  - `destructive` (bool) — `command` only: Claude's hint. App also infers from
    destructive verbs in `args` and takes the STRICTER of the two (a `false` can
    never downgrade an obviously destructive command).

Special kinds:
- `purge` — full app removal. Emit `{"kind":"purge","name":<root-deployment>,"namespace":<ns>}`.
  Opens the typed-name purge confirm sheet (discovery against the live cache).
  Never list resources to delete one-by-one for a full removal.
- `command` — escape hatch for kubectl (incl. plugins like `cnpg`) the typed
  kinds don't model.

Examples:

```action
{"label":"Set MEMOS_PORT=5230 & restart memos","kind":"setEnv","name":"memos","namespace":"default","env":{"MEMOS_PORT":"5230"}}
```

```action
{"label":"Right-size web to req cpu=250m,memory=512Mi","kind":"setResources","name":"web","namespace":"default","container":"web","requests":"cpu=250m,memory=512Mi","limits":"cpu=500m,memory=1Gi"}
```

```action
{"label":"Drain node worker-3","kind":"drain","node":"worker-3"}
```

## 2. MCP tools (`helmsman` server)

The copilot reads the cluster through purpose-built MCP tools (plus the
read-only kubectl allowlist). Current tools (`Sources/HelmsmanMCP/main.swift`):
- `list_unhealthy_pods` — pods not Running/Ready, with reasons.
- `list_degraded_deployments` — deployments with unavailable replicas.
- `recent_warning_events` — recent Warning events.
- `get_pod_logs` — logs for a named pod (requires `name`).

Tool names/shapes are part of the contract — keep identical names and input
schemas across apps.

## 3. catalog.json schema

`Sources/Helmsman/Resources/catalog.json` — top level `{ "apps": [ … ] }`
(54 entries). Each app:
- `id`, `name`, `tagline`, `description`, `category`, `iconSystemName`.
- `docsURL`, `repoURL`, `homepageURL`, `tags`.
- `install` — `{ "mode": "manifest" | "helm", … }`. For `manifest`, an inline
  multi-doc YAML `manifest` string with template vars `{{instance}}`,
  `{{namespace}}`, `{{storage}}` (and others a panel may substitute).
- `matchImages` — image refs used to detect an installed instance.
- `requirements`, `persistence` (bool/int), `exposesIngress` (bool), `notes`,
  `installPromptTemplate`.

When porting catalog logic, preserve the exact key names and template-var syntax.
