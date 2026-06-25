# Cluster Assistant Multi-Provider — Plan 2: Control Plane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the control plane for the user-selectable AI providers feature on top of Plan 1's landed agent core. Teach the manifest generator (`packages/k8s/src/assistant.ts`) to emit a multi-key credentials Secret (`rigel-assistant-credentials`) injected into the Deployment as the exact env vars each provider bridge reads (each `optional: true` so missing creds never block startup), and to seed the per-role selections + operational limits into the `assistant-config` ConfigMap using the EXACT keys `agent/src/runtimeConfig.ts` parses. Extend `/api/assistant` (`apps/server/src/assistant.ts`) so `install` takes `worker`/`supervisor` selections + a credentials map, plus three new actions: `setModels` (live role switch, no restart), `setCredentials` (re-apply the Secret + rollout-restart, generalizes `updateToken`), and `setLimits` (live limit change, no restart). Finally, wire `rc.limits` into the agent poll loop (`agent/src/index.ts`) + the `CircuitBreaker` so the limits the agent reads at startup today become live (the wiring Plan 1 deferred). The legacy `rigel-assistant-token` Secret keeps working untouched — existing installs do not break.

**Architecture:** TypeScript monorepo. Three packages change, each with its own test command:
- `packages/k8s` (pnpm, `@rigel/k8s`) — the pure manifest/config builders. Test: `pnpm --filter @rigel/k8s test`. Typecheck: `pnpm --filter @rigel/k8s typecheck`.
- `apps/server` (pnpm, `@rigel/server`) — `/api/assistant` orchestration over the k8s builders + kubectl. Test: `pnpm --filter @rigel/server test`. Typecheck: `pnpm --filter @rigel/server typecheck`.
- `agent/` (npm, `rigel-assistant-agent`, OUTSIDE the pnpm workspace) — the in-cluster loop. Test: `npm --prefix agent test` (vitest run; does NOT typecheck). Typecheck SEPARATELY: `npm --prefix agent run typecheck`.
- `apps/web` (pnpm, `web`) — only the `AssistantRequest` TYPE in `apps/web/src/lib/api.ts` is extended (no React components — those are Plan 3). Typecheck: `pnpm --filter web typecheck`.

The design keeps the server thin: every cluster write is composed from a **pure builder in `packages/k8s`** (so it is unit-testable without a live cluster — per the project policy of never running mutations against a real cluster to verify). The server orchestrates read-modify-write + apply/rollout exactly as it does today.

**Tech Stack:** Node 22, TypeScript (ESM). `packages/k8s` + `apps/server` import within the workspace (no `.js` specifiers needed between workspace files — server imports `@rigel/k8s/src/assistant`). `agent/` uses `.js` import specifiers (ESM/NodeNext) and has `noUncheckedIndexedAccess: true` (Plan 1 hit TS2532 on array indexing in tests — always run `npm --prefix agent run typecheck` for agent changes). vitest 4 everywhere.

> **NOTE for the human (not a code step):** `docs/` is gitignored in this repo. This plan file is not tracked by a plain `git add`; to commit it later use `git add -f docs/superpowers/plans/2026-06-23-assistant-multi-provider-2-control-plane.md`.

## Contract reference (read before starting — these MUST match Plan 1's landed code exactly)

**Provider credential key → env var → bridge that reads it** (from `agent/src/providers/{claude,codex,gemini,opencode}.ts` `authEnv()`):

| Secret key (`rigel-assistant-credentials`) | Deployment env var | Read by |
|---|---|---|
| `claudeToken` | `CLAUDE_CODE_OAUTH_TOKEN` | claude bridge (preferred) |
| `anthropicApiKey` | `ANTHROPIC_API_KEY` | claude bridge (fallback) |
| `codexApiKey` | `CODEX_API_KEY` | codex bridge |
| `geminiApiKey` | `GEMINI_API_KEY` | gemini bridge |
| `opencodeApiKey` | `OPENCODE_API_KEY` | opencode bridge (fallback) |
| `opencodeAuthContent` | `OPENCODE_AUTH_CONTENT` | opencode bridge (preferred) |

Legacy (backward-compat, kept untouched): Secret `rigel-assistant-token`, key `token` → env `CLAUDE_CODE_OAUTH_TOKEN`.

**assistant-config role keys** (parsed by `parseRoleSelection` in `agent/src/runtimeConfig.ts`): `workerProvider`, `workerModel`, `workerEffort`, `supervisorProvider`, `supervisorModel`, `supervisorEffort`.

**assistant-config limit keys** (parsed by `parseLimits` in `agent/src/runtimeConfig.ts`): `pollIntervalMs`, `maxPerResourcePerHour`, `maxPerNight`, `maxAttemptsPerIncident`, `confirmPolls`, `namespaces` (newline/comma separated).

**New server actions:** `setModels`, `setCredentials`, `setLimits`. (`updateToken` is kept as a thin alias of `setCredentials` for backward compat with existing callers.)

---

## Task 1 — k8s: `credentialsSecretYAML` builder (the multi-key Secret)

The new Secret holds one key per credential the user entered. Only keys with a non-empty value are written, so a user who only supplies a Gemini key gets a Secret with just `geminiApiKey`. The Deployment (Task 2) references every possible key with `optional: true`, so absent keys are simply not injected. This builder is pure and is the single source of the Secret YAML for both `install` and `setCredentials`.

**Files:**
- Modify: `packages/k8s/src/assistant.ts` (add after `secretYAML`, ~line 97; add a `CREDENTIALS_SECRET_NAME` constant near `SECRET_NAME` ~line 54)
- Modify (test): `packages/k8s/src/assistant.test.ts` (append tests)

**Steps:**

- [ ] Write the failing tests. Append to `packages/k8s/src/assistant.test.ts`:
```ts
import {
  CREDENTIALS_SECRET_NAME,
  credentialsSecretYAML,
  type AssistantCredentials,
} from "./assistant";

describe("credentialsSecretYAML", () => {
  test("emits only the keys whose value is non-empty", () => {
    const yaml = credentialsSecretYAML(
      { geminiApiKey: "g-123", codexApiKey: "" },
      "default",
    );
    expect(yaml).toContain(`name: ${CREDENTIALS_SECRET_NAME}`);
    expect(yaml).toContain("namespace: default");
    expect(yaml).toContain("kind: Secret");
    expect(yaml).toContain("type: Opaque");
    expect(yaml).toContain('geminiApiKey: "g-123"');
    expect(yaml).not.toContain("codexApiKey");
    expect(yaml).not.toContain("claudeToken");
  });

  test("escapes quotes/backslashes in a credential value", () => {
    const yaml = credentialsSecretYAML({ opencodeAuthContent: 'a"b\\c' }, "agents");
    expect(yaml).toContain('opencodeAuthContent: "a\\"b\\\\c"');
    expect(yaml).toContain("namespace: agents");
  });

  test("writes all six possible keys when all are provided", () => {
    const yaml = credentialsSecretYAML(
      {
        claudeToken: "t",
        anthropicApiKey: "a",
        codexApiKey: "c",
        geminiApiKey: "g",
        opencodeApiKey: "o",
        opencodeAuthContent: "blob",
      },
      "default",
    );
    for (const k of ["claudeToken", "anthropicApiKey", "codexApiKey", "geminiApiKey", "opencodeApiKey", "opencodeAuthContent"]) {
      expect(yaml).toContain(`${k}: "`);
    }
  });

  test("an all-empty credentials map still produces a valid (empty-data) Secret", () => {
    const yaml = credentialsSecretYAML({}, "default");
    expect(yaml).toContain(`name: ${CREDENTIALS_SECRET_NAME}`);
    expect(yaml).toContain("stringData:");
  });
});
```

- [ ] Run it, expect FAIL (no such export): `pnpm --filter @rigel/k8s test`

- [ ] Add the constant in `packages/k8s/src/assistant.ts` right after `export const SECRET_NAME = "rigel-assistant-token";` (line 54):
```ts
/** Multi-key Secret holding one entry per provider credential the user supplied.
 * Distinct from the legacy single-key SECRET_NAME so existing installs are
 * untouched (the Deployment injects from BOTH, each optional). */
export const CREDENTIALS_SECRET_NAME = "rigel-assistant-credentials";

/** The provider credentials a user can supply. Each maps to one Secret key and,
 * via the Deployment env, to the exact var the matching bridge's authEnv() reads:
 *   claudeToken          → CLAUDE_CODE_OAUTH_TOKEN  (claude)
 *   anthropicApiKey      → ANTHROPIC_API_KEY        (claude fallback)
 *   codexApiKey          → CODEX_API_KEY            (codex)
 *   geminiApiKey         → GEMINI_API_KEY           (gemini)
 *   opencodeApiKey       → OPENCODE_API_KEY         (opencode fallback)
 *   opencodeAuthContent  → OPENCODE_AUTH_CONTENT    (opencode preferred) */
