# Cluster Assistant — user-selectable AI providers (per role)

Status: design approved 2026-06-22.
Branched from: `feat/multi-agent-codex` (this feature reuses the chat's `agentRegistry`, `agentModels`, and brand `AgentGlyph`, which live on that branch and are not yet merged to master).

## Goal

Let the user choose which AI provider and model runs the in-cluster **Cluster Assistant**
(the autonomous remediation agent), with credentials they supply — parity with the chat's
Claude / Codex / Gemini / OpenCode choice. Primary driver: **choice / parity**, not cost or a
single missing provider.

The Assistant runs the model in **two independent roles**, and the user picks a provider + model
for each:

- **Worker** — investigates an incident and proposes a fix (also drives the Signal/text Q&A path).
- **Supervisor** — a second model that adversarially reviews risky proposed actions before they run.

Roles may use **different providers** (e.g. Gemini worker + Claude supervisor), so a different
model double-checks risky actions.

## Background — current state (what we build on)

- The Assistant runs in-cluster as the `rigel-assistant` **Deployment** (single replica, `Recreate`
  strategy — single writer to its state ConfigMaps), polling every `POLL_INTERVAL_MS` (~30s).
- It calls the model through the **`claude` CLI** (`spawn("claude", …)` in `agent/src/claude.ts`),
  via `runClaude()` used by `agent/src/worker.ts`, `supervisor.ts`, and `diagnose.ts`. It is not an
  SDK. The supervisor uses `--json-schema` for a structured verdict; `diagnose` uses `--resume` for
  session threading; investigation is held read-only with `--allowedTools`.
- Auth: `CLAUDE_CODE_OAUTH_TOKEN` from Secret `rigel-assistant-token` (key `token`), a headless
  `claude setup-token`.
- Models are env vars `WORKER_MODEL` / `SUPERVISOR_MODEL` (default `claude-sonnet-4-6` /
  `claude-opus-4-8`), **read only at startup** — not in the UI today; changing them needs a restart.
- Runtime config lives in the `assistant-config` ConfigMap and is **re-read every poll** (live, no
  restart): `enabled`, `mode`, `window`, `webhookUrl`, `silenced`, Signal settings, `alertRules`.
- The web **Assistant tab** (`apps/web/src/panels/assistant/`) installs and configures the agent by
  POSTing to `/api/assistant` → `handleAssistant` → kubectl apply/patch via `buildKubectlArgs`
  (user's kubeconfig/context). Manifests are generated in `packages/k8s/src/assistant.ts`. Today's
  token update re-applies the Secret and `rollout restart`s the Deployment.

## Key research finding — auth (2026-06-22)

Only **Claude** offers a "mint a portable token, paste it into a Secret" subscription model
(`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`, ~1-year, first-party, fully portable). The
others do not:

- **Codex** — clean headless path is an **API key** (`CODEX_API_KEY` for `codex exec`). A copied
  ChatGPT `~/.codex/auth.json` works in a container and OpenAI documents it, but it self-refreshes
  (needs a writable mount, can't be shared across replicas); OpenAI recommends the API key for
  automation.
- **Gemini** — **API key** (`GEMINI_API_KEY`, free-tier works). Its OAuth-file copy is buggy and
  explicitly unsupported headless.
- **OpenCode** — **API key(s)** via env (it routes to sub-providers; also a one-env-var
  `OPENCODE_AUTH_CONTENT` blob).

Vendors actively block consumer-subscription logins in third-party/server automation (Anthropic
server-side blocks subscription tokens used by non-Claude clients; Google flags third-party OAuth
for abuse). **Conclusion: API keys are the durable, ToS-safe auth path for every provider except
first-party Claude**, which keeps its `setup-token` (or may use `ANTHROPIC_API_KEY`).

## Decisions

1. **Approach 1 — CLI bridges in the image.** Bake each provider's CLI into the Assistant image and
   add a thin per-provider bridge, mirroring the chat's `runAgent` pattern. The CLI runs the
   read-only `kubectl` investigation for us. (Rejected: calling provider APIs/SDKs directly and
   re-implementing the tool loop — larger surface, diverges from the chat, higher risk.)
2. **All four providers** (Claude, Codex, Gemini, OpenCode) for parity with the chat.
3. **Per-role provider + model, roles independent** (mixing allowed).
4. **Auth = API keys** in a multi-key Secret; Claude also accepts its `setup-token`.
5. **Rich config surface** managed from the Assistant tab (providers, models, credentials, and the
   operational knobs that are install-time-only today). Designed in Pencil first (see UI section).

## Architecture

### 1. Config & data model

Two roles, configured independently:

- `worker` → `{ provider, model, effort? }`
- `supervisor` → `{ provider, model, effort? }`

`provider` reuses the chat's `AgentId` (`claude | codex | gemini | opencode`). `effort` applies only
to Claude-family models.

Where each piece lives:

- **Role selections** → the `assistant-config` ConfigMap (already re-read every poll). Switching
  provider/model **between already-credentialed providers is live, no restart.**
- **Credentials** → a new Secret `rigel-assistant-credentials`, one key per credential the user has
  entered: `claudeToken`, `anthropicApiKey`, `codexApiKey`, `geminiApiKey`, and OpenCode
  (`opencodeApiKey` or `OPENCODE_AUTH_CONTENT` blob). The Deployment injects each as its env var
  with `secretKeyRef … optional: true`, so missing credentials never block startup.
- **Restart rule:** changing provider/model/limits = live (config); adding or rotating a credential
  = rollout-restart (to inject/refresh the env var) — the same flow today's token update uses.

**Backward compatibility:** existing installs (Secret `rigel-assistant-token`/`token`, env
`WORKER_MODEL`/`SUPERVISOR_MODEL` = sonnet/opus) keep working untouched. If `assistant-config` has
no role keys, the agent defaults to `worker = claude/sonnet`, `supervisor = claude/opus` and reads
the legacy token (mapped to `claudeToken`). Nothing breaks on upgrade.

### 2. In-cluster agent abstraction (`agent/`)

Replace the direct `runClaude()` calls in `worker.ts` / `supervisor.ts` / `diagnose.ts` with a
single dispatch:

```
runModel({ role, prompt, allowedReads, systemPrompt, structuredSchema?, signal })
  → reads the role's { provider, model, effort } from runtime config
  → selects the provider bridge, builds its argv + auth env
  → runs it through the shared process harness
  → returns a normalized { text, structuredOutput?, sessionId?, isError }
```

**Per-provider bridges** (new, `agent/src/providers/{claude,codex,gemini,opencode}.ts`), each
handling the three things that differ between CLIs:

- **Read-only investigation** stays enforced via the **guarded-kubectl shim** (ported from the chat)
  on `PATH`, plus each CLI's auto-approve flag (`codex` `approval_policy=never`, `gemini`
  `--approval-mode yolo`, OpenCode permission config); Claude keeps `--allowedTools`. This matters
  because the agent's RBAC *can* patch deployments / delete pods (for the deterministic execution
  phase), so the model must be prevented from mutating during investigation.
- **Structured verdict** (supervisor): Claude uses `--json-schema`; the others get a strict
  "reply with only this JSON" instruction + parse, with **one reprompt** on parse failure.
  Normalized to the same verdict object.
- **Session resume** (diagnose/Signal): Claude `--resume`; the others run fresh per turn (documented
  limitation, same as Gemini in the chat).

**Output collection:** Claude (`--output-format json`) and Gemini (`-o json`) return a single JSON
envelope; Codex and OpenCode stream JSONL — the bridge collects events and extracts the final
message (reusing the event-mapping learnings from the chat's `codexBridge`/`opencodeBridge`).

**Image:** the Assistant image gains `codex` (musl binary), `gemini` (npm — Node is already in the
image), `opencode` (Bun binary), and the guarded-kubectl shim. A startup self-check logs which CLIs
are present.

### 3. Server (`/api/assistant`)

Extend `handleAssistant` (`apps/server/src/assistant.ts`) and the manifest generator
(`packages/k8s/src/assistant.ts`):

- **install**: accept `worker` + `supervisor` (`{provider, model, effort?}`) and a credentials map →
  write the multi-key Secret, seed the role selections into `assistant-config`, apply manifests. The
  Deployment env gains every provider's var via `secretKeyRef … optional: true`; role models come
  from config (the hardcoded `WORKER_MODEL`/`SUPERVISOR_MODEL` env become a fallback only).
- **new `setModels`**: read-modify-write the role keys in `assistant-config` (live, no restart).
- **generalize `updateToken` → `setCredentials`**: re-apply the Secret keys + rollout-restart.
- **new `setLimits`** (optional, for the exposed operational knobs): patch the corresponding
  `assistant-config` keys (live). Limits the agent reads at startup today move to runtime config so
  they can be live.

### 4. UI — Assistant tab (Pencil first)

Designed in Pencil (`/Users/tyrelchambers/Desktop/clankerlocal.pen`, frame
**"Assistant — Agents & Providers"** `fo4qH`) before any code — the .pen is the visual/interaction
source of truth. A new **"Agents"** section in the Assistant panel (the install flow reuses the same
controls), reusing the chat's `agentRegistry`, `agentModels`, and brand `AgentGlyph`:

- **Per-role cards** (Worker, Supervisor): provider picker, model picker, reasoning-effort segment
  (Claude-family only), and a credential-status chip ("Key ready" / "Add key").
- **Credentials manager**: a row per provider with status (Key ready / Not set) and Add/Update;
  noted as stored in a Kubernetes Secret. Only providers a role uses need a key.
- **Operational limits** (newly exposed, were install-time-only): poll interval, max per
  resource/hr, max per night, attempts per incident, confirm polls, monitor namespaces. May be
  tucked behind an "Advanced" disclosure if it proves too much.
- **Footer**: the live-vs-restart rule + Save.

The single-token field in `InstallView` is replaced by these role + credential controls; defaults
stay Claude/Sonnet + Claude/Opus so the out-of-box experience is unchanged. `SettingsTab` gains the
same management controls post-install.

### 5. Error handling

- **Missing credential for a selected provider** → that role **fail-closes** (does nothing) and
  surfaces a clear status in the tab: e.g. "Worker provider Gemini has no key — add it."
- **Runtime auth failure** → generalize the current Claude-only auth-error regex to per-provider
  detection, reusing the chat's de-noising (suppress transient retries).
- **Malformed verdict from a non-Claude supervisor** → one reprompt, then **fail-closed to
  "escalate" (queue for a human) — never auto-approve on a bad verdict.** Safety-critical.
- **Provider CLI absent in the image** → role fail-closes with a clear message; startup self-check
  logs what's present.

### 6. Testing

- **`agent/`**: each bridge's arg-builder + output parser (batch + JSONL); the structured-verdict
  fallback (valid / malformed → reprompt → escalate); runtime-config role parsing; the
  credential→env mapping. No live-cluster mutations (per project policy — verify via the command
  builder/classifier, never by running mutations against a real cluster).
- **`packages/k8s`**: the Deployment carries the optional `secretKeyRef` env for every provider;
  config seeding is correct.
- **`apps/server`**: install writes the right Secret keys + ConfigMap; `setModels`/`setLimits` patch
  config with no restart; `setCredentials` re-applies the Secret + rollout-restart.
- **web**: InstallView / SettingsTab render the role pickers and credential rows; the `useAssistant`
  mutations.

## Components & boundaries

- `agent/src/runModel.ts` — role→provider dispatch, returns a normalized result. Depends on runtime
  config + the bridges.
- `agent/src/providers/{claude,codex,gemini,opencode}.ts` — one bridge per provider: argv builder +
  output parser + auth env. Each understandable/testable in isolation.
- `agent/src/runtimeConfig.ts` — extended to parse the per-role `{provider, model, effort}` and the
  exposed limits.
- `packages/k8s/src/assistant.ts` — manifest generator: multi-key Secret env (optional), config
  seeding.
- `apps/server/src/assistant.ts` — `/api/assistant` actions: install, setModels, setCredentials,
  setLimits.
- `apps/web/src/panels/assistant/` — the Agents management UI (per Pencil `fo4qH`).

## Risks / follow-ups

- **Image size** — baking three more CLIs grows the image. Gemini needs Node (already present);
  Codex (Rust/musl) and OpenCode (Bun) are single binaries. Acceptable; monitor size.
- **OpenCode complexity** — it's a router to sub-providers (keys per sub-provider, the
  `OPENCODE_AUTH_CONTENT` blob). It carries the most edge cases; if it proves messy, ship the other
  three first and add OpenCode last (the architecture supports deferring one provider).
- **Non-Claude session memory** — diagnose/Signal multi-turn is Claude-only this pass; others run
  fresh per turn. Follow-up if needed.
- **Branch dependency** — depends on the chat multi-agent work (`agentRegistry`/`agentModels`/
  `AgentGlyph`) on `feat/multi-agent-codex`, not yet merged to master.
- **Live verification** — runtime behavior with real provider auth in-cluster is unverified until a
  test cluster install; bridge logic is covered by unit tests against fake CLIs (per policy).

## Out of scope

- Changes to the chat agent.
- Providers beyond the four.
- Mounting copied subscription-OAuth credential files (`~/.codex/auth.json` etc.) — API keys only,
  per the research; revisit only if a user needs subscription billing in-cluster.
