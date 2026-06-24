# BYO Credential Secrets — Phase 3: reconcile legacy installs + surface conflicts

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox (`- [ ]`) tracking. Builds on Phases 1–2 (`resolveCredentialSources`, `CREDENTIAL_ENV`, the `credential-store` label + `rigel.assistant/credential.<id>` annotations, `credentialStatus` → per-credential `{ ready, secretName }`, `setCredentialSource`/`clearCredentialSource`).

**Goal:** (1) A safe, idempotent **reconcile** action that stamps the new label + annotations onto a legacy install's managed Secrets (so resolution is annotation-driven, not just fallback) — surfaced in the UI only when needed. (2) **Surface conflicts** (a credential claimed by >1 Secret) on the affected rows.

**Architecture:** Reconcile only stamps credentials currently resolved via the *legacy fallback* (never an annotation-claimed id), so it can never create a conflict. `credentialStatus` additionally reports `conflicts` + `needsReconcile`. Reconcile changes Secret metadata only (no Deployment change, **no rollout**). The UI shows a per-row conflict warning and a "Repair credential labels" button when `needsReconcile`.

**Tech stack:** `packages/k8s` + `apps/server` + `apps/web` (vitest). Spec: `docs/superpowers/specs/2026-06-23-assistant-byo-credential-secrets-design.md`.

**Invariants:** RBAC cage untouched; secret values never reach the client/logs (ids + Secret names + key names only); no live-cluster mutations in tests (assert builders / fake kubectl); reconcile is idempotent + never creates a conflict + never changes a value.

---

### Task A1: `reconcileCommands` + `needsReconcile` (pure, k8s)

**Files:** `packages/k8s/src/assistant.ts` (+ test)

- [ ] **Step 1 (test):** For `reconcileCommands(secrets, namespace)`:
  - The set of **annotation-claimed** ids = every `rigel.assistant/credential.<id>` on a credential-store Secret.
  - For each `CREDENTIAL_ENV` entry whose **default Secret exists, has the default key, and whose id is NOT annotation-claimed** (i.e. currently resolved by fallback), emit `["label","secret",<defaultSecret>,"rigel.assistant/credential-store=true","--overwrite","-n",ns]` (once per Secret) and `["annotate","secret",<defaultSecret>,"rigel.assistant/credential.<id>=<defaultKey>","--overwrite","-n",ns]`.
  - Already-stamped ids (annotation-claimed) and absent Secrets/keys produce NO commands (idempotent; conflict-safe). Two ids on the same default Secret share a single `label` command.
  - `needsReconcile(secrets)` returns `reconcileCommands(secrets, "x").length > 0`.
- [ ] **Step 2:** Implement both, reusing the credential-store filter + annotation-prefix helpers. Export them; re-export from `index.ts`.
- [ ] **Step 3:** `pnpm --filter @rigel/k8s test` + `build` green. Commit.

### Task A2: `reconcileCredentialAnnotations` action + conflicts/needsReconcile in status (server)

**Files:** `apps/server/src/assistant.ts` (+ test)

- [ ] **Step 1 (test, fake kubectl):**
  - `credentialStatus` now returns `{ credentials, conflicts, needsReconcile }` — `conflicts` from `resolveCredentialSources(...).conflicts`, `needsReconcile` from `needsReconcile(items)`. Still names/ids only.
  - `reconcileCredentialAnnotations(context, ns, run)`: list managed Secrets, run `reconcileCommands`, `ensureOk` each, return a `{ stamped: <count> }` summary. NO Deployment apply, NO rollout. Idempotent (no commands → succeeds, no-op). Assert no secret values appear.
- [ ] **Step 2:** Implement; add `reconcileCredentialAnnotations` to the `AssistantAction` union + dispatch. Reuse `listSecretsBy` + `MANAGED_SECRETS_ARGS`.
- [ ] **Step 3:** `pnpm --filter @rigel/server test` green. Commit.

### Task B1: api + useAssistant parse (web)

**Files:** `apps/web/src/lib/api.ts`, `apps/web/src/panels/assistant/useAssistant.ts`

- [ ] **Step 1:** Extend `CredentialStatusResponse` with `conflicts?: (keyof AssistantCredentials)[]` and `needsReconcile?: boolean`. Add `reconcileCredentialAnnotations` to the `AssistantAction` union.
- [ ] **Step 2:** `useAssistant` parses both → `d.credentialConflicts: (keyof AssistantCredentials)[]` and `d.credentialNeedsReconcile: boolean` on `AssistantDerived`.
- [ ] **Step 3:** `pnpm --filter web typecheck`.

### Task B2: conflict warning + Repair button (web)

**Files:** `apps/web/src/panels/assistant/agents/CredentialsManager.tsx`, `tabs/AgentsTab.tsx` (+ tests)

- [ ] **Step 1:** A row whose id ∈ `credentialConflicts` shows an amber warning marker with a title/tooltip: "More than one Secret claims this credential; the alphabetically-first is used. Repair to fix." When `credentialNeedsReconcile`, the Credentials card shows a subtle "Repair credential labels" button (NOT behind the restart-confirm — reconcile doesn't roll the agent) that calls `run({ action: "reconcileCredentialAnnotations", namespace })` and invalidates the `credentialStatus` query.
- [ ] **Step 2 (test):** a conflicting id renders the warning; the Repair button appears only when `needsReconcile` and dispatches the right `run` payload (no restart-confirm).
- [ ] **Step 3:** `pnpm --filter web test` + `typecheck` green.

### Task C: Full verification
- [ ] `pnpm --filter @rigel/k8s test`, `pnpm --filter @rigel/server test`, `pnpm --filter web test`, `npm --prefix agent test` — all green.
- [ ] `pnpm --filter @rigel/k8s build`, `pnpm --filter @rigel/server typecheck`, `pnpm --filter web typecheck` clean.
- [ ] Confirm reconcile is conflict-safe (only stamps fallback-resolved ids) and changes no Deployment/value; RBAC-no-secrets test still green.

## Out of scope
- Choosing a BYO Secret during first install (still a post-install action).
