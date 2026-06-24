# BYO Credential Secrets — Phase 2: env templating + source picker

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox (`- [ ]`) tracking. Builds on Phase 1 (`resolveCredentialSources`, `CREDENTIAL_ENV`, the `rigel.assistant/credential-store` label + `rigel.assistant/credential.<id>` annotations).

**Goal:** Let an operator point a provider credential at an **existing Secret** they already manage. The agent Deployment's env is templated from the resolved sources; a source-picker dialog drives it; readiness now reports the backing Secret.

**Architecture:** `deployment()` renders the 7 credential env vars from a resolution (default = today's output, byte-identical). New server actions `setCredentialSource` (annotate chosen Secret single-owner → re-template Deployment → rollout) and `listCredentialSecrets` (names + key names only). `credentialStatus` returns per-credential `{ ready, secretName }`. A `CredentialSourceDialog` (designed in Pencil: frame `GGza6`) adds "Managed by Rigel" vs "Use an existing Secret" modes.

**Tech stack:** `packages/k8s` + `apps/server` (vitest), `apps/web` (React, vitest). Spec: `docs/superpowers/specs/2026-06-23-assistant-byo-credential-secrets-design.md`. Pencil source dialog: `GGza6` in `~/Desktop/clankerlocal.pen`.

**Invariants (do not break):**
- RBAC cage stays closed (agent never gets secrets access; the test stays green).
- Secret **values** never reach the client or logs — only credential ids, Secret names, data key names.
- Never run mutations against a live cluster — assert command builders / pure fns via tests; orchestration via fake kubectl.
- `deployment()` with no source overrides must be **byte-identical** to current output.

---

## Group A — Server (packages/k8s + apps/server)

### Task A1: `deployment()` templates credential env from resolution

**Files:** `packages/k8s/src/assistant.ts` (+ test)

- [ ] **Step 1 (test):** `deployment(config())` (no sources arg) is byte-identical to the pre-change output (snapshot the current env block first). `deployment(config(), { anthropicApiKey: { secretName: "my-sec", dataKey: "api-key", hasValue: true } })` → the `ANTHROPIC_API_KEY` env's `secretKeyRef` is `{ name: my-sec, key: api-key, optional: true }`, and the other six stay at their `CREDENTIAL_ENV` defaults.
- [ ] **Step 2:** Add a helper `credentialEnvYAML(sources: Partial<Record<keyof AssistantCredentials, ResolvedSource>> = {})` that, for each `CREDENTIAL_ENV` entry, emits the env block referencing `sources[id] ?? { secretName: defaultSecret, dataKey: defaultKey }` with `optional: true`. Replace the hardcoded 7 env blocks in `deployment()` with a call to it. Add an optional `sources` param to `deployment()` (default `{}`). Keep WORKER_MODEL/SUPERVISOR_MODEL/etc. env untouched and in the same order.
- [ ] **Step 3:** `pnpm --filter @rigel/k8s test` + `build` green. Commit.

### Task A2: pure command builders for repoint / clear

**Files:** `packages/k8s/src/assistant.ts` (+ test)

- [ ] **Step 1 (test):** For `credentialSourceCommands({ credentialId, secretName, dataKey }, currentSecrets)`:
  - emits `["label","secret",secretName,"rigel.assistant/credential-store=true","--overwrite","-n",ns]` and `["annotate","secret",secretName,"rigel.assistant/credential.<id>=<dataKey>","--overwrite","-n",ns]`.
  - for every OTHER credential-store Secret currently annotating `<id>`, emits a removal `["annotate","secret",sibling,"rigel.assistant/credential.<id>-","-n",ns]` (single-owner).
  - `clearCredentialSourceCommands(credentialId, currentSecrets)` removes the `<id>` annotation from EVERY credential-store Secret except the managed default, so resolution falls back to the default.
  (Pass `namespace` in; pure — returns `string[][]`, runs nothing.)
- [ ] **Step 2:** Implement both. Reuse the credential-store filter + annotation-prefix logic from `resolveCredentialSources`.
- [ ] **Step 3:** k8s test green. Commit.

### Task A3: `setCredentialSource` + `clearCredentialSource` actions

**Files:** `apps/server/src/assistant.ts` (+ test)

- [ ] **Step 1 (test, fake kubectl):** `setCredentialSource` with `{ credentialId, secretName, dataKey, namespace }`:
  - validates the Secret exists and has the data key (a `get secret -o json`, read **keys only**); errors clearly if missing — no mutation, no rollout.
  - runs the `credentialSourceCommands` (label/annotate chosen + sibling removals), then re-fetches secrets, `resolveCredentialSources`, applies `deployment(config, sources)`, then `rollout restart deployment/rigel-assistant`. Assert the call sequence + that the applied Deployment's `ANTHROPIC_API_KEY` (etc.) points at the chosen Secret. Assert no secret **values** appear in any output.
  - `clearCredentialSource` runs the clear commands + re-template + rollout.
- [ ] **Step 2:** Implement both handlers; add to the `AssistantAction` union + the dispatch switch. Extend `AssistantRequest` (server type) with `credentialId?`, `secretName?`, `dataKey?`. Reuse the existing `applyStdin`/`kubectl`/`rolloutRestart` helpers.
- [ ] **Step 3:** server test green. Commit.

### Task A4: `listCredentialSecrets` + `credentialStatus` shape change

**Files:** `apps/server/src/assistant.ts` (+ test)

- [ ] **Step 1 (test, fake kubectl):**
  - `listCredentialSecrets(ns)` → `{ secrets: [{ name, type, keys: string[] }] }` from `get secrets -n ns -o json`; **key names only, never values**; filters out `kubernetes.io/service-account-token` and `helm.sh/release.*` types to reduce noise.
  - `credentialStatus` now returns `{ credentials: { <id>: { ready: boolean, secretName: string } } }` (from `resolveCredentialSources`). Assert ready reflects `hasValue`, `secretName` is the resolved Secret, and **no values** leak.
- [ ] **Step 2:** Implement `listCredentialSecrets` + change `credentialStatus`'s return shape; add `listCredentialSecrets` to the action union + dispatch.
- [ ] **Step 3:** server test green. Commit. (NOTE: this breaks the web's current consumer — fixed in Group B; run web tests at the end of Group B, not here.)

---

## Group B — Web (apps/web)

### Task B1: api types + hooks

**Files:** `apps/web/src/lib/api.ts` (+ test if one exists)

- [ ] **Step 1:** Add types: `CredentialSourceStatus = { ready: boolean; secretName: string }`; `CredentialStatusResponse = { credentials: Partial<Record<keyof AssistantCredentials, CredentialSourceStatus>> }`; `CredentialSecret = { name: string; type: string; keys: string[] }`. Extend `AssistantRequest` with `credentialId?`, `secretName?`, `dataKey?`.
- [ ] **Step 2:** Add a `useCredentialSecrets(namespace)` query hook (POST `{ action: "listCredentialSecrets", namespace }`). `setCredentialSource`/`clearCredentialSource` go through the existing assistant `run()` mechanism (no new mutation hook needed).
- [ ] **Step 3:** `pnpm --filter web typecheck`.

### Task B2: parse the new credentialStatus shape

**Files:** `apps/web/src/panels/assistant/useAssistant.ts` (+ AssistantDerived type)

- [ ] **Step 1:** `credStatus` queryFn parses `{ credentials }` (was `credentialKeys`). Derive `d.creds` (readiness → the existing `AssistantCredentials` "set" sentinel map, so `credentialReady` keeps working) AND a new `d.credentialSources: Partial<Record<keyof AssistantCredentials, { ready; secretName }>>`. Keep using `credentialNamespace` (the Phase-1 namespace fix).
- [ ] **Step 2:** `pnpm --filter web typecheck`.

### Task B3: CredentialSourceDialog (built to Pencil `GGza6`)

**Files:** `apps/web/src/panels/assistant/agents/CredentialSourceDialog.tsx` (new) + test

- [ ] **Step 1:** A Dialog with a mode toggle (`SegmentedTabs`): "Managed by Rigel" (renders the existing paste-a-key editor / method toggle) vs "Use an existing Secret" (Secret picker from `useCredentialSecrets` + key picker of the chosen Secret's `keys`; a readout line "reads <ENV> from <secret> · <key>"). Footer: Cancel + "Save & restart". Names only — no values. Match the Pencil frame.
- [ ] **Step 2 (test):** existing-Secret mode lists secrets, picking a secret populates the key dropdown, confirm calls back with `{ credentialId, secretName, dataKey }`; managed mode shows the paste editor. No raw secret name shown in any non-dialog surface.
- [ ] **Step 3:** web test + typecheck green.

### Task B4: wire the dialog into CredentialsManager + readiness display

**Files:** `apps/web/src/panels/assistant/agents/CredentialsManager.tsx`, `tabs/AgentsTab.tsx` (+ tests)

- [ ] **Step 1:** Each row keeps the "Key ready/Not set" chip (now from `credentialSources[id].ready`) and gets a subtle **"Source"** control (the resting state shows NO raw Secret name). It opens `CredentialSourceDialog`. The paste-a-key path stays (managed mode). The existing-Secret confirm routes through `run({ action: "setCredentialSource", credentialId, secretName, dataKey, namespace })` behind the existing restart-confirm Dialog (it rolls the agent); "Use Rigel-managed" routes through `clearCredentialSource`.
- [ ] **Step 2 (test):** update `CredentialsManager.test`/`AgentsTab.test` for the new readiness source (`d.credentialSources`) and the source dialog open/confirm → correct `run` payload.
- [ ] **Step 3:** `pnpm --filter web test` + `typecheck` green.

---

## Task C: Full verification
- [ ] `pnpm --filter @rigel/k8s test`, `pnpm --filter @rigel/server test`, `pnpm --filter web test`, `npm --prefix agent test` — all green.
- [ ] `pnpm --filter @rigel/k8s build`, `pnpm --filter @rigel/server typecheck`, `pnpm --filter web typecheck` clean.
- [ ] Re-confirm `deployment(config())` (no overrides) is byte-identical to pre-Phase-2 and the RBAC-no-secrets test passes.

## Out of scope (Phase 3)
- `reconcileCredentialAnnotations` repair action for old installs; conflict-surfacing UI; choosing a BYO Secret during first install (Phase 2 keeps BYO a post-install action).
