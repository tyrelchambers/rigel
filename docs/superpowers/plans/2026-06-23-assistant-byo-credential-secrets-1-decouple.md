# BYO Credential Secrets — Phase 1: decouple readiness from Secret names

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Make the Assistant's credential readiness resolve through Secret **annotations + a label**, not hardcoded Secret names — with a legacy fallback so existing installs keep working. **Zero web/UX change** this phase (the readiness chips look identical).

**Architecture:** Introduce a canonical credential→env table and a pure `resolveCredentialSources()` in `packages/k8s`. Stamp a discovery label + per-credential annotations on the managed Secrets. Rewrite the server's `credentialStatus` to list managed Secrets and resolve readiness via that function, still returning the existing `credentialKeys: string[]` shape so the web is untouched.

**Tech stack:** TypeScript; `packages/k8s` (`@rigel/k8s`, vitest), `apps/server` (`@rigel/server`, vitest). Spec: `docs/superpowers/specs/2026-06-23-assistant-byo-credential-secrets-design.md`.

**Conventions:**
- Discovery label: `rigel.assistant/credential-store: "true"`
- Per-credential annotation: `rigel.assistant/credential.<credentialId>: "<dataKey>"`
- Credential ids: `claudeToken, anthropicApiKey, codexApiKey, codexAuthContent, geminiApiKey, opencodeApiKey, opencodeAuthContent`
- Verify mutations via builders/tests only — never run against a live cluster.

---

### Task 1: Canonical credential→env table + credential id list

**Files:**
- Modify: `packages/k8s/src/assistant.ts`
- Test: `packages/k8s/src/assistant.test.ts`

- [ ] **Step 1:** Add an exported ordered table mapping each credential id to its env var and its default managed source (Secret name + data key). Mirror today's Deployment env exactly:

```ts
/** Canonical provider credential → the agent env var it feeds + its default
 *  managed source. The single source of truth for resolution + env render. */
export interface CredentialEnvEntry {
  id: keyof AssistantCredentials;
  env: string;
  defaultSecret: string; // SECRET_NAME for claudeToken, else CREDENTIALS_SECRET_NAME
  defaultKey: string;    // data key in the default Secret
}
export const CREDENTIAL_ENV: CredentialEnvEntry[] = [
  { id: "claudeToken",        env: "CLAUDE_CODE_OAUTH_TOKEN", defaultSecret: SECRET_NAME,             defaultKey: "token" },
  { id: "anthropicApiKey",    env: "ANTHROPIC_API_KEY",       defaultSecret: CREDENTIALS_SECRET_NAME, defaultKey: "anthropicApiKey" },
  { id: "codexApiKey",        env: "CODEX_API_KEY",           defaultSecret: CREDENTIALS_SECRET_NAME, defaultKey: "codexApiKey" },
  { id: "codexAuthContent",   env: "CODEX_AUTH_CONTENT",      defaultSecret: CREDENTIALS_SECRET_NAME, defaultKey: "codexAuthContent" },
  { id: "geminiApiKey",       env: "GEMINI_API_KEY",          defaultSecret: CREDENTIALS_SECRET_NAME, defaultKey: "geminiApiKey" },
  { id: "opencodeApiKey",     env: "OPENCODE_API_KEY",        defaultSecret: CREDENTIALS_SECRET_NAME, defaultKey: "opencodeApiKey" },
  { id: "opencodeAuthContent",env: "OPENCODE_AUTH_CONTENT",   defaultSecret: CREDENTIALS_SECRET_NAME, defaultKey: "opencodeAuthContent" },
];
export const CREDENTIAL_STORE_LABEL = "rigel.assistant/credential-store";
export const CREDENTIAL_ANNOTATION_PREFIX = "rigel.assistant/credential.";
```

- [ ] **Step 2 (test):** assert `CREDENTIAL_ENV` has all 7 ids, the env names match the existing Deployment (`deployment(config())` contains each `name: <env>`), and `claudeToken` is the only entry whose `defaultSecret` is `SECRET_NAME`.
- [ ] **Step 3:** `pnpm --filter @rigel/k8s test` green. Commit.

---

### Task 2: `resolveCredentialSources()` pure function

**Files:**
- Modify: `packages/k8s/src/assistant.ts`
- Test: `packages/k8s/src/assistant.test.ts`

