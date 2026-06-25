# Assistant: annotation-correlated & bring-your-own credential Secrets

**Status:** Design / spec (2026-06-23)
**Branch context:** follows `feat/assistant-cred-help-ns-dropdown` (per-row help, method toggle, Codex subscription, namespace-aware credential read).

## Goal

Let the Cluster Assistant's credential UI **correlate Secrets to provider credentials by annotation instead of hardcoded Secret names**, and let an operator **point a provider credential at an existing Secret they already manage** (bring-your-own), without ever loosening the agent's no-secrets RBAC cage or sending secret values to the client.

## Motivation

Today the UI and the agent are both bound to two fixed Secret names (`rigel-assistant-token`, `rigel-assistant-credentials`) with fixed data keys. That is brittle:

- The readiness chips key off literal names, so a renamed or operator-supplied Secret reads as "Not set" even when the agent is happily using a token (the symptom that surfaced this: a running agent with a saved token showing "Not set" — already fixed for the namespace case, but the name-coupling remains).
- An operator who already keeps an Anthropic key (or a sealed-secret, or a shared org Secret) in the cluster has no way to point the Assistant at it; they must re-paste it into our Secret.
- The user's framing: *"rather than a secret name directly (maybe the user wants to change it), annotate secrets to correlate the secret to an agent's key."*

## Non-goals

