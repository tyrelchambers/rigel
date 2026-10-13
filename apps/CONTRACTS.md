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
  `purge`, `command`, `sshCommand`.
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
  - `host` (string) — `sshCommand` only: an SSH alias the user enabled in
    Settings > AI agents > SSH hosts.
  - `command` (string) — `sshCommand` only: the exact remote command. It may not
    start with `-`.
  - `sudo` (bool) — `sshCommand` only: run `command` as root. With `sudo: true`
    the `command` must NOT start with `sudo ` (the app adds it); the user types
    their sudo password in the confirm dialog (or leaves it empty when sudo
    doesn't ask on that host). The model never supplies a password.

Special kinds:
- `purge` — full app removal. Emit `{"kind":"purge","name":<root-deployment>,"namespace":<ns>}`.
  Opens the typed-name purge confirm sheet (discovery against the live cache).
  Never list resources to delete one-by-one for a full removal.
- `command` — escape hatch for kubectl (incl. plugins like `cnpg`) the typed
  kinds don't model.
- `annotate` / `label` — metadata edits. `label` carries more risk than it
  looks: labels feed Service selectors, NetworkPolicies and ArgoCD tracking, so
  a wrong one breaks routing with nothing visible to see.

Additional kinds:
- `sshCommand` — run one command on an enabled SSH host. Fields `host`,
  `command`, optional `destructive`, optional `sudo`. The app runs
  `ssh -T -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -- <host> <command>` after the confirm sheet and
  records it (with the exit code) in the AI action ledger.
  With `sudo: true` the remote command is one quoted word for the login shell:
  `sh -c 'sudo -S -p <prompt-marker> -v && printf %s <ok-marker> >&2 && exec </dev/null && sudo -n -- sh -c <command>'`.
  `sudo -v` authenticates first and is the only process that can read the
  password; stdin is then pointed at `/dev/null` before the command runs, so
  nothing on the host holds the pipe afterwards. The password travels only in
  the `action.run` WS frame's separate `secret` field (never in the action,
  the ledger, progress frames or chat feedback) and is optional. The server
  writes it to ssh's stdin once, only when the prompt marker appears before
  the ok marker and before any stdout; otherwise (or with no password) stdin
  is closed, so sudo fails with its own message. Both markers are cut from the
  output. A sudo action runs only from the chat confirm dialog: REST
  `/api/action` refuses to execute it, and batch runs skip it.
  Caveats: hosts with sudo `timestamp_timeout=0` fail the `sudo -n` step, and
  `sudo -v` asks for a password unless every sudoers entry for the user is
  NOPASSWD, so a host that is NOPASSWD only for some commands still needs one.
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
    label value removing the key. This is the shape Issues' "Fix in Git" sends.

  Both or neither is a 422, never a silent preference. The manifest is located
  by matching kind + name + namespace across the source's directory; zero
  matches, several matches, or a templated (Helm) tree refuses with the reason
  rather than editing on a guess. Nothing is applied to the cluster: the confirm
  sheet shows a `git diff` before the operator confirms. The opened PR is
  labelled `rigel` + `rigel:<chat|agent>`.

- `adoptWorkload` — export a live workload and everything around it into the
  repo as manifests, and open a pull request, so an app that exists only in the
  cluster can be redeployed from Git. Fields: `source`, `name`, `namespace`,
  `resourceKind` when it is not a Deployment, `title`, `body`. No `edit` and no
  `content`: the server discovers the related resources (the same engine purge
  uses, instance label then name prefix), reads each one, cleans it with
  `cleanExportedManifest`, and writes one file per resource at
  `<manifest path>/<kind>-<name>.yaml`. What it includes is the same closure
  `GET /api/discover` reports, so what the assistant says belongs to a workload
  and what a pull request would carry can never disagree: the Services whose
  selector matches the workload's pod labels, the Ingresses whose backend names
  those Services, and the ConfigMaps, Secrets and PVCs the pod template reads or
  mounts. Names are never matched, because a prefix is not a relationship. A referenced Secret is committed as
  `<kind>-<name>.yaml.example` with its values redacted, which `kubectl apply
  -R` ignores, so a later sync can never write it over the live Secret. A Helm
  release refuses, naming it, because rendered manifests drift from the chart.

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

