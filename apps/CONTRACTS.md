# Chat action-block contract

The web app's chat action-block contract, implemented in
`packages/k8s/src/actionBlocks.ts`.

## Chat action-block protocol

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
  `createNamespace`, `deleteNamespace`, `deleteResource`, `annotate`, `label`,
  `purge`, `command`.
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
  - `annotations` / `labels` (object string→string|null) — `annotate` / `label`.
    A `null` value removes the key (kubectl `key-`). Targets any resource via
    `resourceKind` (defaults to `deployment`); both build
    `kubectl <annotate|label> <kind>/<name> -n <ns> --overwrite <pairs…>`.
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
- `annotate` / `label` — metadata edits. `label` carries more risk than it
  looks: labels feed Service selectors, NetworkPolicies and ArgoCD tracking, so
  a wrong one breaks routing with nothing visible to see.

Confirmation, voice surface: no spoken word ever runs a change, and the agent
never asks for one — anyone within earshot could say it. What the agent may do
is keyed on the ACTION, not on what it hears:
- Non-destructive kinds (`AUTO_RUNNABLE_KINDS`: restart, rollback, pause,
  resume, suspend/resumeCronJob, uncordon, scale, setImage, setEnv,
  setResources, annotate, createNamespace, proposeRepoFix) run on the operator's
  own instruction. They destroy nothing and can be undone. `proposeRepoFix`
  belongs here because a pull request changes no cluster state, lands on a
  branch, and is read on GitHub before it merges; the reasoning is recorded
  beside `AUTO_RUNNABLE_KINDS`.
- Everything else is surfaced in the desktop popover for the operator to
  approve: the delete family, drain, cordon, purge, raw patches (setEnvRef,
  setImagePullSecrets), `command`, `applyManifest`, plus `label` (feeds
  selectors) and `triggerCronJob` (starts arbitrary work).
- A destructive hint downgrades any kind, `scale` to 0 replicas is treated as
  an outage rather than a scale, and `classifyTier` on the built command is the
  second, stricter gate: a kind that would otherwise run is surfaced when its
  actual command tiers destructive.

Additional kinds:
- `applyManifest` — install/self-host a new app. The `action` block is
  IMMEDIATELY followed by a ` ```yaml ` block; the parser attaches it as
  `manifest` and the app applies it via `kubectl apply -f -`.
- `proposeRepoFix` — fix a GitOps-managed app via pull request. Always carries
  `source` (the git source name, i.e. the `rigel.dev/source-repo` value),
  `title` and `body`, plus the change in ONE of two shapes:
  - `filePath` + `content`: the `action` block is IMMEDIATELY followed by a
    fenced code block with the COMPLETE new file content (attached as
    `content`). This is the chat shape.
  - `name` + `edit` (+ `namespace`, and `resourceKind` when the workload is not
    a Deployment): the change as an intent, and the server finds the manifest
    and writes it. `edit` is one of `{"op":"annotate","annotations":{…}}`,
    `{"op":"label","labels":{…}}`, `{"op":"setImage","container":"…",
    "image":"…"}`, `{"op":"scale","replicas":N}`, with a null annotation or
    label value removing the key. This is the voice shape.

  Both or neither is a 422, never a silent preference. Voice sends only the
  second shape, and its tool is schema-constrained (see below), so a near-miss
  key like `sourceId` is refused naming `source` before the call is made. The manifest is located
  by matching kind + name + namespace across the source's directory; zero
  matches, several matches, or a templated (Helm) tree refuses with the reason
  rather than editing on a guess. Nothing is applied to the cluster: the chat
  path shows a `git diff` in the confirm sheet before the operator confirms,
  and voice opens the PR itself and speaks its number and URL. The opened PR is
  labelled `rigel` + `rigel:<chat|voice|agent>`.

- `adoptWorkload` — export a live workload and everything around it into the
  repo as manifests, and open a pull request, so an app that exists only in the
  cluster can be redeployed from Git. Fields: `source`, `name`, `namespace`,
  `resourceKind` when it is not a Deployment, `title`, `body`. No `edit` and no
  `content`: the server discovers the related resources (the same engine purge
  uses, instance label then name prefix), reads each one, cleans it with
  `cleanExportedManifest`, and writes one file per resource at
  `<manifest path>/<kind>-<name>.yaml`. A referenced Secret is committed as
  `<kind>-<name>.yaml.example` with its values redacted, which `kubectl apply
  -R` ignores, so a later sync can never write it over the live Secret. A Helm
  release refuses, naming it, because rendered manifests drift from the chart.

### The voice tool is schema-constrained

The chat surface emits action blocks as fenced JSON and `extractActionBlocks`
parses them permissively, because the chat model is taught this contract in
prose and has no schema in context.

The voice tool is different: `proposeMutation` declares
`packages/k8s/src/actionSchema.ts`, a `z.discriminatedUnion("kind", ...)` over
every kind here. `@livekit/agents` validates against it BEFORE the tool runs, so
the model sees the field names up front, a wrong kind comes back listing every
valid one, and a wrong field comes back naming that field alone. Nothing in the
worker checks the shape by hand.

Two rules keep the schema honest, both tested in `actionSchema.test.ts`. Every
field the server consumes must appear in its variant, because zod strips
unknown keys and a missing one would be dropped before execute ever saw it. And
no `.refine()`, because refinements do not survive `toJSONSchema` and would
advertise a schema looser than the one that runs.

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