- [ ] **Step 1 (test first):** Write tests for a new `resolveCredentialSources(secrets)`:
  - A Secret labelled `rigel.assistant/credential-store=true` with annotation `rigel.assistant/credential.anthropicApiKey: "api-key"` and `data: { "api-key": "x" }` → resolves `anthropicApiKey` to `{ secretName, dataKey: "api-key", hasValue: true }`.
  - Empty data value → `hasValue: false`.
  - **Legacy fallback:** a Secret named `CREDENTIALS_SECRET_NAME` with `data.codexApiKey` but NO annotations → resolves `codexApiKey` via the default key; `SECRET_NAME` with `data.token` → resolves `claudeToken`.
  - Annotation **wins** over legacy when both present.
  - Two credential-store Secrets annotating the same id → alphabetically-first by Secret name wins; the id appears in `conflicts`.
  - Unknown `rigel.assistant/credential.<garbage>` annotation ignored.

- [ ] **Step 2:** Implement:

```ts
export interface ResolvedSource { secretName: string; dataKey: string; hasValue: boolean }
export interface CredentialResolution {
  sources: Partial<Record<keyof AssistantCredentials, ResolvedSource>>;
  conflicts: (keyof AssistantCredentials)[];
}
export function resolveCredentialSources(secrets: SecretLike[]): CredentialResolution { /* annotations first (single-owner, alpha order, conflicts[]), then CREDENTIAL_ENV defaults to fill gaps; hasValue = non-empty data[dataKey] */ }
```

  (Define a minimal local `SecretLike { metadata:{name,labels?,annotations?}; data?:Record<string,string> }` if one isn't already exported.)

- [ ] **Step 3:** `pnpm --filter @rigel/k8s test` green. Commit.

---

### Task 3: Stamp label + annotations on the managed Secrets

**Files:**
- Modify: `packages/k8s/src/assistant.ts` (`secretYAML`, `credentialsSecretYAML`)
- Test: `packages/k8s/src/assistant.test.ts`

- [ ] **Step 1 (test):** `secretYAML(...)` contains `rigel.assistant/credential-store: "true"` and `rigel.assistant/credential.claudeToken: "token"`. `credentialsSecretYAML({...all keys...})` contains `credential-store` and a `rigel.assistant/credential.<id>: "<id>"` annotation for **each key actually written** (don't annotate absent keys). An empty creds map still produces a valid Secret with the label.
- [ ] **Step 2:** Add the label to both Secrets' `metadata.labels` and emit the per-credential annotations (derive each from `CREDENTIAL_ENV`'s `defaultKey`). Keep existing `app.kubernetes.io/managed-by` + `token-issued-at`.
- [ ] **Step 3:** Update the existing YAML tests that assert metadata if needed. `pnpm --filter @rigel/k8s test` green. Commit.

---

### Task 4: `credentialStatus` resolves via label + annotations (web unchanged)

**Files:**
- Modify: `apps/server/src/assistant.ts` (`credentialStatus`)
- Test: `apps/server/src/assistant.test.ts`

- [ ] **Step 1 (test):** Drive `credentialStatus` with a fake `kubectl` that returns a Secret list (label-selected) and assert the JSON output still has `credentialKeys: string[]` containing the ids whose `hasValue` is true — including via the legacy fallback path (a managed credentials Secret with no annotations) and the legacy token Secret (`token`→`claudeToken`). Assert **no secret values** appear in the output.
- [ ] **Step 2:** Replace the two fixed `get secret <name>` calls with one `get secrets -l app.kubernetes.io/managed-by=rigel-assistant -n <ns> -o json` (covers both managed Secrets for fallback + any credential-store-labelled), parse `.items`, run `resolveCredentialSources`, and return `{ credentialKeys: <ids with hasValue> }`. Keep returning ONLY ids (never values). Keep `normalizeCredentialKeys` for any remaining legacy callers or delete it if now unused (check references first).
- [ ] **Step 3:** `pnpm --filter @rigel/server test` green. Commit.

---

### Task 5: Full verification

- [ ] **Step 1:** `pnpm --filter @rigel/k8s test`, `pnpm --filter @rigel/server test`, `pnpm --filter web test`, `npm --prefix agent test` — all green (web/agent unchanged but confirm no breakage).
- [ ] **Step 2:** `pnpm --filter @rigel/k8s build`, `pnpm --filter web typecheck`, `pnpm --filter @rigel/server typecheck` clean.
- [ ] **Step 3:** Confirm `deployment(config())` output is byte-identical to pre-change for env refs (no accidental Deployment change this phase — env templating is Phase 2).

## Out of scope (later phases)
- Phase 2: `CREDENTIAL_ENV`-driven Deployment env templating, `setCredentialSource` + `listCredentialSecrets`, the source-picker dialog, `credentialStatus` shape change to per-credential `{ ready, secretName }`.
- Phase 3: `reconcileCredentialAnnotations` repair action + conflict surfacing.
