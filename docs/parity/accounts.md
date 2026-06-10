# Accounts Panel — Registry Credentials

Helmsman manages pull credentials for container image registries (Docker Hub, ghcr.io, quay.io, custom registries) to support authenticated pulls and avoid rate limits in catalog installs.

## Domain Model

### RegistryAccount
A user-managed registry credential with metadata:
- `id` (UUID) — client-side identifier for state management
- `registry` (string) — registry hostname: `docker.io`, `ghcr.io`, `quay.io`, or a custom FQDN
- `username` (string) — username for the registry
- `secretName` (string) — Kubernetes Secret name (e.g., `helmsman-dockerhub`)
- `sourceNamespace` (string) — namespace where the Secret lives (default `default`)
- `managed` (boolean) — `true` = Helmsman created the Secret; `false` = referenced existing
- `isDefault` (boolean) — auto-attached to installs; max 1 per context

### Storage & Transport
- **Swift:** Metadata persisted per kube-context in `SessionStore`; Secret (with credentials) lives in cluster via `macOS Keychain` reference (only on the machine that created it)
- **Web:** NO local persistence. Metadata stored in `users` ONLY for display state (e.g., which is default). The credential is ALWAYS materialized as a **kubernetes.io/dockerconfigjson Secret** in the cluster (the standard imagePullSecret), allowing any pod to reference it without local storage.

### Security Invariant
**Passwords/tokens MUST NEVER be:**
- Logged (even at debug level)
- Shown unmasked in preview UI
- Returned in API responses
- Persisted to disk (web) or anything other than the Secret itself

Passwords exist ONLY in:
1. The user input field (masked as SecureField/password input)
2. Briefly in memory during Secret generation
3. The applied cluster Secret (base64 `.dockerconfigjson`)

---

## Kubernetes Secret Format (dockerconfigjson)

The credential is stored as a standard Kubernetes pull Secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: <secretName>
  namespace: <sourceNamespace>
  labels:
    app.kubernetes.io/managed-by: helmsman
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: <base64-encoded JSON>
```

The `.dockerconfigjson` value is base64-encoded JSON:
```json
{
  "auths": {
    "<registry-key>": {
      "username": "<username>",
      "password": "<token>",
      "auth": "<base64(username:token)>"
    }
  }
}
```

**Docker Hub Quirk:** The registry key for `docker.io` (or `index.docker.io` / `registry-1.docker.io`) is always normalized to the canonical `https://index.docker.io/v1/`.

---

## UI Panel — AccountsPanel

### List View
- **Columns:**
  - Icon (shippingbox.fill)
  - Registry hostname (monospace, bold)
  - "default" badge (if `isDefault == true`)
  - "referenced" label (muted, if `managed == false`)
  - Username (secondary gray) + Secret name + namespace (secondary gray, monospace)
  - Actions: "Set default" button (visible if not already default), delete trash icon

- **Empty State:** "No accounts yet. Add a Docker Hub (or ghcr/quay) account so installs pull authenticated and avoid rate limits."

- **Sort/Filter:** None. Accounts list in creation order.

### Add Account (Sheet / Modal)
Two modes (segmented picker):

#### Mode 1: Create (default)
Build and apply a new Secret to the cluster.

**Form Fields:**
- Registry (text input, default: `docker.io`)
- Username (text input)
- Access Token (SecureField, required to submit)
- Secret Name (text input, default: `helmsman-dockerhub`)
- Namespace (text input, default: `default`)
- "Use as the default for installs" (toggle)

**Validation:**
- Registry, Secret Name, Namespace are non-empty (whitespace-trimmed)
- Access Token is non-empty (only in Create mode)
- Secret Name must be a valid DNS-1123 subdomain (optional RFC check; server will reject if invalid)

