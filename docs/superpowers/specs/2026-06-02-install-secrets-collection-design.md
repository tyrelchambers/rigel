# Install-Secrets Collection & Helm-Aware Install — Design

**Date:** 2026-06-02
**Status:** Approved (pending spec review)
**Area:** Catalog install wizard (`Sources/Helmsman/Panels/Catalog`, `Sources/Helmsman/Catalog`)

## Problem

Self-hosted apps installed through the catalog wizard frequently need sensitive
values the user must supply or generate — Django `secretKey`, bundled
Postgres/Redis/MinIO passwords, MinIO access keys, plus integration secrets the
user alone knows (OAuth client secrets, SMTP creds, external API keys). Today
the per-app install templates instruct Claude to set these to literal
`<FILL_ME_IN>` placeholders inline in the generated manifest / `values.yaml`.
That means:

- the user has to hand-edit YAML to fill them in, and
- secrets end up inlined in the applied artifact rather than in a Kubernetes
  Secret.

We want an explicit wizard step that **collects** these values (generating the
random ones, prompting for the user-supplied ones), **creates a Secret** in the
app's namespace, and ensures the installed app **references that Secret**
(`valueFrom.secretKeyRef` for raw manifests, the chart's `existingSecret` value
for Helm). Closing this also requires the wizard to actually **run Helm** for
chart-based apps, which it does not do today.

## Decisions (locked during brainstorming)

1. **Value scope:** collect *both* auto-generatable random secrets and
   user-supplied secrets. The form distinguishes "generate for me" from "you
   must enter this".
2. **Wiring:** Claude emits the Secret *reference* (and the machine-readable
   schema of keys); the wizard owns the Secret's values and creates the Secret.
   Claude knows each chart's `existingSecret`/`secretKeyRef` conventions.
3. **Helm:** the wizard also runs the Helm install (previously a gap). It runs
   Helm via a **structured install descriptor** Claude emits — the wizard builds
   and runs the `helm` command itself and never executes model-authored shell.
4. **Secret name:** the wizard owns the name, decided *before* generation and
   passed to Claude as a template var, so references always match. Collision-safe
   (see §3).
5. **Missing `install` block:** default to `manifest` mode (today's
   `kubectl apply` behavior). This is an accepted, explicitly-approved fallback.

## Flow

Pipeline gains one step:

```
configure → generating → secrets → review → applying → verifying → done
```

`secrets` auto-skips (straight to `review`) when the generated artifact declares
no secret keys (e.g. Excalidraw, it-tools).

## 1. Contract changes (prompt + parsing)

### Prompt

Add an authoritative **"Secrets & install contract"** section to the shared
`buildInstallPrompt()` preamble in `CatalogInstallWizardModel`. It follows the
existing override pattern already used for ingress class / middleware / image
pull secret (the preamble explicitly says it overrides any conflicting per-app
instruction below), so the 50 entries in `catalog.json` do **not** need editing.
It instructs Claude to:

1. Put every sensitive value into a Kubernetes Secret named **`{{secretName}}`**
   (new template var) in namespace `{{namespace}}`, referenced via:
   - raw manifests → `env[].valueFrom.secretKeyRef` (name `{{secretName}}`), and
   - Helm charts → the chart's `existingSecret` (or equivalent) value, with the
     Secret's data keys matching what the chart expects.