- No runtime secret discovery by the agent. The RBAC cage that grants the agent **zero** secrets access stays exactly as-is (there's a test enforcing it). All resolution happens on the desktop server (which already holds the kubeconfig) at install/update time.
- No secret **values** crossing to the client. The client only ever sees credential ids, backing Secret **names**, and data **key names**.
- We do not manage the lifecycle (rotation/GC) of a Secret the operator brings; it's theirs.
- Multi-cluster per-context resolution is out of scope (resolution is within the agent's namespace).

## Canonical credential vocabulary

The provider credentials and the env var each maps to (the agent bridges read these — unchanged):

| credential id        | env var                  | notes                                  |
|----------------------|--------------------------|----------------------------------------|
| `claudeToken`        | `CLAUDE_CODE_OAUTH_TOKEN`| Claude subscription setup-token         |
| `anthropicApiKey`    | `ANTHROPIC_API_KEY`      | Claude API key                          |
| `codexApiKey`        | `CODEX_API_KEY`          | Codex API key                           |
| `codexAuthContent`   | `CODEX_AUTH_CONTENT`     | Codex ChatGPT auth.json (multiline)     |
| `geminiApiKey`       | `GEMINI_API_KEY`         | Gemini API key                          |
| `opencodeApiKey`     | `OPENCODE_API_KEY`       | OpenCode API key                        |
| `opencodeAuthContent`| `OPENCODE_AUTH_CONTENT`  | OpenCode auth file (multiline)          |

This table (`CREDENTIAL_ENV`) becomes the single source of truth in `packages/k8s` and drives both the Deployment env render and the readiness mapping. It also retires the current `claudeToken` wrinkle (today the token lives in a *separate* legacy Secret and the credentials-Secret `claudeToken` key is not wired to any env): under this design `CLAUDE_CODE_OAUTH_TOKEN` resolves through the same annotation mechanism, and the legacy `rigel-assistant-token` Secret simply becomes one annotated source.

## Annotation / label convention

A Secret participates as a credential source when it carries:

- **Discovery label** `rigel.assistant/credential-store: "true"` — so resolution can `kubectl get secrets -l rigel.assistant/credential-store=true` instead of getting fixed names. Our managed Secrets gain this label (in addition to the existing `app.kubernetes.io/managed-by: rigel-assistant`).
- **Per-credential correlation annotation** `rigel.assistant/credential.<credentialId>: "<dataKey>"` — declares "my data key `<dataKey>` provides `<credentialId>`". One annotation per credential the Secret supplies.

Examples on our managed Secrets (stamped at install):

```
# rigel-assistant-token
metadata:
  labels: { rigel.assistant/credential-store: "true", app.kubernetes.io/managed-by: rigel-assistant }
  annotations: { rigel.assistant/credential.claudeToken: "token", rigel.assistant/token-issued-at: "..." }

# rigel-assistant-credentials
metadata:
  labels: { rigel.assistant/credential-store: "true", app.kubernetes.io/managed-by: rigel-assistant }
  annotations:
    rigel.assistant/credential.anthropicApiKey: "anthropicApiKey"
    rigel.assistant/credential.codexApiKey: "codexApiKey"
    rigel.assistant/credential.codexAuthContent: "codexAuthContent"
    ...
```

A bring-your-own Secret with a differently-named key works the same:

```
# my-anthropic-secret (operator-owned)
metadata:
  labels: { rigel.assistant/credential-store: "true" }
  annotations: { rigel.assistant/credential.anthropicApiKey: "api-key" }   # their key is "api-key"
data: { api-key: <base64> }
```

## Resolution (the core)

A pure function `resolveCredentialSources(secrets)` produces, per credential id, the backing `{ secretName, dataKey, hasValue }`:

1. From every Secret carrying `rigel.assistant/credential-store=true`, read each `rigel.assistant/credential.<id>` annotation → candidate `{ id, secretName, dataKey }`. `hasValue` = that data key exists and is non-empty.
2. **Single owner per credential.** Choosing a Secret for a credential (via the UI action below) removes that credential's annotation from any sibling Secret, so each id resolves to exactly one source. If manual edits leave >1 claimant, pick the alphabetically-first Secret and emit a `conflicts[]` warning (surfaced, never silent).
3. **Backward-compat fallback.** If *no* annotated source exists for an id, fall back to the legacy fixed mapping (credentials-Secret key == id; `rigel-assistant-token`/`token` → `claudeToken`). So un-migrated installs keep working until re-stamped.

This one function feeds three consumers:

- **Deployment env render** (`packages/k8s` `deployment()`): for each `CREDENTIAL_ENV` row, emit `env[VAR].valueFrom.secretKeyRef = { name: resolved.secretName, key: resolved.dataKey, optional: true }`. Default install → points at our managed Secrets exactly as today. A repointed credential → points at the operator's Secret. A rollout restart picks it up (same path as `setCredentials`).
- **Readiness** (`credentialStatus`): return, per credential id, `{ ready: hasValue, secretName }` — **names and ids only, never values**. Replaces today's "get two fixed secrets, return key names."
- **UI source display** (below).

## UX

In the Agents tab Credentials section, each provider row keeps its current "paste a key" flow (writes to our managed Secret) and gains a **source affordance**:

- Default label stays "Key ready" / "Not set" — we do **not** show the raw Secret name as the primary label (per the user's note). A subtle "Change source" / "ⓘ source" control opens a dialog.
- **Source dialog** (Dialog, not Sheet): two modes —
  - *Managed by Rigel* (default): the existing paste-a-key / method-toggle editor.
  - *Use an existing Secret*: a **Secret picker** (dropdown of Secrets in the agent namespace — fetched, not free-text, per [[feedback_namespace_input_dropdown]] applied to secrets) + a **key picker** (dropdown of that Secret's data key names). On confirm → server annotates the chosen Secret, clears sibling claims, re-renders env, rolls the agent.
  - The dialog is where the backing Secret name *is* shown (for transparency when changing), but it's not the row's resting state.

Both pickers list **names only**; values never enter the client.

## Server actions

- `credentialStatus` → switch to `resolveCredentialSources` (label-list + annotation, fallback to fixed). Returns `{ credentials: { <id>: { ready, secretName } } }`. (Shape change from today's `credentialKeys: string[]`; update `credsFromSecretKeys` accordingly.)
- New `setCredentialSource` action `{ credentialId, secretName, dataKey }`:
  1. Verify the Secret exists and has the data key (read keys only).
  2. `kubectl annotate` the chosen Secret with `rigel.assistant/credential-store=true` + `rigel.assistant/credential.<id>=<dataKey>`; remove that annotation from any sibling.
  3. Re-render + apply the Deployment (env now resolves to the new source); rollout restart.
- `listCredentialSecrets` action (or reuse the existing secrets watch the panel already has): return candidate Secrets + their data key names for the picker. Names only.
- Install (`buildInstallConfig`/manifests): stamp the label + `rigel.assistant/credential.*` annotations on the managed Secrets; render env via `resolveCredentialSources` over the about-to-be-applied Secrets.

## Security

- **RBAC cage unchanged** — agent still has no `secrets` verbs; a test continues to assert this. All secret reads/annotations are done by the desktop server via kubeconfig.
- Values never reach the client (readiness = ids + names; pickers = names + key names).
- Annotating an operator's Secret is **additive** (namespaced annotation keys); we never write values into a BYO Secret, never copy its contents, and never delete it. Repointing only edits annotations + the Deployment env.
- "At rest" caveat is unchanged and honest: k8s Secrets are base64 in etcd unless the cluster enables encryption-at-rest / sealed-secrets — now even more relevant since operators may bring their own.

## Backward compatibility & migration

- Existing installs: managed Secrets are un-annotated → resolution falls back to the fixed mapping, so nothing breaks. The next install/update (or an idempotent `reconcileCredentialAnnotations` action) stamps the label + annotations. The namespace-aware read already shipped.
- The `claudeToken` dual-Secret legacy stays working via the fallback and via an annotation on `rigel-assistant-token`.

## Error handling / edge cases

- Chosen Secret/key missing at confirm time → action fails with a clear message; no env change, no rollout.
- Multiple claimants for one id → first-by-name wins + `conflicts[]` surfaced in the UI.
- A credential with no source → env var omitted (optional ref), role fails closed at run time with its existing "no credential" message.
- Repointing the active provider's credential interrupts in-flight work (rollout) — reuse the existing restart-confirm Dialog.

## Testing

- **Pure unit (k8s):** `resolveCredentialSources` (annotations → map; single-owner; fallback to legacy; conflict ordering); `deployment()` renders `secretKeyRef` at the resolved name/key; managed Secret YAML carries the label + `credential.*` annotations.
- **Server:** `setCredentialSource` argv builder (annotate + sibling-clear + rollout) asserted via the command builder, **never executed against a live cluster** (per [[feedback_never_execute_mutation_endpoints_to_verify]]); `credentialStatus` returns ids+names only (no values, no logging); `listCredentialSecrets` returns names/key-names only.
- **Web:** source dialog (managed vs existing-Secret modes), Secret picker + key picker fetch and render, readiness display from the new shape; row resting state shows no raw Secret name.
- **RBAC:** existing "agent never gets secrets access" test stays green.

## Decisions & alternatives

- **Annotation-driven (chosen)** vs a `credentialRefs` map in `assistant-config` ConfigMap (rejected): the user asked for annotations; annotations are declarative, co-located with the Secret, and GitOps-friendly. The ConfigMap would duplicate state and drift from the Secret.
- **Install-time env templating (chosen)** vs agent runtime discovery (rejected): runtime discovery requires granting the agent secrets read, breaking the cage.
- **Single-owner per credential (chosen)** vs a precedence list (rejected): single-owner is unambiguous and matches the "point this credential at that Secret" mental model.

## Phasing

- **Phase 1 (decouple, no UX change):** `CREDENTIAL_ENV` table + `resolveCredentialSources` (with fallback) + stamp label/annotations on managed Secrets + `credentialStatus` uses resolution. Net effect: readiness is name-agnostic; nothing else changes. Low risk.
- **Phase 2 (BYO):** `setCredentialSource` + `listCredentialSecrets` + the source dialog + env re-render on repoint. This is the user-facing capability.
- **Phase 3 (optional):** `reconcileCredentialAnnotations` repair action + conflict surfacing UI.

## Risks / follow-ups

- Subscription-token auto-refresh staleness across pod restarts is unchanged (a static Secret holds a snapshot) — orthogonal to this feature.
- Operators pointing at a Secret whose value is wrong/expired: readiness shows "ready" (a value exists); runtime failure still surfaces via the agent's error path. Readiness asserts presence, not validity (same as today).
- If we later support multi-cluster Assistant installs, resolution becomes per-context.