**Preview:**
Before applying, show a preview of the Secret YAML (mask the `.dockerconfigjson` value as `[hidden]`):
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: <secretName>
  namespace: <namespace>
  labels:
    app.kubernetes.io/managed-by: helmsman
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: [hidden]
```

**On Submit:**
1. Call `/api/apply` with the full Secret manifest (password unmasked in the JSON sent to server)
2. On success, add the account metadata to the list
3. If "Use as default" was checked (or list was empty), mark this as `isDefault=true` and unset others
4. Close the sheet

**Error States:**
- kubectl apply failed: show `stderr` message in red below the form
- Validation: inline field error messages (e.g., "Registry cannot be empty")

#### Mode 2: Reference Existing
Reference an already-existing Secret in the cluster (e.g., created by a different tool).

**Form Fields:**
- Registry (text input)
- Username (text input; can be empty — is metadata only)
- Secret Name (text input, required)
- Namespace (text input, default: `default`)
- "Use as the default for installs" (toggle)

**Validation:**
- Registry, Secret Name, Namespace are non-empty

**On Submit:**
1. Verify the Secret exists via `kubectl get secret <secretName> -n <namespace>` (read-only probe)
2. On success, add the account metadata to the list
3. If "Use as default" was checked, mark this as `isDefault=true` and unset others
4. Close the sheet

**Error States:**
- Secret not found: show error in red below the form
- kubectl probe failed: show stderr

---

## User Actions

### List Actions

#### Set Default
- **Trigger:** "Set default" button on an account row
- **Effect:** Mark this account as `isDefault=true`; unset `isDefault=true` on all others
- **kubectl:** None (metadata only, stored in cluster account list / state)
- **Confirm:** Implicit (no sheet)

#### Delete Account
- **Trigger:** Trash icon on an account row
- **Confirm Sheet:** "Remove account?" with the account registry + username shown
  - Shows: "This removes the account from Helmsman's list. The Secret will remain in the cluster (use the Secrets panel to delete it if needed)."
- **On Confirm:**
  - Remove from account list
  - NO kubectl delete (the Secret stays in the cluster for manual cleanup or reuse)
- **kubectl:** None

---

## Panel Subscriptions

The panel subscribes to `secrets` in the currently-scoped namespace (or all namespaces if no filter):

```typescript
subscribe('secrets', namespaceFilter)
```

Secrets with `type == "kubernetes.io/dockerconfigjson"` are read from the watch store and displayed as registry accounts if they carry the label `app.kubernetes.io/managed-by=helmsman` (optional filtering; the panel shows all dockerconfigjson secrets in the namespace).

---

## Backend Routes (Reused)

### POST /api/apply
Existing route. Used for all Secret creation + updates.

**Request:**
```json
{
  "yaml": "<multi-doc YAML>"
}
```

**Response:**
```json
{
  "code": 0,
  "stdout": "secret/helmsman-dockerhub created",
  "stderr": ""
}
```

### DELETE Resource (via action-block)
Existing `deleteResource` action kind (not used for accounts, but available for manual Secret cleanup elsewhere in the app).

---

## Implementation Checklist

### Web Modules

#### 1. `packages/k8s/src/dockerconfigjson.ts` (Pure Builder + Parser)

**TDD Tests:**
- Build a single-registry `.dockerconfigjson` with `username:password` → encode `auth` field correctly
- Multi-registry payload (merge multiple registries into one Secret)
- Docker Hub hostname normalization (`docker.io` → `https://index.docker.io/v1/`)
- Parse an existing `.dockerconfigjson` back to `{registry, username}` for display
- Validate username/registry fields (non-empty, no slashes in registry hostname)

**Exports:**
```typescript
export interface RegistryCredential {
  registry: string;
  username: string;
  password: string;
  email?: string;
}

export interface DockerConfigJsonData {
  auths: Record<string, { username: string; password: string; auth: string; email?: string }>;
}

export function buildDockerConfigJson(
  registry: string,
  username: string,
  password: string,
  email?: string,
): string;

export function dockerconfigjsonToSecret(
  registry: string,
  username: string,
  password: string,
  secretName: string,
  namespace: string,
  email?: string,
): KubernetesSecret;

export function parseDockerConfigJson(jsonString: string): DockerConfigJsonData;

export function extractRegistryFromSecret(secret: KubernetesSecret): {
  registry: string;
  username: string;
} | null;
```

#### 2. Web UI: `apps/web/src/panels/accounts/AccountsPanel.tsx`

