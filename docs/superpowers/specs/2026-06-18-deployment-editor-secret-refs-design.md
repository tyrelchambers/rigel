# Deployment editor — image-pull secrets, env-from-secret/configmap refs, wide modal

**Date:** 2026-06-18
**Status:** Approved (design)
**Branch:** master (current)

## Problem

The inline Deployment config editor (`DeploymentEditor.tsx`, shipped in f762eeb)
edits replicas, per-container image, CPU/memory, and **plain** env vars. It has
two gaps the user hit:

1. No way to attach a **registry / image-pull secret** (e.g. a GHCR
   `dockerconfigjson` secret) so the deployment can pull private images.
2. No way to add an env var whose value is **referenced from an existing Secret
   or ConfigMap key** (Rancher's per-variable "from resource"). Existing
   `valueFrom` env vars render read-only and can only be removed.

The original ask was "reference a secret in the Environment section (like my
GHCR secret)". Clarification established that a GHCR secret is a *registry*
secret — it belongs in `imagePullSecrets`, **not** env. So this change adds
**both** mechanisms, each in its correct place.

The user also wants the editor presented as a **wide centered modal** rather than
the current bottom-docked Sheet.

## Two k8s mechanisms (keep them distinct)

| Feature | k8s field | kubectl |
|---|---|---|
| Image pull secrets (GHCR) | `spec.template.spec.imagePullSecrets` (pod-level) | `patch --type=merge` — replaces the array |
| Env var ← Secret/ConfigMap key | `container.env[].valueFrom.{secretKeyRef\|configMapKeyRef}` | `patch --type=strategic` — merges env by `name` |

There is no native `kubectl set` verb for either, so both become `kubectl
patch`. Precedent exists: `suspendCronJob`/`resumeCronJob` already build `patch`
commands in `buildCommand`.

Command preview is **server-side** (`BatchConfirmSheet` → `fetchPreviewCommand`
→ `/api/action?preview=1` → server `buildCommand`). New kinds therefore only
need a `buildCommand` case on the server; the preview and the exact-command
confirm step work automatically.

Adding web-only action kinds is acceptable — web is now the primary app and may
diverge from the Swift action contract (per project memory; supersedes the
apps/CLAUDE.md "don't invent kinds" note for web-only kinds).

## Architecture

### New action kinds (server `buildCommand` + both `ActionBlock` interfaces)

`ActionBlock` is declared in two places — `apps/web/src/lib/api.ts` (client) and
`apps/server/src/actions.ts` (server). Both gain:

```ts
imagePullSecrets?: string[];
envRefs?: Array<{
  name: string;            // env var name
  source: "secret" | "configMap";
  resourceName: string;    // Secret/ConfigMap name
  key: string;             // data key
}>;
```

**`setImagePullSecrets`** — deployment/workload level. Sends the **full desired
list** (merge patch replaces arrays, so detach/clear works by sending a shorter
list or `[]`):

```
kubectl patch <wk>/<name> -n <ns> --type=merge -p \
  '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"ghcr-secret"}]}}}}'
```

`buildCommand`:
```ts
case "setImagePullSecrets": {
  const wk = workloadKind(a);
  const list = (a.imagePullSecrets ?? []).map((n) => ({ name: n }));
  const patch = JSON.stringify({ spec: { template: { spec: { imagePullSecrets: list } } } });
  return ["patch", `${wk}/${target(a)}`, ...ns, "--type=merge", "-p", patch];
}
```

**`setEnvRef`** — per container. Strategic merge keys both `containers` and
`env` by `name`, so it adds/updates only the referenced vars without disturbing
others:

```
kubectl patch <wk>/<name> -n <ns> --type=strategic -p \
  '{"spec":{"template":{"spec":{"containers":[{"name":"app","env":[
     {"name":"DB_PASSWORD","valueFrom":{"secretKeyRef":{"name":"app-db","key":"password"}}}
  ]}]}}}}'
```

`buildCommand`:
```ts
case "setEnvRef": {
  const wk = workloadKind(a);
  const env = (a.envRefs ?? []).map((r) => ({
    name: r.name,
    valueFrom: r.source === "configMap"
      ? { configMapKeyRef: { name: r.resourceName, key: r.key } }
      : { secretKeyRef: { name: r.resourceName, key: r.key } },
  }));
  const patch = JSON.stringify({ spec: { template: { spec: { containers: [{ name: a.container, env }] } } } });
  return ["patch", `${wk}/${target(a)}`, ...ns, "--type=strategic", "-p", patch];
}
```

Both reuse the existing `workloadKind(a)`, `target(a)`, and `ns` helpers, so
statefulset/daemonset workloads are handled by `resourceKind` for free. Neither
kind is destructive (`isDestructiveAction` is unaffected).

### Edit model + diff (`deploymentDisplay.ts`)

- `DeploymentEdit` gains `imagePullSecrets: string[]` (deployment-level).
- `ContainerEdit.refEnvKeys` (today one read-only bucket for **all** `valueFrom`)
  splits into:
  - `envRefs: EnvRefEdit[]` — **editable** secret/configmap-key refs, where
    `EnvRefEdit = { id; name; source: "secret" | "configMap"; resourceName; key }`.
  - `otherRefKeys: string[]` — `fieldRef` / `resourceFieldRef` refs stay
    **read-only + removable** (no regression for downward-API env).
