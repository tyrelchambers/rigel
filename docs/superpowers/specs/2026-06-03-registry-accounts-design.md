# Registry accounts — design

## Context

Installing catalog apps pulls many images from Docker Hub (the app plus bundled
`postgres`/`redis`/etc.). Anonymous pulls hit Docker Hub's rate limit (HTTP 429,
100 pulls / 6h per IP), which broke a live Outline install. Today Helmsman has no
way to manage registry credentials: `SelfHostDefaults.imagePullSecret` is just the
*name* of a Secret the user created by hand, and Helmsman never creates it. We want
a first-class "accounts" feature — starting with registry/pull credentials — so the
user can add a Docker Hub (or ghcr/quay/private) account in-app and have it applied
to installs automatically.

This spec covers **registry accounts only**. The data model is designed so other
account types (git, SMTP, OIDC) can be added later, but none are built now.

## Decisions (from brainstorming)

- **Scope:** registry/pull credentials first; extensible model, no other types yet.
- **Storage:** *create-or-reference*. The **cluster** holds the secret; Helmsman
  persists only non-secret metadata. No macOS Keychain / OS keystore / local crypto —
  keeps the app portable (possible Linux/headless future). The token exists only
  transiently in the add-form, then lives in a cluster `dockerconfigjson` Secret.
- **Attachment:** ensure the Secret exists in the install's target namespace, then
  patch that namespace's `default` ServiceAccount `imagePullSecrets` (covers every pod
  in the install — app + bundled datastores — and future pods).
- **Binding:** one account per kube-context is the **default**, attached to installs
  automatically; overridable per install.
- **Resolved open questions:** (a) a **dedicated Accounts panel** (`PanelKind.accounts`),
  not a section inside Settings. (b) A configured default account **supersedes** the
  manual `SelfHostDefaults.imagePullSecret`; with no accounts, the existing field's
  behavior is unchanged (backward compatible).

## Architecture

Four units, each independently testable:

### 1. `RegistryAccount` (model) + per-context persistence
New type stored per kube-context in `SessionStore.Storage` (a new
`registryAccountsByContext: [String: [RegistryAccount]]?`, lenient-decoded like the
other maps so old `sessions.json` files keep working):

```swift
struct RegistryAccount: Codable, Hashable, Identifiable {
    let id: UUID
    var registry: String         // "docker.io", "ghcr.io", "quay.io", or custom host
    var username: String
    var secretName: String       // k8s Secret name, e.g. "helmsman-dockerhub"
    var sourceNamespace: String  // where the Secret lives (default "default")
    var managed: Bool            // true = Helmsman created it; false = referenced existing
    var isDefault: Bool          // the account auto-attached to installs (≤1 per context)
}
```

No token field — the credential is never persisted locally. `SessionStore` gets
`registryAccounts(for:)`, `setRegistryAccounts(_:for:)`, and a `setDefaultAccount`
helper that enforces the ≤1-default invariant.

### 2. `RegistryCredentialBuilder` (pure)
Builds the `.dockerconfigjson` payload from `(registry, username, token)`:
`{"auths":{"<key>":{"username":..,"password":..,"auth":base64("user:token")}}}`.
Encapsulates Docker Hub's quirk: when `registry == "docker.io"`/empty, the auths key
must be `https://index.docker.io/v1/`. Pure and unit-tested; holds no state.

### 3. `RegistryAccountReconciler` (cluster side effects)
Translates account operations into `WorkloadCommander` calls (reusing the existing
`Secret.draft(type: .dockerconfigjson)` → `applySecret` path and kubectl plumbing):

- `create(account, token)` → build payload → `Secret.draft` → `applySecret` into
  `sourceNamespace`. Returns the created `RegistryAccount` (metadata only).
- `ensureAccess(account, namespace)` (called at install time):
  1. **Ensure Secret in target ns** — if `namespace != sourceNamespace`, read the
     Secret (`kubectl get secret <name> -n <source> -o json`), strip
     `resourceVersion`/`uid`/`creationTimestamp`/`namespace`, re-apply into the target
     (`kubectl apply -f -`). A new `WorkloadAction.copySecret(name, from, to)` (mirrors
     the existing `moveSecret`).
  2. **Patch the `default` SA** — read its current `imagePullSecrets`, compute the
     **union** with `secretName` client-side, then send the *complete* unioned list via
     `kubectl patch serviceaccount default -n <target> --type=merge` (a JSON merge patch
     replaces the array, so we must write the full set, not just our entry). Idempotent;
     never clobbers entries already present.
- `verifyReference(secretName, namespace)` → `kubectl get secret -o name`; confirm it
  exists (and, best-effort, that its type is `kubernetes.io/dockerconfigjson`).