**Imports:**
- `useCluster` from store
- `subscribe`/`unsubscribe` for secrets
- React hooks (`useState`, `useEffect`)
- shadcn UI: `Sheet`, `Button`, `Input`, `Label`, `Toggle`, `Table`, etc.
- Utility helpers from the module

**State:**
- `accountList` — derived from dockerconfigjson secrets in the watch store
- `isDefault` — tracks which account is marked default (local state)
- `showAddSheet` — modal open/close
- `addMode` — "create" or "reference"
- Form fields (registry, username, password, secretName, namespace, makeDefault)
- `errorMessage` — display on form failure
- `busy` — show spinner during apply

**Layout:**
- Title + description + "Add account" button
- Empty state OR table/list of accounts
- Add/Edit sheet (modal)
- Delete confirm sheet

**On Mount:**
- Subscribe to `secrets` in namespaceFilter
- Filter to dockerconfigjson type
- Map to account list

**On Unmount:**
- Unsubscribe

#### 3. Web Test: `apps/web/src/panels/accounts/accounts.test.tsx` (vitest)

- List accounts from dockerconfigjson secrets
- Add new account via /api/apply
- Set default account
- Delete account (remove from list, confirm sheet)
- Error states (bad registry hostname, existing Secret not found)
- Password masking in preview
- Form validation (empty fields, required token in create mode)

#### 4. Server Route (Optional)

If the existing `/api/apply` route does NOT support dockerconfigjson Secrets directly (i.e., it only handles catalog manifests), add a new route:

```typescript
POST /api/registry-secret
{
  "registry": "docker.io",
  "username": "...",
  "password": "...",
  "secretName": "...",
  "namespace": "...",
  "email": "..."
}
```

**Response:**
```json
{
  "code": 0,
  "stdout": "secret/helmsman-dockerhub created",
  "stderr": ""
}
```

Otherwise, reuse `/api/apply` by sending the full Secret YAML in the `yaml` field.

### Integration with Catalog Installs

When the Catalog wizard runs an install in a namespace:
1. Check if `isDefault == true` for any account
2. If yes, ensure the Secret is replicated to the install namespace (via reconciler logic or init copy)
3. Add the Secret name to the install's `imagePullSecrets` array on any Pods/Deployments

(This is part of the catalog installer, not the Accounts panel itself.)

---

## Testing & Verification

**Unit Tests (TDD first):**
- `packages/k8s/src/dockerconfigjson.test.ts` — builder, parser, normalization
- `packages/k8s/src/dockerconfigjson.test.ts` — multi-registry merge
- `apps/web/src/panels/accounts/accounts.test.tsx` — list, add, delete, default, error states

**Integration:**
- Full typecheck: `pnpm -r typecheck`
- Web build: `pnpm --filter web build`
- Web test: `pnpm --filter web test` (accounts tests pass)
- Server test: `pnpm --filter @helmsman/server test`
- k8s module test: `pnpm --filter @helmsman/k8s test`

**Acceptance:**
1. Panel is registered in `App.tsx` and appears in the nav
2. List view shows registry accounts (dockerconfigjson secrets) with hostname + username
3. Passwords are never displayed unmasked in preview or list
4. Add form (both modes) validates, previews without password, and applies via `/api/apply`
5. Delete removes account from list and shows confirmation
6. Set default marks one account as default (unsets others)
7. WebSocket watch updates the panel when new Secrets are created/updated
8. No new npm dependencies (use existing shadcn + Tailwind)

---

## Hard Constraints

1. **No password logging:** Zero log statements containing token/password values
2. **No password in preview:** YAML preview shows `[hidden]` for `.dockerconfigjson`
3. **Cluster-native:** Every account is stored as a kubernetes.io/dockerconfigjson Secret in the cluster
4. **No local disk persistence (web):** Metadata stored ONLY in the watch store + client state
5. **Guarded delete:** Delete action requires a confirm sheet
6. **Cluster writes via kubectl:** All mutations go through `/api/apply` or `/api/action` (no in-cluster client library)
7. **Reuse existing routes:** Prefer `/api/apply` for Secret creation; use `deleteResource` action for deletes
8. **No new npm deps:** Only shadcn/ui + existing Tailwind