- `EnvVar.valueFrom` is typed (was `unknown`): `{ secretKeyRef?; configMapKeyRef?;
  fieldRef?; resourceFieldRef? }` where the `*KeyRef` shapes are `{ name; key }`.
- `PodTemplate.spec` gains `imagePullSecrets?: { name: string }[]`.

`editModelFor`:
- `imagePullSecrets` ← `spec.template.spec.imagePullSecrets?.map(s => s.name) ?? []`.
- Per container, partition `env`:
  - plain (`valueFrom == null`) → `env` rows (unchanged).
  - `valueFrom.secretKeyRef` → `envRefs` (source `"secret"`).
  - `valueFrom.configMapKeyRef` → `envRefs` (source `"configMap"`).
  - other `valueFrom` → `otherRefKeys`.

`diffDeployment` (order: `scale` → per-container [`setImage` → `setResources` →
`setEnv` → `setEnvRef`] → `setImagePullSecrets`):
- imagePullSecrets: compare sorted original vs edited name lists; if different,
  emit one `setImagePullSecrets` with the full edited list.
- env refs: any added/changed ref (by `name`, comparing source/resource/key) →
  collect into one `setEnvRef` per container.
- removed refs (present originally, gone now) → reuse the existing `setEnv`
  `unsetEnv` (`KEY-`) removal path (covers secret/configmap/field refs alike).
- **Plain → ref conversion edge case:** when a name moves from a plain row to a
  ref row, the plain row's absence already produces a `setEnv` unset; because
  `setEnv` precedes `setEnvRef` in per-container order, the unset runs first,
  avoiding an invalid `value` + `valueFrom` collision on the same env entry.

### UI components

- **`ImagePullSecretsField.tsx`** (new) — deployment-level section. Renders
  attached secret names as removable chips + an "Add" `<select>` listing
  namespace secrets of type `kubernetes.io/dockerconfigjson` /
  `kubernetes.io/dockercfg`. Props: `value: string[]`, `available: Secret[]`,
  `onChange(next: string[])`. Helper text: "Used to pull images from private
  registries (e.g. GHCR)."
- **`EnvRefEditor.tsx`** (new) — per container, rendered under the plain
  `KeyValueEditor`. Each row: env-name `input` + source `<select>`
  (Secret/ConfigMap) + resource `<select>` (names from the chosen source in the
  namespace) + key `<select>` (keys from the chosen resource's `data`) + remove;
  plus an "Add reference" button. Props: `rows: EnvRefEdit[]`,
  `secrets: Secret[]`, `configMaps: ConfigMap[]`, `onChange`.
- Read-only `otherRefKeys` keep the existing dashed-pill "from ref · read-only"
  display + remove button.
- **Live data:** while open, the editor subscribes to `secrets` and `configmaps`
  for the deployment's namespace (`subscribe(kind, ns)` / `unsubscribe` on
  close) and reads them from the cluster store (`resources.secrets`,
  `resources.configmaps`). Native `<select>` is used throughout (no `select`
  primitive exists; consistent with the editor's existing native inputs).

### Modal

Convert the editor from a bottom `Sheet` to a centered **`Dialog`**
(`components/ui/dialog.tsx` already exists), wide (`max-w-3xl`, scrollable body
`max-h-[85vh] overflow-auto`). `BatchConfirmSheet` is already a `Dialog` and
stacks above the editor on "Review changes" — current behavior (editor stays
mounted behind the confirm step) is preserved.

## Testing

- Web `deploymentEdit.test.ts`:
  - imagePullSecrets add / remove / reorder-noop / clear → correct
    `setImagePullSecrets` (or none).
  - env ref add (secret) and add (configMap) → `setEnvRef` with right `valueFrom`.
  - env ref removal → `setEnv` `unsetEnv`.
  - plain → ref conversion → both an unset and a `setEnvRef`, in order.
- Server `actions.test.ts`: `buildCommand` patch JSON for `setImagePullSecrets`
  (merge) and `setEnvRef` (strategic), including `-n <ns>` and a `statefulset`
  `resourceKind`.
- `pnpm --filter web typecheck && pnpm --filter web test` and
  `pnpm --filter @rigel/server test`.

## Post-implementation

- Rebuild the running container: `docker compose up -d --build` (the web app
  runs as a local Docker container; typecheck/build alone won't update it).
- Update the Rigel app's Outline doc (deployment editor section) and derive
  Plane tickets from the change, per the docs/tickets workflow.

## Out of scope (YAGNI)

- Bulk "import whole secret as env" (`kubectl set env --from=secret/X`) — the
  per-row ref editor covers the stated need.
- Editing imagePullSecrets / env refs for non-Deployment workloads from their own
  panels (the action kinds support `resourceKind`, but only the Deployment editor
  surfaces them now).
- Creating new secrets/configmaps from within the editor (pick existing only).