export interface AssistantCredentials {
  claudeToken?: string;
  anthropicApiKey?: string;
  codexApiKey?: string;
  geminiApiKey?: string;
  opencodeApiKey?: string;
  opencodeAuthContent?: string;
}

/** Stable ordered list of (key) so YAML output is deterministic. */
const CREDENTIAL_KEYS: (keyof AssistantCredentials)[] = [
  "claudeToken",
  "anthropicApiKey",
  "codexApiKey",
  "geminiApiKey",
  "opencodeApiKey",
  "opencodeAuthContent",
];
```

- [ ] Add the builder right after `secretYAML` (after line 97 in `packages/k8s/src/assistant.ts`):
```ts
/**
 * The multi-key credentials Secret. Writes ONLY the keys whose value is a
 * non-empty string, so a user who supplies one provider's key gets a Secret with
 * just that key. The Deployment references every possible key with
 * `optional: true`, so absent keys are simply not injected (no startup failure).
 * Never previewed (carries secrets), same as secretYAML.
 */
export function credentialsSecretYAML(
  creds: AssistantCredentials,
  namespace = "default",
): string {
  const lines: string[] = [];
  for (const key of CREDENTIAL_KEYS) {
    const value = creds[key];
    if (typeof value === "string" && value.trim() !== "") {
      lines.push(`  ${key}: "${escape(value)}"`);
    }
  }
  const stringData = lines.length > 0 ? `stringData:\n${lines.join("\n")}` : "stringData: {}";
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${CREDENTIALS_SECRET_NAME}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
type: Opaque
${stringData}`;
}
```

- [ ] Run it, expect PASS: `pnpm --filter @rigel/k8s test`

- [ ] Typecheck: `pnpm --filter @rigel/k8s typecheck` (expect PASS)

- [ ] Commit:
```
git add packages/k8s/src/assistant.ts packages/k8s/src/assistant.test.ts
git commit -m "feat(k8s): credentialsSecretYAML — multi-key provider Secret builder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2 — k8s: inject every provider env var into the Deployment (optional secretKeyRef)

The Deployment currently injects only `CLAUDE_CODE_OAUTH_TOKEN` from the legacy Secret (required). Add the six new env vars, each `valueFrom.secretKeyRef` against `CREDENTIALS_SECRET_NAME` with `optional: true`, AND make the legacy `CLAUDE_CODE_OAUTH_TOKEN` ref `optional: true` so a fresh install with no legacy Secret still starts. Backward-compat: the legacy `CLAUDE_CODE_OAUTH_TOKEN` from `rigel-assistant-token` stays as the FIRST env entry (a running agent keeps reading it); the credentials Secret's `claudeToken` is injected under the same env var name only when the legacy one is absent — but two `secretKeyRef`s cannot target the same env var, so the legacy ref stays as `CLAUDE_CODE_OAUTH_TOKEN` and the new claude credential rides `ANTHROPIC_API_KEY`/its own path. (Decision: keep the legacy `token`→`CLAUDE_CODE_OAUTH_TOKEN` ref; the new credentials Secret supplies `anthropicApiKey`→`ANTHROPIC_API_KEY` for Claude and the other three providers. `claudeToken` in the credentials Secret is still written by the builder and is used by `setCredentials` to re-stamp the LEGACY Secret — see Task 7's decision note — so the claude OAuth path is never duplicated as two refs.)

**Files:**
- Modify: `packages/k8s/src/assistant.ts` (`deployment()` env block, lines 256-284)
- Modify (test): `packages/k8s/src/assistant.test.ts`

**Steps:**

- [ ] Write the failing tests. Append to `packages/k8s/src/assistant.test.ts`:
```ts
import { deployment, CREDENTIALS_SECRET_NAME as CREDS } from "./assistant";

describe("deployment provider credential env", () => {
  const yaml = deployment(config());

  test("legacy CLAUDE_CODE_OAUTH_TOKEN ref is kept but now optional", () => {
    expect(yaml).toContain("name: CLAUDE_CODE_OAUTH_TOKEN");
    expect(yaml).toContain(`name: ${SECRET_NAME}`);
    expect(yaml).toContain("key: token");
    // The legacy ref must be optional so a fresh install with no legacy Secret starts.
    expect(yaml).toMatch(/key: token\s+optional: true/);
  });

  test("injects ANTHROPIC_API_KEY / CODEX_API_KEY / GEMINI_API_KEY from the credentials Secret, optional", () => {
    for (const [env, key] of [
      ["ANTHROPIC_API_KEY", "anthropicApiKey"],
      ["CODEX_API_KEY", "codexApiKey"],
      ["GEMINI_API_KEY", "geminiApiKey"],
    ] as const) {
      expect(yaml).toContain(`name: ${env}`);
      expect(yaml).toContain(`key: ${key}`);
    }
    // Every credentials ref points at the credentials Secret and is optional.
    expect(yaml).toContain(`name: ${CREDS}`);
    expect(yaml.match(/optional: true/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });

  test("injects both OpenCode env vars from the credentials Secret", () => {
    expect(yaml).toContain("name: OPENCODE_API_KEY");
    expect(yaml).toContain("key: opencodeApiKey");
    expect(yaml).toContain("name: OPENCODE_AUTH_CONTENT");
    expect(yaml).toContain("key: opencodeAuthContent");
  });

  test("RBAC cage still never grants secrets access", () => {
    expect(manifestYAML(config()).toLowerCase()).not.toContain("resources: [secrets]");
  });
});
```
> NOTE: the existing `"RBAC cage never grants secrets access"` test asserts the WHOLE manifest lowercased does not contain the substring `"secrets"`. Adding `secretKeyRef` does NOT introduce that substring (it is `secretkeyref`, no standalone `secrets`), and the new env keys are camelCase (`codexApiKey` etc.), so that test stays green. Do not change it.

- [ ] Run it, expect FAIL (env vars not present): `pnpm --filter @rigel/k8s test`

- [ ] Edit `packages/k8s/src/assistant.ts`. Replace the legacy token env entry (lines 257-261) — make it optional:
```yaml
            - name: CLAUDE_CODE_OAUTH_TOKEN
              valueFrom:
                secretKeyRef:
                  name: ${SECRET_NAME}
                  key: token
                  optional: true
```
Then, immediately AFTER that entry and BEFORE `- name: WORKER_MODEL` (line 262), insert the five new credential env entries:
```yaml
            # Provider API keys from the multi-key credentials Secret. Each is
            # optional so a missing credential never blocks startup; the matching
            # bridge fails closed at run time if its role's provider has no key.
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ${CREDENTIALS_SECRET_NAME}
                  key: anthropicApiKey
                  optional: true
            - name: CODEX_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ${CREDENTIALS_SECRET_NAME}
                  key: codexApiKey
                  optional: true
            - name: GEMINI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ${CREDENTIALS_SECRET_NAME}
                  key: geminiApiKey
                  optional: true
            - name: OPENCODE_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ${CREDENTIALS_SECRET_NAME}
                  key: opencodeApiKey
                  optional: true
            - name: OPENCODE_AUTH_CONTENT
              valueFrom:
                secretKeyRef:
                  name: ${CREDENTIALS_SECRET_NAME}
                  key: opencodeAuthContent
                  optional: true
```
> The `WORKER_MODEL`/`SUPERVISOR_MODEL` env entries (lines 262-265) stay unchanged — they remain the deploy-time FALLBACK that `parseRoleSelection` uses when `assistant-config` has no role keys (`cfg.workerModel`/`cfg.supervisorModel`). Do not remove them.

- [ ] Run it, expect PASS: `pnpm --filter @rigel/k8s test`

- [ ] Typecheck: `pnpm --filter @rigel/k8s typecheck` (expect PASS)

- [ ] Commit:
```
git add packages/k8s/src/assistant.ts packages/k8s/src/assistant.test.ts
git commit -m "feat(k8s): inject all provider creds into the Deployment (optional secretKeyRef)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3 — k8s: `roleConfigUpdates` + `limitsConfigUpdates` (the assistant-config key builders)

Two pure builders produce the `{ key: value }` update maps that the server's read-modify-write `patchConfig` merges into `assistant-config`. They emit the EXACT keys `agent/src/runtimeConfig.ts` parses (role keys: `workerProvider`/`workerModel`/`workerEffort`/`supervisorProvider`/`supervisorModel`/`supervisorEffort`; limit keys: `pollIntervalMs`/`maxPerResourcePerHour`/`maxPerNight`/`maxAttemptsPerIncident`/`confirmPolls`/`namespaces`). Only provided fields are emitted, so a partial update never clobbers other keys. These are reused by `install` (seed), `setModels`, and `setLimits`.

**Files:**
- Modify: `packages/k8s/src/assistant.ts` (add near `mergedConfigMapJSON`, ~line 567)
- Modify (test): `packages/k8s/src/assistant.test.ts`

**Steps:**

- [ ] Write the failing tests. Append to `packages/k8s/src/assistant.test.ts`:
```ts
import {
  roleConfigUpdates,
  limitsConfigUpdates,
  type RoleSelectionInput,
  type LimitsInput,
} from "./assistant";

describe("roleConfigUpdates", () => {
  test("emits the exact runtimeConfig keys for both roles", () => {
    const updates = roleConfigUpdates(
      { provider: "gemini", model: "gemini-2.5-pro" },
      { provider: "claude", model: "claude-opus-4-8", effort: "high" },
    );
    expect(updates).toEqual({
      workerProvider: "gemini",
      workerModel: "gemini-2.5-pro",
      supervisorProvider: "claude",
      supervisorModel: "claude-opus-4-8",
      supervisorEffort: "high",
    });
  });

  test("omits effort keys when effort is absent (so a switch-away clears nothing it shouldn't)", () => {
    const updates = roleConfigUpdates(
      { provider: "claude", model: "claude-sonnet-4-6" },
      { provider: "claude", model: "claude-opus-4-8" },
    );
    expect(updates.workerEffort).toBeUndefined();
    expect(updates.supervisorEffort).toBeUndefined();
    expect(Object.keys(updates).sort()).toEqual([
      "supervisorModel", "supervisorProvider", "workerModel", "workerProvider",
    ]);
  });

  test("only the worker role when supervisor is omitted", () => {
    const updates = roleConfigUpdates({ provider: "codex", model: "gpt-5-codex" }, undefined);
    expect(updates).toEqual({ workerProvider: "codex", workerModel: "gpt-5-codex" });
  });
});

describe("limitsConfigUpdates", () => {
  test("emits only the provided limit keys, all stringified", () => {
    const updates = limitsConfigUpdates({ pollIntervalMs: 15000, confirmPolls: 3 });
    expect(updates).toEqual({ pollIntervalMs: "15000", confirmPolls: "3" });
  });

  test("namespaces array is joined newline-separated", () => {
    const updates = limitsConfigUpdates({ namespaces: ["default", "kube-system"] });
    expect(updates).toEqual({ namespaces: "default\nkube-system" });
  });

  test("empty namespaces array clears the key to empty string (all namespaces)", () => {
    expect(limitsConfigUpdates({ namespaces: [] })).toEqual({ namespaces: "" });
  });

  test("an empty input produces no updates", () => {
    expect(limitsConfigUpdates({})).toEqual({});
  });
});
```

- [ ] Run it, expect FAIL: `pnpm --filter @rigel/k8s test`

- [ ] Add to `packages/k8s/src/assistant.ts`, right before `mergedConfigMapJSON` (line 551):
```ts
/** One role's selection as the server receives it (provider id is a plain string;
 * the agent re-validates it against its provider set, so no enum needed here). */
export interface RoleSelectionInput {
  provider: string;
  model: string;
  /** Claude-family reasoning effort; omitted for other providers. */
  effort?: string;
}

/** The operational limits a user can change live (subset can be provided). */
export interface LimitsInput {
  pollIntervalMs?: number;
  maxPerResourcePerHour?: number;
  maxPerNight?: number;
  maxAttemptsPerIncident?: number;
  confirmPolls?: number;
  /** Monitored namespaces; empty array = all. */
  namespaces?: string[];
}

/**
 * Build the assistant-config updates for the per-role selections, using the EXACT
 * keys `agent/src/runtimeConfig.ts parseRoleSelection` reads. `effort` keys are
 * only emitted when set. A role omitted (undefined) contributes no keys, so a
 * worker-only change never touches the supervisor keys.
 */
export function roleConfigUpdates(
  worker?: RoleSelectionInput,
  supervisor?: RoleSelectionInput,
): Record<string, string> {
  const updates: Record<string, string> = {};
  if (worker) {
    updates.workerProvider = worker.provider;
    updates.workerModel = worker.model;
    if (worker.effort && worker.effort.trim() !== "") updates.workerEffort = worker.effort;
  }
  if (supervisor) {
    updates.supervisorProvider = supervisor.provider;
    updates.supervisorModel = supervisor.model;
    if (supervisor.effort && supervisor.effort.trim() !== "") updates.supervisorEffort = supervisor.effort;
  }
  return updates;
}

/**
 * Build the assistant-config updates for the operational limits, using the EXACT
 * keys `agent/src/runtimeConfig.ts parseLimits` reads. Numbers are stringified;
 * namespaces is newline-joined ("" = all namespaces). Only provided fields are
 * emitted, so a partial update never clobbers other limit keys.
 */
export function limitsConfigUpdates(limits: LimitsInput): Record<string, string> {
  const updates: Record<string, string> = {};
  if (limits.pollIntervalMs !== undefined) updates.pollIntervalMs = String(limits.pollIntervalMs);
  if (limits.maxPerResourcePerHour !== undefined) updates.maxPerResourcePerHour = String(limits.maxPerResourcePerHour);
  if (limits.maxPerNight !== undefined) updates.maxPerNight = String(limits.maxPerNight);
  if (limits.maxAttemptsPerIncident !== undefined) updates.maxAttemptsPerIncident = String(limits.maxAttemptsPerIncident);
  if (limits.confirmPolls !== undefined) updates.confirmPolls = String(limits.confirmPolls);
  if (limits.namespaces !== undefined) updates.namespaces = limits.namespaces.join("\n");
  return updates;
}
```

- [ ] Run it, expect PASS: `pnpm --filter @rigel/k8s test`

- [ ] Typecheck: `pnpm --filter @rigel/k8s typecheck` (expect PASS)

- [ ] Commit:
```
git add packages/k8s/src/assistant.ts packages/k8s/src/assistant.test.ts
git commit -m "feat(k8s): roleConfigUpdates + limitsConfigUpdates builders for assistant-config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4 — k8s: seed role + limit keys into the install-time `configMaps()`

So a fresh install lands with the role + limit keys already in `assistant-config` (not just `enabled`/`mode`). `configMaps(ns)` currently emits a static block. Change it to accept the install config and seed `workerProvider`/`workerModel`/`supervisorProvider`/`supervisorModel` (from the role selections) + the limit keys (from the install knobs), so the agent reads the user's choices on first boot. `manifestYAML` passes the config through.

**Files:**
- Modify: `packages/k8s/src/assistant.ts` (`AssistantInstallConfig` interface lines 20-36; `DEFAULT_INSTALL_CONFIG` lines 39-50; `configMaps()` lines 187-216; `manifestYAML()` line 300)
- Modify (test): `packages/k8s/src/assistant.test.ts`

**Steps:**

- [ ] Write the failing tests. Append to `packages/k8s/src/assistant.test.ts`:
```ts
test("install ConfigMap seeds the role keys from the selections", () => {
  const yaml = manifestYAML(config({
    worker: { provider: "gemini", model: "gemini-2.5-pro" },
    supervisor: { provider: "claude", model: "claude-opus-4-8", effort: "high" },
  }));
  expect(yaml).toContain("workerProvider: gemini");
  expect(yaml).toContain("workerModel: gemini-2.5-pro");
  expect(yaml).toContain("supervisorProvider: claude");
  expect(yaml).toContain("supervisorModel: claude-opus-4-8");
  expect(yaml).toContain("supervisorEffort: high");
});

test("install ConfigMap seeds the operational limit keys", () => {
  const yaml = manifestYAML(config({ pollIntervalMs: 45000, confirmPolls: 4, namespaces: "default,kube-system" }));
  expect(yaml).toContain('pollIntervalMs: "45000"');
  expect(yaml).toContain('confirmPolls: "4"');
  expect(yaml).toContain("namespaces:");
});

test("install ConfigMap defaults role keys to claude worker/supervisor when no selection given", () => {
  const yaml = manifestYAML(config());
  expect(yaml).toContain("workerProvider: claude");
  expect(yaml).toContain("workerModel: claude-sonnet-4-6");
  expect(yaml).toContain("supervisorProvider: claude");
  expect(yaml).toContain("supervisorModel: claude-opus-4-8");
});

test("kill switch still starts enabled", () => {
  expect(manifestYAML(config())).toContain('enabled: "true"');
});
```
> NOTE: the existing `config()` helper in the test file (lines 24-38) builds an `AssistantInstallConfig` without `worker`/`supervisor`. After Task 4 those fields are optional, so the helper still compiles. The new tests pass them via overrides.

- [ ] Run it, expect FAIL: `pnpm --filter @rigel/k8s test`

- [ ] Edit `packages/k8s/src/assistant.ts`. Extend `AssistantInstallConfig` (after `confirmPolls: number;`, line 35) with the optional role selections:
```ts
  /** Per-role provider+model+effort selections seeded into assistant-config on
   * install. Optional: when absent the ConfigMap seeds claude worker/supervisor
   * (matching the WORKER_MODEL/SUPERVISOR_MODEL env fallbacks). */
  worker?: RoleSelectionInput;
  supervisor?: RoleSelectionInput;
```
> `RoleSelectionInput` is declared later in the file (Task 3). TypeScript hoists interface declarations within a module, so the forward reference compiles. If the linter prefers, move the `RoleSelectionInput`/`LimitsInput` declarations from Task 3 up to just under `AssistantInstallConfig` — functionally identical.

- [ ] Edit `DEFAULT_INSTALL_CONFIG` (lines 39-50) — no new required fields, so leave it as-is (worker/supervisor are optional and default inside `configMaps`).

- [ ] Replace `configMaps(ns: string)` (lines 187-216) with a version that takes the full config and seeds the keys:
```ts
/** The three pre-created ConfigMaps: config (control surface, seeded with the
 *  role selections + operational limits), state, backups. */
export function configMaps(c: AssistantInstallConfig): string {
  const ns = c.installNamespace;
  // Seed role keys (default to claude worker=sonnet / supervisor=opus to match
  // the WORKER_MODEL/SUPERVISOR_MODEL env fallbacks + parseRoleSelection defaults).
  const worker = c.worker ?? { provider: "claude", model: c.workerModel };
  const supervisor = c.supervisor ?? { provider: "claude", model: c.supervisorModel };
  const roleLines = [
    `  workerProvider: ${worker.provider}`,
    `  workerModel: ${worker.model}`,
    ...(worker.effort ? [`  workerEffort: ${worker.effort}`] : []),
    `  supervisorProvider: ${supervisor.provider}`,
    `  supervisorModel: ${supervisor.model}`,
    ...(supervisor.effort ? [`  supervisorEffort: ${supervisor.effort}`] : []),
  ].join("\n");
  const nsList = c.namespaces
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  const limitLines = [
    `  pollIntervalMs: "${c.pollIntervalMs}"`,
    `  maxPerResourcePerHour: "${c.maxPerResourcePerHour}"`,
    `  maxPerNight: "${c.maxPerNight}"`,
    `  maxAttemptsPerIncident: "${c.maxAttemptsPerIncident}"`,
    `  confirmPolls: "${c.confirmPolls}"`,
    `  namespaces: "${nsList}"`,
  ].join("\n");
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: assistant-config
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
data:
  enabled: "true"
  mode: "auto"
${roleLines}
${limitLines}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: assistant-state
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
data: {}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: assistant-backups
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
data: {}`;
}
```

- [ ] Update `manifestYAML` (line 300) to pass the config to `configMaps`:
```ts
export function manifestYAML(c: AssistantInstallConfig): string {
  return [rbac(c.installNamespace), configMaps(c), deployment(c)].join("\n---\n");
}
```

- [ ] Search for other callers of `configMaps(` — there should be none outside `manifestYAML` (it was previously `configMaps(ns)`). Verify: `grep -rn "configMaps(" packages apps agent --include=*.ts | grep -v ".test.ts"` shows only the `manifestYAML` call site. If a test referenced `configMaps(ns)` directly, update it to `configMaps(config())`.

- [ ] Run it, expect PASS (all k8s tests): `pnpm --filter @rigel/k8s test`

- [ ] Typecheck: `pnpm --filter @rigel/k8s typecheck` (expect PASS)

- [ ] Commit:
```
git add packages/k8s/src/assistant.ts packages/k8s/src/assistant.test.ts
git commit -m "feat(k8s): seed role + limit keys into the install assistant-config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5 — server: extend `AssistantRequest` + a pure `parseCredentials` validator

The server request gains `worker`/`supervisor` selections, a `credentials` map, and a `limits` object, plus the three new action names. A pure helper `parseCredentials(req)` extracts the `AssistantCredentials` from the request (dropping empty values) — testable without a cluster. This is the seam that lets the rest of the server logic stay pure-composable.

**Files:**
- Modify: `apps/server/src/assistant.ts` (`AssistantAction` lines 83-95; `AssistantRequest` lines 97-123; add `parseCredentials` near `validateInstall` ~line 144)
- Modify (test): `apps/server/src/assistant.test.ts`

**Steps:**

- [ ] Write the failing tests. Append to `apps/server/src/assistant.test.ts`:
```ts
import { parseCredentials, type AssistantRequest } from "./assistant";

test("parseCredentials picks up every provided credential, trimming empties", () => {
  const req: AssistantRequest = {
    action: "setCredentials",
    credentials: {
      geminiApiKey: "g-1",
      codexApiKey: "   ",
      opencodeAuthContent: "blob",
      anthropicApiKey: "",
    },
  };
  expect(parseCredentials(req)).toEqual({ geminiApiKey: "g-1", opencodeAuthContent: "blob" });
});

test("parseCredentials maps a legacy top-level token onto claudeToken", () => {
  const req: AssistantRequest = { action: "setCredentials", token: "tok-legacy" };
  expect(parseCredentials(req)).toEqual({ claudeToken: "tok-legacy" });
});

test("parseCredentials returns an empty object when nothing is provided", () => {
  expect(parseCredentials({ action: "setCredentials" })).toEqual({});
});
```

- [ ] Run it, expect FAIL: `pnpm --filter @rigel/server test`

- [ ] Edit `apps/server/src/assistant.ts`. Extend `AssistantAction` (lines 83-95) — add the three new actions before `"silence"`:
```ts
export type AssistantAction =
  | "install"
  | "uninstall"
  | "setMode"
  | "kill"
  | "updateToken"
  | "setModels"
  | "setCredentials"
  | "setLimits"
  | "restart"
  | "silence"
  | "unsilence"
  | "clearReport"
  | "clearActivity"
  | "setSignal"
  | "saveAlert" | "deleteAlert" | "toggleAlert";
```

- [ ] Add the import for the credentials type at the top (extend the existing `@rigel/k8s/src/assistant` import block, lines 14-25):
```ts
import {
  DEFAULT_INSTALL_CONFIG,
  SECRET_NAME,
  CREDENTIALS_SECRET_NAME,
  namespaceYAML,
  secretYAML,
  credentialsSecretYAML,
  manifestYAML,
  mergedConfigMapJSON,
  clearedReportConfigMapJSON,
  clearedStateConfigMapJSON,
  silencedSet,
  roleConfigUpdates,
  limitsConfigUpdates,
  type AssistantInstallConfig,
  type AssistantCredentials,
  type RoleSelectionInput,
  type LimitsInput,
} from "@rigel/k8s/src/assistant";
```

- [ ] Extend `AssistantRequest` (after `confirmPolls?: number;`, line 108) with the new fields:
```ts
  // Multi-provider control plane (Plan 2).
  worker?: RoleSelectionInput;
  supervisor?: RoleSelectionInput;
  credentials?: AssistantCredentials;
  limits?: LimitsInput;
```

- [ ] Add `parseCredentials` right after `validateInstall` (after line 144):
```ts
/**
 * Extract the credentials map from a request: take req.credentials, drop any
 * empty/whitespace value, and fold a legacy top-level `token` into `claudeToken`
 * (so old callers still work). Pure — testable without a cluster.
 */
export function parseCredentials(req: AssistantRequest): AssistantCredentials {
  const out: AssistantCredentials = {};
  const src = req.credentials ?? {};
  for (const [k, v] of Object.entries(src) as [keyof AssistantCredentials, string | undefined][]) {
    if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
  }
  if (!out.claudeToken && req.token && req.token.trim() !== "") {
    out.claudeToken = req.token.trim();
  }
  return out;
}
```

- [ ] Run it, expect PASS: `pnpm --filter @rigel/server test`

- [ ] Typecheck: `pnpm --filter @rigel/server typecheck` (expect PASS)

- [ ] Commit:
```
git add apps/server/src/assistant.ts apps/server/src/assistant.test.ts
git commit -m "feat(server): extend AssistantRequest + parseCredentials for multi-provider

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6 — server: `install` writes the credentials Secret + seeds role/limit config

Extend `installAssistant` to (1) build the install config from `worker`/`supervisor`/`limits` (falling back to the legacy `workerModel`/`supervisorModel` knobs), (2) apply the legacy token Secret (only when a Claude token is present — keeps backward compat) AND the new credentials Secret, and (3) apply the manifests (whose `configMaps` now seeds the role + limit keys via Task 4). The seam: a pure `buildInstallConfig(req)` returns the `AssistantInstallConfig` to apply; the test asserts on it (no cluster). The Secret YAML applied is asserted via the existing pure `secretYAML`/`credentialsSecretYAML` builders, already covered in Tasks 1-4.

**Files:**
- Modify: `apps/server/src/assistant.ts` (`installAssistant` lines 156-191; add `buildInstallConfig`)
- Modify (test): `apps/server/src/assistant.test.ts`

**Steps:**

- [ ] Write the failing tests. Append to `apps/server/src/assistant.test.ts`:
```ts
import { buildInstallConfig } from "./assistant";

test("buildInstallConfig carries the role selections + limits onto the install config", () => {
  const cfg = buildInstallConfig({
    action: "install",
    namespace: "agents",
    image: "ghcr.io/acme/rigel-assistant:v1",
    worker: { provider: "gemini", model: "gemini-2.5-pro" },
    supervisor: { provider: "claude", model: "claude-opus-4-8", effort: "high" },
    limits: { pollIntervalMs: 45000, confirmPolls: 4, namespaces: ["default", "kube-system"] },
  });
  expect(cfg.installNamespace).toBe("agents");
  expect(cfg.image).toBe("ghcr.io/acme/rigel-assistant:v1");
  expect(cfg.worker).toEqual({ provider: "gemini", model: "gemini-2.5-pro" });
  expect(cfg.supervisor).toEqual({ provider: "claude", model: "claude-opus-4-8", effort: "high" });
  expect(cfg.pollIntervalMs).toBe(45000);
  expect(cfg.confirmPolls).toBe(4);
  expect(cfg.namespaces).toBe("default,kube-system");
});

test("buildInstallConfig falls back to legacy model knobs + defaults when no selection/limits given", () => {
  const cfg = buildInstallConfig({ action: "install" });
  expect(cfg.installNamespace).toBe("default");
  expect(cfg.workerModel).toBe("claude-sonnet-4-6");
  expect(cfg.supervisorModel).toBe("claude-opus-4-8");
  expect(cfg.pollIntervalMs).toBe(30000);
  expect(cfg.worker).toBeUndefined();
  expect(cfg.supervisor).toBeUndefined();
});
```

- [ ] Run it, expect FAIL: `pnpm --filter @rigel/server test`

- [ ] Add `buildInstallConfig` to `apps/server/src/assistant.ts` right before `installAssistant` (line 156):
```ts
/**
 * Build the AssistantInstallConfig from a request. The per-role selections seed
 * the assistant-config ConfigMap (via packages/k8s configMaps); the legacy
 * workerModel/supervisorModel knobs remain the env fallback. Limits map onto the
 * install knobs (namespaces is comma-joined for the env/ConfigMap). Pure.
 */
export function buildInstallConfig(req: AssistantRequest): AssistantInstallConfig {
  const namespace = (req.namespace ?? DEFAULT_INSTALL_CONFIG.installNamespace).trim() || DEFAULT_INSTALL_CONFIG.installNamespace;
  const image = (req.image ?? DEFAULT_INSTALL_CONFIG.image).trim() || DEFAULT_INSTALL_CONFIG.image;
  const limits = req.limits ?? {};
  const monitorNamespaces =
    limits.namespaces !== undefined ? limits.namespaces.join(",") : req.monitorNamespaces ?? DEFAULT_INSTALL_CONFIG.namespaces;
  return {
    image,
    installNamespace: namespace,
    namespaces: monitorNamespaces,
    workerModel: req.worker?.model ?? req.workerModel ?? DEFAULT_INSTALL_CONFIG.workerModel,
    supervisorModel: req.supervisor?.model ?? req.supervisorModel ?? DEFAULT_INSTALL_CONFIG.supervisorModel,
    pollIntervalMs: limits.pollIntervalMs ?? req.pollIntervalMs ?? DEFAULT_INSTALL_CONFIG.pollIntervalMs,
    maxPerResourcePerHour: limits.maxPerResourcePerHour ?? req.maxPerResourcePerHour ?? DEFAULT_INSTALL_CONFIG.maxPerResourcePerHour,
    maxPerNight: limits.maxPerNight ?? req.maxPerNight ?? DEFAULT_INSTALL_CONFIG.maxPerNight,
    maxAttemptsPerIncident: limits.maxAttemptsPerIncident ?? req.maxAttemptsPerIncident ?? DEFAULT_INSTALL_CONFIG.maxAttemptsPerIncident,
    confirmPolls: limits.confirmPolls ?? req.confirmPolls ?? DEFAULT_INSTALL_CONFIG.confirmPolls,
    worker: req.worker,
    supervisor: req.supervisor,
  };
}
```

- [ ] Replace `installAssistant` body (lines 156-191) to use it and apply both Secrets:
```ts
async function installAssistant(
  context: string | null,
  req: AssistantRequest,
): Promise<RunResult> {
  const config = buildInstallConfig(req);
  const namespace = config.installNamespace;

  // Credentials: req.credentials (+ legacy top-level token folded into claudeToken).
  // For Claude we still also accept the user's already-saved token (onboarding /
  // Settings) so they don't re-enter it.
  const creds = parseCredentials(req);
  if (!creds.claudeToken) {
    const saved = (await effectiveClaudeToken()) ?? "";
    if (saved.trim() !== "") creds.claudeToken = saved.trim();
  }

  // Validate: at least one credential must be present (the worker can't run with
  // none). Keep the legacy Claude validation when a Claude token is the only cred.
  const hasAnyCred = Object.values(creds).some((v) => typeof v === "string" && v.trim() !== "");
  validateInstall(namespace, hasAnyCred ? "ok" : "", config.image);

  // 1. Namespace (idempotent; creates it when missing).
  ensureOk(await applyStdin(context, namespaceYAML(namespace)), `Failed to create namespace ${namespace}`);

  // 2. Legacy token Secret first (only when a Claude OAuth token is present) so a
  //    bad token can be rolled back without reapplying RBAC, and existing installs
  //    that read CLAUDE_CODE_OAUTH_TOKEN from this Secret keep working.
  if (creds.claudeToken) {
    const issuedAt = new Date().toISOString();
    ensureOk(await applyStdin(context, secretYAML(creds.claudeToken, issuedAt, namespace)), "Failed to create token Secret");
  }

  // 3. Multi-key credentials Secret (the other providers + an Anthropic API key).
  ensureOk(await applyStdin(context, credentialsSecretYAML(creds, namespace)), "Failed to create credentials Secret");

  // 4. RBAC + ConfigMaps (seeded with role + limit keys) + Deployment.
  const result = await applyStdin(context, manifestYAML(config));
  ensureOk(result, "Failed to apply manifests");
  return result;
}
```
> DECISION: `validateInstall` is reused with a sentinel `"ok"`/`""` token argument so its image/namespace checks still run while the "must have a credential" rule moves up (a Claude token is no longer mandatory — a Gemini-only install is valid). The token-specific message in `validateInstall` only fires when NO credential at all is present.

- [ ] Run it, expect PASS: `pnpm --filter @rigel/server test`

- [ ] Typecheck: `pnpm --filter @rigel/server typecheck` (expect PASS)

- [ ] Commit:
```
git add apps/server/src/assistant.ts apps/server/src/assistant.test.ts
git commit -m "feat(server): install writes credentials Secret + seeds role/limit config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7 — server: `setModels` (live role switch) + `setCredentials` (re-apply Secret + restart)

`setModels` is a read-modify-write of the role keys in `assistant-config` (live, no restart — the agent re-reads every poll). `setCredentials` re-applies the credentials Secret AND, when a Claude token is supplied, re-stamps the legacy token Secret, then rollout-restarts (env injection needs a fresh pod). `updateToken` becomes a thin alias of `setCredentials` so existing callers keep working.

**Files:**
- Modify: `apps/server/src/assistant.ts` (add `setModels`, `setCredentials`; rewrite `updateToken` as an alias; lines 291-313)
- Modify (test): `apps/server/src/assistant.test.ts`

**Steps:**

- [ ] Write the failing tests (these assert on the PURE update-map the server builds, via the k8s builder, so no cluster is touched). Append to `apps/server/src/assistant.test.ts`:
```ts
import { setModelsUpdates, setCredentialsSecrets } from "./assistant";

test("setModelsUpdates produces the assistant-config role keys for a worker-only switch", () => {
  const updates = setModelsUpdates({
    action: "setModels",
    worker: { provider: "codex", model: "gpt-5-codex" },
  });
  expect(updates).toEqual({ workerProvider: "codex", workerModel: "gpt-5-codex" });
});

test("setModelsUpdates includes both roles + effort when supplied", () => {
  const updates = setModelsUpdates({
    action: "setModels",
    worker: { provider: "claude", model: "claude-sonnet-4-6", effort: "medium" },
    supervisor: { provider: "gemini", model: "gemini-2.5-pro" },
  });
  expect(updates).toEqual({
    workerProvider: "claude", workerModel: "claude-sonnet-4-6", workerEffort: "medium",
    supervisorProvider: "gemini", supervisorModel: "gemini-2.5-pro",
  });
});

test("setCredentialsSecrets builds the credentials Secret YAML (+ legacy token YAML when claudeToken present)", () => {
  const out = setCredentialsSecrets(
    { action: "setCredentials", credentials: { geminiApiKey: "g-1", claudeToken: "tok" } },
    "agents",
    new Date("2026-06-23T00:00:00Z"),
  );
  expect(out.credentialsYaml).toContain("name: rigel-assistant-credentials");
  expect(out.credentialsYaml).toContain('geminiApiKey: "g-1"');
  expect(out.credentialsYaml).toContain('claudeToken: "tok"');
  // Legacy token Secret is also re-stamped (so existing CLAUDE_CODE_OAUTH_TOKEN refs refresh).
  expect(out.legacyTokenYaml).not.toBeNull();
  expect(out.legacyTokenYaml).toContain("name: rigel-assistant-token");
  expect(out.legacyTokenYaml).toContain('token: "tok"');
});

test("setCredentialsSecrets emits no legacy token YAML when no claudeToken", () => {
  const out = setCredentialsSecrets(
    { action: "setCredentials", credentials: { codexApiKey: "c-1" } },
    "default",
    new Date(),
  );
  expect(out.legacyTokenYaml).toBeNull();
  expect(out.credentialsYaml).toContain('codexApiKey: "c-1"');
});
```

- [ ] Run it, expect FAIL: `pnpm --filter @rigel/server test`

- [ ] Add the pure builders + the handlers to `apps/server/src/assistant.ts`. Place the pure builders near `buildInstallConfig` (after it), and the async handlers near `updateToken`:
```ts
/** Pure: the assistant-config role-key updates for a setModels request. */
export function setModelsUpdates(req: AssistantRequest): Record<string, string> {
  return roleConfigUpdates(req.worker, req.supervisor);
}

/** Pure: the Secret YAML(s) a setCredentials request applies. Always the
 *  credentials Secret; additionally the legacy token Secret (re-stamped) when a
 *  Claude OAuth token is supplied, so existing CLAUDE_CODE_OAUTH_TOKEN refs refresh. */
export function setCredentialsSecrets(
  req: AssistantRequest,
  namespace: string,
  now: Date,
): { credentialsYaml: string; legacyTokenYaml: string | null } {
  const creds = parseCredentials(req);
  const credentialsYaml = credentialsSecretYAML(creds, namespace);
  const legacyTokenYaml = creds.claudeToken
    ? secretYAML(creds.claudeToken, now.toISOString(), namespace)
    : null;
  return { credentialsYaml, legacyTokenYaml };
}
```
And the handlers (place `setModels`/`setLimits` near `setMode`, and rewrite `updateToken` lines 291-305):
```ts
/** Live role switch: read-modify-write the role keys in assistant-config. No
 *  restart — the agent re-reads the ConfigMap every poll. */
async function setModels(
  context: string | null,
  namespace: string,
  req: AssistantRequest,
): Promise<RunResult> {
  const updates = setModelsUpdates(req);
  if (Object.keys(updates).length === 0) {
    throw new Error("setModels requires a worker and/or supervisor selection.");
  }
  return patchConfig(context, namespace, updates);
}

/** Re-apply the credentials Secret (+ legacy token Secret when a Claude token is
 *  supplied), then rollout-restart so the new env vars are injected. Generalizes
 *  the old token-only updateToken. */
async function setCredentials(
  context: string | null,
  namespace: string,
  req: AssistantRequest,
): Promise<RunResult> {
  const creds = parseCredentials(req);
  if (Object.values(creds).every((v) => !v || v.trim() === "")) {
    throw new Error("setCredentials requires at least one credential.");
  }
  const { credentialsYaml, legacyTokenYaml } = setCredentialsSecrets(req, namespace, new Date());
  if (legacyTokenYaml) {
    ensureOk(await applyStdin(context, legacyTokenYaml), "Failed to update token Secret");
  }
  ensureOk(await applyStdin(context, credentialsYaml), "Failed to update credentials Secret");
  const result = await restartAgent(context, namespace);
  ensureOk(result, "Credentials saved, but rollout failed");
  return result;
}
```
Rewrite `updateToken` (lines 291-305) as a thin backward-compat alias:
```ts
/** Backward-compat alias: an old token-only update routes through setCredentials
 *  (which re-stamps the legacy token Secret + the credentials Secret, then rolls). */
async function updateToken(
  context: string | null,
  namespace: string,
  token: string,
): Promise<RunResult> {
  if (token.trim() === "") {
    throw new Error("Paste a fresh token from `claude setup-token` first.");
  }
  return setCredentials(context, namespace, { action: "setCredentials", token: token.trim() });
}
```

- [ ] Run it, expect PASS: `pnpm --filter @rigel/server test`

- [ ] Typecheck: `pnpm --filter @rigel/server typecheck` (expect PASS)

- [ ] Commit:
```
git add apps/server/src/assistant.ts apps/server/src/assistant.test.ts
git commit -m "feat(server): setModels (live) + setCredentials (re-apply Secret + restart)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8 — server: `setLimits` (live limit change) + dispatch wiring

`setLimits` is a read-modify-write of the limit keys in `assistant-config` (live, no restart — the agent reads `rc.limits` each tick after Task 9). Wire all three new actions into `handleAssistant`'s switch (and route `updateToken` through its alias).

**Files:**
- Modify: `apps/server/src/assistant.ts` (add `setLimits`; `handleAssistant` switch lines 351-380)
- Modify (test): `apps/server/src/assistant.test.ts`

**Steps:**

- [ ] Write the failing tests. Append to `apps/server/src/assistant.test.ts`:
```ts
import { setLimitsUpdates } from "./assistant";

test("setLimitsUpdates produces only the provided limit keys, stringified", () => {
  const updates = setLimitsUpdates({
    action: "setLimits",
    limits: { pollIntervalMs: 60000, maxPerNight: 10, namespaces: ["default"] },
  });
  expect(updates).toEqual({ pollIntervalMs: "60000", maxPerNight: "10", namespaces: "default" });
});

test("setLimitsUpdates throws-worthy empty input is detectable (no keys)", () => {
  expect(setLimitsUpdates({ action: "setLimits" })).toEqual({});
});
```

- [ ] Run it, expect FAIL: `pnpm --filter @rigel/server test`

- [ ] Add to `apps/server/src/assistant.ts` (pure builder near `setModelsUpdates`):
```ts
/** Pure: the assistant-config limit-key updates for a setLimits request. */
export function setLimitsUpdates(req: AssistantRequest): Record<string, string> {
  return limitsConfigUpdates(req.limits ?? {});
}
```
And the handler near `setModels`:
```ts
/** Live limit change: read-modify-write the limit keys in assistant-config. No
 *  restart — the agent reads rc.limits each tick. */
async function setLimits(
  context: string | null,
  namespace: string,
  req: AssistantRequest,
): Promise<RunResult> {
  const updates = setLimitsUpdates(req);
  if (Object.keys(updates).length === 0) {
    throw new Error("setLimits requires at least one limit field.");
  }
  return patchConfig(context, namespace, updates);
}
```

- [ ] Wire the switch in `handleAssistant` (lines 351-380). Add cases (and route `updateToken` through the alias, which already calls `setCredentials`):
```ts
    case "updateToken":
      return updateToken(context, namespace, req.token ?? "");
    case "setModels":
      return setModels(context, namespace, req);
    case "setCredentials":
      return setCredentials(context, namespace, req);
    case "setLimits":
      return setLimits(context, namespace, req);
```

- [ ] Run it, expect PASS (all server tests): `pnpm --filter @rigel/server test`

- [ ] Typecheck: `pnpm --filter @rigel/server typecheck` (expect PASS)

- [ ] Commit:
```
git add apps/server/src/assistant.ts apps/server/src/assistant.test.ts
git commit -m "feat(server): setLimits action + dispatch wiring for the new actions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9 — agent: make the CircuitBreaker limits live via `updateLimits`

The breaker's caps (`maxPerResourcePerHour`/`maxPerNight`/`maxAttemptsPerIncident`) are currently fixed at construction. To make them live, add an `updateLimits(partial)` method that mutates the held config IN PLACE while preserving the rolling `history` — so a limit change takes effect next tick WITHOUT discarding the action history (a reconstruct-per-tick would reset history and wrongly re-allow capped actions). `windowMs` stays deploy-time (it is not in `OperationalLimits` / not user-exposed). The `cfg` field changes from `readonly` to mutable.

**Files:**
- Modify: `agent/src/guardrails.ts` (`CircuitBreaker` class lines 34-79)
- Modify (test): `agent/src/guardrails.test.ts`

**Steps:**

- [ ] Write the failing test. Append to `agent/src/guardrails.test.ts`:
```ts
describe("CircuitBreaker.updateLimits (live limit changes)", () => {
  const cfg = { maxPerResourcePerHour: 2, maxPerNight: 5, maxAttemptsPerIncident: 3, windowMs: 24 * HOUR };

  test("a raised per-resource cap takes effect WITHOUT losing history", () => {
    const cb = new CircuitBreaker(cfg);
    cb.record("fp1", "default/memos", 0);
    cb.record("fp2", "default/memos", 10);
    expect(cb.canAct("fp3", "default/memos", 20).allowed).toBe(false); // capped at 2
    cb.updateLimits({ maxPerResourcePerHour: 5 });
    // History (the two prior records) is preserved, but the cap is now 5 → allowed.
    expect(cb.canAct("fp3", "default/memos", 20).allowed).toBe(true);
  });

  test("a lowered nightly cap takes effect immediately", () => {
    const cb = new CircuitBreaker({ ...cfg, maxPerResourcePerHour: 99, maxAttemptsPerIncident: 99 });
    for (let i = 0; i < 3; i++) cb.record(`fp${i}`, `default/r${i}`, i);
    expect(cb.canAct("fpX", "default/rX", 6).allowed).toBe(true); // under nightly 5
    cb.updateLimits({ maxPerNight: 3 });
    expect(cb.canAct("fpX", "default/rX", 6).allowed).toBe(false); // now at the lowered cap
  });

  test("updateLimits ignores undefined fields (a partial update keeps the rest)", () => {
    const cb = new CircuitBreaker(cfg);
    cb.updateLimits({ maxPerNight: 99 });
    cb.record("loop", "default/api", 0);
    cb.record("loop", "default/api", 1);
    cb.record("loop", "default/api", 2);
    // maxAttemptsPerIncident is untouched (still 3) → blocked.
    expect(cb.canAct("loop", "default/api", 3).allowed).toBe(false);
  });
});
```

- [ ] Run it, expect FAIL (no `updateLimits`): `npm --prefix agent test -- guardrails`

- [ ] Edit `agent/src/guardrails.ts`. Change the constructor field to mutable and add `updateLimits`:
```ts
export class CircuitBreaker {
  private readonly history: ActionRecord[] = [];

  constructor(private cfg: CircuitBreakerConfig) {}

  /**
   * Update the live caps in place, preserving the action history. Only defined
   * fields are applied (a partial update keeps the rest). windowMs is deploy-time
   * and not part of the user-exposed OperationalLimits, so it is not changed here.
   * Called each tick from the runtime config so a limit edit goes live next poll.
   */
  updateLimits(limits: {
    maxPerResourcePerHour?: number;
    maxPerNight?: number;
    maxAttemptsPerIncident?: number;
  }): void {
    if (limits.maxPerResourcePerHour !== undefined) this.cfg.maxPerResourcePerHour = limits.maxPerResourcePerHour;
    if (limits.maxPerNight !== undefined) this.cfg.maxPerNight = limits.maxPerNight;
    if (limits.maxAttemptsPerIncident !== undefined) this.cfg.maxAttemptsPerIncident = limits.maxAttemptsPerIncident;
  }

  /** Decide whether an action may run now, without recording it. */
  canAct(fingerprint: string, resourceKey: string, now: number): Verdict {
```
(Leave the rest of `canAct` / `record` unchanged.)

- [ ] Run it, expect PASS: `npm --prefix agent test -- guardrails`

- [ ] Typecheck: `npm --prefix agent run typecheck` (expect PASS)

- [ ] Commit:
```
git add agent/src/guardrails.ts agent/src/guardrails.test.ts
git commit -m "feat(agent): CircuitBreaker.updateLimits — live caps preserving history

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10 — agent: wire `rc.limits` into the poll loop + circuit breaker

This is the deferred Plan 1 wiring. `tick()` currently reads `cfg.confirmPolls`, `cfg.maxConcurrentDiagnoses`, and filters with `cfg.namespaces`; `detectAll` does not use namespaces (it lists `-A` then `tick` filters); `main()` builds the breaker from static `cfg` and the loop sleeps `cfg.pollIntervalMs`. Wire the LIVE values from `rc.limits`: filter incidents with `rc.limits.namespaces`, use `rc.limits.confirmPolls` for the confirmation gate, and call `cb.updateLimits(rc.limits)` at the top of each tick. The sleep interval stays `cfg.pollIntervalMs` (changing the loop's own cadence live needs the loop to read the ConfigMap before sleeping — out of scope; `pollIntervalMs` remains in `rc.limits` for the agent's self-report + future use, and a change still takes effect on the next restart). `maxConcurrentDiagnoses` is NOT in `OperationalLimits`, so it stays `cfg.maxConcurrentDiagnoses` (deploy-time). Behavior is identical when no ConfigMap override exists (parseLimits falls back to `cfg`).

> DECISION on pollIntervalMs: making the SLEEP live would require re-reading the ConfigMap at the end of each tick or restructuring `main()`'s loop to read `rc` before sleeping. Keep it deploy-time for this plan to stay minimal and avoid a double ConfigMap read per tick; `setLimits` changing `pollIntervalMs` takes effect on the next pod restart (and the value is correctly seeded/patched). The namespaces, confirmPolls, and the three breaker caps ARE live, which covers the user-facing "monitor namespaces / confirm polls / max per resource / max per night / attempts" knobs from the spec's Operational limits list.

**Files:**
- Modify: `agent/src/index.ts` (`tick` signature + body lines 96-195; `cb.updateLimits` call ~line 105; namespace filter ~line 80-83 moves into `tick`)
- Modify (test): no `index.test.ts` exists and adding one is out of scope (the loop wires real IO; the limit-plumbing units are covered by Tasks 9 + runtimeConfig's existing tests). This task is verified by typecheck + the full suite staying green.

**Steps:**

- [ ] Edit `agent/src/index.ts`. The `detectAll` function takes `cfg` but only uses `nsArgs(cfg)` (which always returns `["-A"]`) — leave `detectAll` as-is (it lists cluster-wide). The namespace FILTER currently lives inside `detectAll` (lines 80-83). MOVE the namespace filtering out of `detectAll` into `tick` so it can use the LIVE `rc.limits.namespaces`. First, remove the filter block from `detectAll` (lines 80-83):
```ts
  // (removed) namespace filtering moved to tick() so it uses the LIVE rc.limits.namespaces
```
So `detectAll` now ends:
```ts
  let incidents: Incident[] = [];
  if (podsRes.code === 0) incidents.push(...detectUnhealthyPods(parsedPods));
  if (depsRes.code === 0) incidents.push(...detectDegradedDeployments(parsedDeps));
  log(
    `detect: pods exit=${podsRes.code} (${podsRes.stdout.length}b) deps exit=${depsRes.code} (${depsRes.stdout.length}b) → ${incidents.length} incident(s) before filter` +
      (incidents.length ? `: ${incidents.map((i) => `${i.namespace}/${i.name}:${i.reason}`).join(", ")}` : "") +
      (podsRes.code !== 0 ? ` | pods stderr: ${podsRes.stderr.slice(0, 200)}` : ""),
  );
  return { incidents, pods, deps, podsOk: podsRes.code === 0, depsOk: depsRes.code === 0 };
}
```

- [ ] In `tick()` (after `const rc = await readRuntimeConfig(cfg);`, line 105), push the live breaker limits:
```ts
  const rc = await readRuntimeConfig(cfg);
  // Live operational limits: push the breaker caps from the ConfigMap (defaults
  // to the deploy-time Config when unset — see parseLimits), so a setLimits edit
  // goes live next tick without a restart.
  cb.updateLimits(rc.limits);
```

- [ ] In `tick()`, after the `const detection = await detectAll(cfg);` line (~line 121), apply the LIVE namespace filter that used to live in `detectAll`, combined with the existing silenced filter (lines 121-122). Replace:
```ts
  const detection = await detectAll(cfg);
  const incidents = detection.incidents.filter((i) => !rc.silenced.has(fingerprint(i)));
```
with:
```ts
  const detection = await detectAll(cfg);
  // Live namespace scope from rc.limits (was deploy-time cfg.namespaces in detectAll).
  const nsAllow = rc.limits.namespaces;
  const scoped = nsAllow.length > 0
    ? detection.incidents.filter((i) => i.namespace === "" || nsAllow.includes(i.namespace))
    : detection.incidents;
  const incidents = scoped.filter((i) => !rc.silenced.has(fingerprint(i)));
```

- [ ] In `tick()`, replace the two `cfg.confirmPolls` reads with `rc.limits.confirmPolls`. Line 177:
```ts
    return (loop.streaks.get(fp) ?? 0) >= rc.limits.confirmPolls && !loop.handled.has(fp);
```
and the log on line 181:
```ts
    log(`tick: ${incidents.length} present, confirmPolls=${rc.limits.confirmPolls}, streaks=[${[...loop.streaks.entries()].map(([k, v]) => `${k}=${v}`).join("; ")}], ${confirmed.length} confirmed, ${loop.handled.size} handled`);
```

- [ ] Leave `cfg.maxConcurrentDiagnoses` (line 192) and the loop sleep `cfg.pollIntervalMs` (line 530) unchanged — these stay deploy-time per the decision note above.

- [ ] Typecheck: `npm --prefix agent run typecheck` (expect PASS — watch for `noUncheckedIndexedAccess`; `nsAllow.includes`/`rc.limits.*` are not index accesses so should be clean).

- [ ] Run the FULL suite, expect all PASS: `npm --prefix agent test`

- [ ] Commit:
```
git add agent/src/index.ts
git commit -m "feat(agent): wire live rc.limits into the poll loop (namespaces/confirmPolls/breaker)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11 — web: extend the `AssistantRequest` TYPE (no UI)

The server contract now accepts `worker`/`supervisor`/`credentials`/`limits` and the three new actions. Mirror that in the web `AssistantRequest` type + `AssistantAction` union so callers (Plan 3's UI) compile against it. NO React components in this plan.

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`AssistantAction` lines 315-329; `AssistantRequest` lines 331-358)
- Modify (test): no dedicated test (it's a type-only change verified by typecheck). If a typecheck-on-types pattern exists, none asserts on this union today; rely on `pnpm --filter web typecheck`.

**Steps:**

- [ ] Edit `apps/web/src/lib/api.ts`. Add the three actions to `AssistantAction` (lines 315-329), before `"silence"`:
```ts
export type AssistantAction =
  | "install"
  | "uninstall"
  | "setMode"
  | "kill"
  | "updateToken"
  | "setModels"
  | "setCredentials"
  | "setLimits"
  | "restart"
  | "silence"
  | "unsilence"
  | "clearReport"
  | "clearActivity"
  | "setSignal"
  | "saveAlert"
  | "deleteAlert"
  | "toggleAlert";
```

- [ ] Add the new fields + the supporting types to `AssistantRequest` (after `confirmPolls?: number;`, line 342). Declare the shapes inline (the web package does not import `@rigel/k8s` types directly here; keep it self-contained to match the file's existing style):
```ts
  // Multi-provider control plane (Plan 2). provider is a plain string (the four
  // agent ids: claude | codex | gemini | opencode); effort is Claude-family only.
  worker?: AssistantRoleSelection;
  supervisor?: AssistantRoleSelection;
  credentials?: AssistantCredentials;
  limits?: AssistantLimits;
```
And declare the supporting interfaces just above `AssistantRequest` (before line 331):
```ts
export interface AssistantRoleSelection {
  provider: string;
  model: string;
  effort?: string;
}

/** Provider credentials → the rigel-assistant-credentials Secret keys. */
export interface AssistantCredentials {
  claudeToken?: string;
  anthropicApiKey?: string;
  codexApiKey?: string;
  geminiApiKey?: string;
  opencodeApiKey?: string;
  opencodeAuthContent?: string;
}

export interface AssistantLimits {
  pollIntervalMs?: number;
  maxPerResourcePerHour?: number;
  maxPerNight?: number;
  maxAttemptsPerIncident?: number;
  confirmPolls?: number;
  namespaces?: string[];
}
```

- [ ] Typecheck: `pnpm --filter web typecheck` (expect PASS)

- [ ] Commit:
```
git add apps/web/src/lib/api.ts
git commit -m "feat(web): extend AssistantRequest type for multi-provider control plane

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12 — Full cross-package verification

Run every affected package's test + typecheck to confirm the whole control plane is green together (the agent suite separately, since it is outside the workspace).

**Files:** none (verification only).

**Steps:**

- [ ] k8s: `pnpm --filter @rigel/k8s test && pnpm --filter @rigel/k8s typecheck` — expect ALL green.

- [ ] server: `pnpm --filter @rigel/server test && pnpm --filter @rigel/server typecheck` — expect ALL green.

- [ ] web (type-only change): `pnpm --filter web typecheck` — expect green.

- [ ] agent: `npm --prefix agent test && npm --prefix agent run typecheck` — expect ALL green (the existing Plan 1 suite + the new guardrails tests; the index.ts wiring is covered by typecheck + the unchanged-behavior of the existing runtimeConfig/guardrails suites).

- [ ] Sanity grep — confirm the exact contract keys are present where they must be:
```
grep -n "workerProvider\|supervisorProvider\|workerModel\|supervisorModel" packages/k8s/src/assistant.ts
grep -n "CLAUDE_CODE_OAUTH_TOKEN\|ANTHROPIC_API_KEY\|CODEX_API_KEY\|GEMINI_API_KEY\|OPENCODE_API_KEY\|OPENCODE_AUTH_CONTENT" packages/k8s/src/assistant.ts
grep -n "rc.limits" agent/src/index.ts
```
Expect: the role keys + all six provider env vars in the k8s manifest, and `rc.limits` read in the agent loop.

- [ ] No commit (verification task). If anything is red, fix forward with a focused commit before declaring done.

---

## Done criteria

- `pnpm --filter @rigel/k8s test`, `pnpm --filter @rigel/server test`, `pnpm --filter web typecheck`, and `npm --prefix agent test` are all green; every package's `typecheck` passes (k8s/server/web via pnpm; agent via `npm --prefix agent run typecheck`).
- The Deployment injects all six provider env vars (`CLAUDE_CODE_OAUTH_TOKEN` from the legacy Secret, optional; `ANTHROPIC_API_KEY`/`CODEX_API_KEY`/`GEMINI_API_KEY`/`OPENCODE_API_KEY`/`OPENCODE_AUTH_CONTENT` from `rigel-assistant-credentials`, all optional) — a missing credential never blocks startup.
- A fresh `install` seeds `assistant-config` with the role keys (`workerProvider`/`workerModel`/`supervisorProvider`/`supervisorModel` + effort when set) and the limit keys (`pollIntervalMs`/`maxPerResourcePerHour`/`maxPerNight`/`maxAttemptsPerIncident`/`confirmPolls`/`namespaces`).
- `setModels` and `setLimits` patch `assistant-config` live (no restart); `setCredentials` re-applies the credentials Secret (+ legacy token Secret when a Claude token is given) and rollout-restarts; `updateToken` still works as an alias.
- Backward compat: existing installs keep their `rigel-assistant-token`/`token` → `CLAUDE_CODE_OAUTH_TOKEN` env working untouched; nothing requires the new credentials Secret to exist (every ref is `optional: true`).
- The agent loop reads `rc.limits.namespaces` + `rc.limits.confirmPolls` each tick and pushes `rc.limits` into the CircuitBreaker, so those limits are live; behavior is identical when no ConfigMap override exists (parseLimits falls back to the deploy-time Config).
- No live-cluster mutations were run to verify — every server action is asserted via the pure builders it composes (`credentialsSecretYAML`, `roleConfigUpdates`, `limitsConfigUpdates`, `buildInstallConfig`, `setModelsUpdates`, `setCredentialsSecrets`, `setLimitsUpdates`), per the project policy.