2. **Not** inline `<FILL_ME_IN>` values anywhere, and **not** emit the Secret
   resource with values — the wizard creates the Secret. (For raw manifests the
   Secret resource is omitted from the ```yaml block entirely.)
3. Emit a fenced ```secrets block — a JSON array of field specs:
   `{ "key": "...", "label": "...", "description": "...", "kind": "random"|"user", "length"?: 32, "required"?: true }`.
4. Emit a fenced ```install block — the install descriptor:
   `{ "mode": "manifest" }` or
   `{ "mode": "helm", "repoName": "...", "repoURL": "...", "chart": "...", "version": "...", "releaseName": "..." }`.

### New template var

`templateVars` gains `"secretName": secretName`.

### Parsing

New file `Catalog/InstallArtifacts.swift`:

- `struct SecretFieldSpec: Decodable` — `key, label, description?, kind (enum random/user), length?, required (default true)`.
- `struct InstallDescriptor: Decodable` — `mode (enum manifest/helm)`, optional
  `repoName, repoURL, chart, version, releaseName`.
- `enum WizardArtifacts { static func parse(_ text: String) -> (yaml: String?, secrets: [SecretFieldSpec], install: InstallDescriptor?) }`
  — mirrors `SuggestedAction.parse`'s fenced-block splitting: walks ` ``` `
  fences, decodes `secrets` and `install` bodies (closed fences only, so
  half-streamed JSON never flashes), and returns the latest ` ```yaml ` block via
  the existing extraction. A missing `install` block yields `nil` → caller
  defaults to `.manifest`.

`CatalogInstallWizardModel.handle(.result:)` is updated to populate
`secretSchema` and `installDescriptor` from `WizardArtifacts.parse` (in addition
to the existing `manifestYAML` extraction).

## 2. Data model additions (`CatalogInstallWizardModel`)

- `var secretName: String` — resolved in `advanceFromConfigure()` (see §3).
- `var secretSchema: [SecretFieldSpec] = []`
- `var installDescriptor: InstallDescriptor? = nil`
- `var secretValues: [String: String] = [:]` — collected values; random keys
  pre-filled when the schema arrives.
- `var secretNameNote: SecretNameNote` — `.fresh`, `.reusing`, or
  `.suffixed(requested:)` for the UI banner.

New `WizardStep` case `.secrets` with `pipelineIndex` 2; downstream indices shift
(`review` 3, `applying`/`failed` 4, `verifying` 5, `done` 6).

## 3. Collision-safe Secret name

New file `Catalog/SecretNameResolver.swift`:

```
enum SecretNameResolver {
    struct Resolution { let name: String; let note: SecretNameNote; let prefill: [String:String] }
    // existing: secrets currently in the namespace (name, labels, decoded data)
    static func resolve(instance: String, existing: [ExistingSecret]) -> Resolution
}
```

Logic:
- base `= "\(instance)-secrets"`.
- if a Secret named base exists **and** carries our labels
  (`app.kubernetes.io/managed-by == "helmsman"` && `app.kubernetes.io/instance == instance`)
  → ours: keep base, `note = .reusing`, `prefill =` its decoded values.
- exists but **unrelated** (no/!matching labels) → first free `"\(instance)-secrets-\(n)"`
  (n≥2), `note = .suffixed(requested: base)`.
- free → base, `note = .fresh`.

Source of `existing`: a read-only probe of the namespace's secrets, modeled on
`ClusterIssuerLoader` (`kubectl get secret -n <ns> -o json --context <ctx>`),
returning name + labels + decoded data. Pure resolver logic is unit-tested; the
probe is best-effort (failure → treat as no existing secrets, `note = .fresh`).

Random generation helper (same file or a small `RandomSecret` util): strong
alphanumeric (`A–Za–z0–9`, avoiding YAML/shell-hostile chars), default length 32,
honoring a field's `length`.

`advanceFromConfigure()` becomes `async` (or kicks a `Task`) so it can run the
probe, resolve the name, set `secretName`/`secretNameNote`, seed `secretValues`
prefill, *then* set `step = .generating` and send the prompt with `{{secretName}}`
populated.

## 4. Secrets step UI (`CatalogInstallWizard`)

When Generating completes and `secretSchema` is non-empty, `useManifest()` routes
to `.secrets` instead of `.review`. The step renders:

- Header: target `name` / `namespace`, plus a banner from `secretNameNote`
  (`.suffixed` → "`<base>` is already in use — creating `<name>`";
  `.reusing` → "updating the existing secret for this install").
- One row per `SecretFieldSpec`: `label` + `description`, a secure field with a
  reveal toggle, bound to `secretValues[key]`.
  - `random` kind: pre-filled generated value + a **Regenerate** button.
  - `user` kind: empty, placeholder hint, marked required.
- **Continue** button gated by `canAdvanceFromSecrets`: every `required` `user`
  field non-empty (random fields always have a value). Advancing sets
  `step = .review`.

When `secretSchema` is empty the step is skipped entirely (existing behavior
preserved).

## 5. Apply ordering (Secret-first) + Helm execution

`runApply()` (renamed/extended) runs in order, stopping on first failure:

1. **Secret first** (only when `secretSchema` non-empty): build via existing
   `Secret.draft(name: secretName, namespace: namespace, type: .opaque,
   decodedData: secretValues, labels: ["app.kubernetes.io/managed-by": "helmsman",
   "app.kubernetes.io/instance": instance])` and apply via the existing
   `WorkloadCommander.run(.applySecret(secret))`. On failure → `.failed`
   (the app is **not** installed).
2. **App install** by `installDescriptor?.mode ?? .manifest`:
   - `.manifest` → `applyManifest(yaml: manifestYAML, label: app.id)` (today's path).
   - `.helm` → new `HelmCommander` (see below).
3. Success → `.verifying`; failure → `.failed`.

`releaseName` is bound to `instance` so the chart's default
`app.kubernetes.io/instance` label matches the existing verify pod-matching
(`startVerifyPoll`) with no change. The Secret is added to `verifyResources` as
`.applied`.

### `HelmCommander` (`Panels/Actions/HelmCommander.swift`)

Parallels `WorkloadCommander` but resolves the `helm` binary and reuses
`runProcess`. It does **not** execute Claude's bash; it builds the command vector
from the descriptor + wizard-owned namespace/context/values:

1. write `manifestYAML` (the values.yaml for helm mode) to a temp file.
2. `helm repo add <repoName> <repoURL>` — idempotent; "already exists" is treated
   as success.
3. `helm repo update <repoName>`.
4. `helm upgrade --install <releaseName> <repoName>/<chart> --version <version>
   -n <namespace> --create-namespace -f <tmpValues> --kube-context <context>`.

stdout is streamed into `applyLog` (same surface the manifest path uses). The
exposed command vector is unit-tested.

## 6. Error handling

- `helm` / `kubectl` not found → `.failed` with an actionable message.
- Secret apply non-zero → `.failed`, app install skipped.
- Helm non-zero / invalid (missing required helm coords when `mode == helm`) →
  `.failed` with stderr.
- Missing `install` block → `.manifest` mode (approved fallback).
- Name-resolution probe failure → proceed as `.fresh` with the base name.

`retryGenerate(withError:)` and `handoffPromptForMainChat(reason:)` continue to
work; the hand-off prompt gains the resolved `secretName` and install mode for
context.

## 7. Testing (cluster-free, matches existing `Tests/HelmsmanTests` style)

- `InstallArtifactsTests`: decode `SecretFieldSpec` / `InstallDescriptor`;
  `WizardArtifacts.parse` extracts yaml + secrets + install from a sample
  transcript, skips absent blocks, ignores half-streamed (unclosed) fences.
- `SecretNameResolverTests`: ours → keep + prefill; unrelated → suffix;
  free → base; multiple unrelated → next free suffix.
- `RandomSecretTests`: length honored; charset restricted; values differ.
- `HelmCommandTests`: descriptor → expected argument vector (incl. namespace,
  context, version, values flag); repo-add idempotence handling.
- `WizardSecretsGatingTests`: `canAdvanceFromSecrets` true only when all required
  user fields filled; random fields don't block.

## 8. Files

**New**
- `Sources/Helmsman/Catalog/InstallArtifacts.swift` — `SecretFieldSpec`,
  `InstallDescriptor`, `WizardArtifacts.parse`.
- `Sources/Helmsman/Catalog/SecretNameResolver.swift` — collision resolver +
  random-secret generator + namespace secret probe.
- `Sources/Helmsman/Panels/Actions/HelmCommander.swift` — Helm execution.
- Tests: `InstallArtifactsTests`, `SecretNameResolverTests`, `RandomSecretTests`,
  `HelmCommandTests`, `WizardSecretsGatingTests`.

**Modified**
- `Sources/Helmsman/Panels/Catalog/CatalogInstallWizardModel.swift` — `.secrets`
  step + `pipelineIndex` shift, new fields, async `advanceFromConfigure`,
  `secretName` + `templateVars`, `handle(.result:)` artifact parsing,
  Secret-first `runApply`, helm branch, verify additions, secrets-gating.
- `Sources/Helmsman/Panels/Catalog/CatalogInstallWizard.swift` — Secrets step
  view, step-nav indicator, routing from Generating.
- `buildInstallPrompt()` preamble — Secrets & install contract section.

**Not edited:** `catalog.json` per-app templates (the preamble override is
authoritative for v1; scrubbing residual `<FILL_ME_IN>` wording from individual
templates is a possible later cleanup).

## Out of scope

- Rotating/regenerating secrets for an already-installed app outside the wizard.
- Editing the Secret from the wizard after install (the Secrets panel already
  exists for that).
- Scrubbing `<FILL_ME_IN>` wording from the 50 catalog templates.