### 4. `AccountsPanel` + `AccountsViewModel` (UI)
A new panel under the "System" nav group (`PanelKind.accounts`). Lists the current
context's registry accounts (registry, username, default badge), with:
- **Add account** sheet: mode toggle *Create* vs *Reference*. Create = registry picker
  (Docker Hub / ghcr / quay / custom host) + username + token (SecureField) + optional
  secret name (defaulted, e.g. `helmsman-<registry-slug>`) + source namespace.
  Reference = registry + existing secret name + namespace.
- Row actions: Set as default, Edit (metadata; re-enter token to rotate a managed
  account), Delete (managed delete offers to also remove the cluster Secret).

## Data flow

```
Add (create):   form(registry,user,token) -> CredentialBuilder -> Secret.draft
                  -> applySecret(sourceNs) -> store RegistryAccount(managed:true)
                  -> token dropped from memory
Add (reference): form(registry,secretName,ns) -> verifyReference
                  -> store RegistryAccount(managed:false)
Install apply:  selected account (default or override, or none)
                  -> ensureAccess(account, targetNs)
                       1. copySecret(source -> target) if needed
                       2. patch default SA imagePullSecrets (union)
                  -> normal apply (baked or LLM path) proceeds
```

The install wizard gains a "Pull credentials" control on the Configure (or Review)
step: shows the context default with an override dropdown (default / other account /
none). The selected account drives `ensureAccess` immediately before `runApply`.

## Error handling

- **No cluster reachable** at add-time (create): surface the `applySecret` stderr; the
  account is not stored (don't record metadata for a Secret that wasn't created).
- **Reference not found / wrong type:** block save with the kubectl error.
- **`ensureAccess` fails mid-install:** fail the install step with the kubectl error
  (same `.failed` path the wizard already uses) — never proceed to apply assuming auth.
- **SA patch union:** read-modify-write; if the SA read fails, fail loudly rather than
  overwrite. Adding an already-present secret name is a no-op.
- **Delete of a managed account:** removing the cluster Secret won't retroactively
  un-patch SAs that reference it; note this in the confirm dialog (pods already
  scheduled are unaffected; new pulls in namespaces still referencing it will fail).

## Security & portability

- The token never persists on the app's disk — only in memory during entry, then in
  the cluster Secret. No local encryption is needed because nothing secret is stored
  locally.
- No Keychain / Secret Service / Credential Manager / DIY crypto → no platform lock-in;
  Linux/headless remains viable.
- The *reference* path keeps Helmsman entirely out of the credential path.
- `sessions.json` stores only non-secret metadata (registry, username, secret name,
  namespace, flags) — consistent with what it stores today.

### Encryption / exposure (must-handle)

- **At rest in the cluster:** a Kubernetes Secret is base64-encoded, **not encrypted**.
  Anyone with `kubectl get secret -o yaml` + RBAC (or etcd access) can read the token.
  This is inherent to k8s pull secrets, not specific to this feature. Real at-rest
  protection is the *cluster's* responsibility (etcd encryption-at-rest, or
  sealed-secrets / External Secrets) — out of Helmsman's control. **Surface a one-line
  note in the Accounts UI**: "Stored as a standard Kubernetes Secret (base64 in etcd)."
- **Never log the secret payload (code constraint):** `ensureAccess`'s cross-namespace
  copy runs `kubectl get secret -o json`, whose stdout contains the base64 token.
  `WorkloadCommander` captures that stdout — it must be handled in memory only and
  **never** appended to `applyLog`, the wizard transcript, or any user-visible surface.
  Applies to referenced accounts too (the copy still reads the content). The reconciler
  returns success/failure, not the secret body.
- **In transit:** token reaches the cluster via `kubectl apply` over the kube API's TLS
  and a local in-memory stdin pipe — standard, no extra handling.
- Not in scope: zeroing the token from process memory (overkill for a single-user app).

## Testing

- `RegistryAccount` Codable round-trip; lenient decode of an old `sessions.json`
  (missing `registryAccountsByContext`); `setDefaultAccount` enforces ≤1 default.
- `RegistryCredentialBuilder`: correct `auths` structure + base64 `auth`; Docker Hub
  maps to `https://index.docker.io/v1/`; ghcr/quay/custom map to their host verbatim.
- SA-patch **union** logic: existing `imagePullSecrets` preserved; adding a present
  name is a no-op; empty start works.
- `copySecret` planned `KubectlInvocation`s strip the right metadata and target the new
  namespace (same assertion style as existing `WorkloadAction` tests).
- Wizard binding: a selected account yields the expected `ensureAccess` invocations
  before apply; "none" yields none.
- Backward compatibility: with zero accounts, install behavior and the existing
  `SelfHostDefaults.imagePullSecret` path are unchanged.

## Out of scope (future)

- Live credential verification (a real registry auth probe at add-time).
- Non-registry account types (git, SMTP, OIDC) — model is shaped to extend.
- Per-install explicit pod-spec `imagePullSecrets` as an alternative to the SA patch.
- Auto-reconciling the pull secret into *every* existing namespace (we ensure it only
  in namespaces we install into).
