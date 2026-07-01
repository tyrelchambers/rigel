# Scheduled cluster digests — design

**Status:** approved 2026-06-30
**Branch:** `feature/scheduled-digests`

## Context

The assistant already pushes incidents to a connected channel (Signal/Matrix/webhook) the moment they're
confirmed. That's the "something is on fire right now" path. What's missing is the calmer counterpart: a
**scheduled synopsis** you can wake up to. "It's 7am, here's how the cluster did while you were asleep, in one
message." Today you'd have to scroll back through per-incident pings or open the app and read the Activity log.

This feature lets a user subscribe to a recurring digest delivered to one of their connected channels, on a
schedule they pick, covering a lookback window they pick. It reuses three things that already exist: the channel
fan-out (`agent/src/notify.ts`), the `assistant-config`/`assistant-state` ConfigMap persistence pattern (same
shape as alert rules + PR history), and the agent's LLM call path (`runModel`). The only genuinely new pieces
are a small rolling **incident history** in state (so the digest can describe *everything* that happened, not
just what the agent acted on) and a per-subscription scheduler that runs inside the existing poll loop.

## Decisions

1. **Time model** — cadence + lookback. User picks days + send time (in their timezone); the digest covers
   "since the last digest" by default, or a fixed lookback (e.g. last 8h).
2. **Placement** — a new **Reports** sub-tab inside the Assistant panel (next to Rules / Auto Fix / Activity).
3. **Scope** — complete picture: every confirmed incident in the window (auto-fixed, queued, flagged, or
   resolved) + PRs opened + current health. Requires a new rolling incident history in `assistant-state`.
4. **Trigger** — scheduled push is primary, plus a "Send now / Preview" button.
5. **AI failure** — deterministic body + AI headline. The digest body is always a reliable structured summary the
   agent builds itself; the AI writes a short headline on top. If the AI call fails, the structured summary still
   sends (no headline). The AI is an enhancement, never a hard dependency.
6. **When paused** — digests fire even when the assistant's kill-switch is off. Reporting is observational, so it
   runs independently of remediation. This requires restructuring the tick loop.
7. **Scheduling mechanism** — no Kubernetes CronJob. The recurring timer rides the agent's existing ~30s poll
   loop: each tick asks "is any subscription due?" (missed-cron-in-a-poll-loop). A persisted `lastSentAt` makes
   it fire once per slot, restart-safe and DST-correct. A CronJob is rejected because a fresh short-lived pod
   lacks the agent's accumulated state, LLM credentials, and channel config; 30s granularity is more than enough;
   and every existing time-gated behavior (quiet hours, the 24h fix-PR budget, alert cooldowns) already lives in
   this loop.

## Architecture

**Responsibility split (mirrors the existing alert-rules feature):**
- **Agent** owns scheduling, assembly, the AI headline, the send, and `lastSentAt` persistence. It's the only
  component with the LLM path + the rolling state + live cluster reads.
- **Server** (`apps/server/src/assistant.ts`) only writes/deletes subscription *definitions* into
  `assistant-config` (new actions), exactly like `saveAlert`/`deleteAlert`. The agent never writes
  `assistant-config`.
- **Web** renders the Reports tab from the `assistant-config` watch (subscriptions) + `assistant-state` watch
  (`lastSentAt`/preview) and POSTs actions via the existing `useAssistantAction` → `/api/assistant`.

**Tick-loop restructure (the load-bearing change).** Today `tick()` returns early at `agent/src/index.ts:227`
when `!rc.enabled`, *before* detection. Split it into two phases:

- **Observe + report (always runs, regardless of `enabled`):** `detectAll()` → scope/silence filter →
  debounce/confirm → `touchIncident()` for confirmed incidents (creates `flagged`, never downgrades) and `resolveIncident()`
  for cleared fingerprints → **evaluate digest schedules** (`evaluateDigests`) → `writeState`. Keeps the incident
  history accruing and the morning digest firing even while remediation is paused.
- **Remediate (gated by `enabled`, unchanged behavior):** queue reconcile, alert-rule *live* notifications, Stage
  A/B triage + auto-fix/queue (the `record()` funnel, which *upgrades* a `flagged` incident's disposition to
  `autoFixed`/`queued`/`failed` via the same `recordIncident` upsert), `reconcileFixJobs`, inbound command
  handlers, `flushNotifications`.

Semantics of "paused": the agent still polls, detects, records history, and sends scheduled digests, but does
**not** take actions or send per-incident live notifications. Tradeoff: pausing no longer fully idles the agent.

## Data model

**A. Digest subscription — in `assistant-config`** (human-editable, one JSON key `digests`, like `alertRules`).
Source of truth: new `packages/k8s/src/digest.ts`; wire-mirror in `agent/src/digest.ts`.

```ts
interface DigestSubscription {
  id: string;            // server-assigned crypto.randomUUID()
  enabled: boolean;
  label: string;         // "Morning cluster digest"
  channel: "webhook" | "signal" | "matrix";
  days: number[];        // 0–6 Sun–Sat; daily = [0..6], weekly/custom = subset
  time: string;          // "HH:MM" in `timezone`
  timezone: string;      // IANA, default from browser at create
  lookback: { mode: "sinceLast" } | { mode: "fixed"; hours: number };
  createdAt: string;
}
```

**B. Incident history — in `assistant-state`** (agent-owned, like `pullRequests`). New field on `AssistantState`
and decode-only mirror on `AssistantClusterState`. Records are deliberately tiny (no `analysis`/`detail` blobs —
ConfigMap size):

```ts
interface IncidentRecord {
  at: string; lastSeenAt: string;
  fingerprint: string;        // kind|ns|name|reason
  location: string; reason: string;
  disposition: "autoFixed" | "queued" | "flagged" | "failed" | "resolved";
  resolvedAt?: string; note?: string;   // SHORT one-liner only
}
```

**C. Per-subscription send-state — in `assistant-state`** (agent-owned, like `matrixSince`):

```ts
interface DigestState {
  lastSentAt: Record<string, string>;   // subId -> ISO; restart-safe gating, prevents double-send
  lastRunNowToken?: string;              // idempotency for Send-now/Preview
  lastPreview?: { id: string; at: string; text: string };  // rendered text for the web to show
}
```

## Component changes

### Agent
New file `agent/src/digest.ts` (pure + one IO fn), unit-testable like `diagnose.ts`/`alerts.ts`:
- `isDigestDue(sub, lastSentAtISO, now)` — pure, DST-correct via `Intl.DateTimeFormat(undefined,{timeZone})`.
  Fires when today's weekday ∈ `days`, local minute-of-day ≥ `time`, and `lastSentAt` predates today's slot.
  Reuse minute-of-day parsing by extracting a `parseHHMM` from `parseWindow` (`runtimeConfig.ts:197`).
- `assembleDigestData(state, detection, sub, now)` — pure. Computes `windowStart` (sinceLast → `lastSentAt` or
  first-run default 24h; fixed → `now - hours`), filters `state.incidents`/`pullRequests`/`queue` by `at >=
  windowStart` (same rolling-window-by-`at` idiom as `countFixPrBudget`, `state.ts:208`), snapshots current
  health from *this tick's* `detection` (no new cluster reads).
- `renderDigestText(data)` — pure deterministic structured summary. **This is the always-sent body.**
- `renderDigestPrompt(data)` + `DIGEST_SYSTEM_PROMPT`, and `generateDigestHeadline(rc, data)` — the one IO fn:
  `runModel({ role: "worker", config: rc, prompt, systemPrompt, timeoutMs })`, copying `runDiagnosis`
  (`diagnose.ts:39`); no `allowedReads` (data is pre-assembled → one cheap call). On any error, return null and
  send the deterministic body alone.

New pure helpers in `agent/src/state.ts` (mirror `recordPullRequest` at `state.ts:183`):
- `recordIncident(state, rec, max)` — upsert by `fingerprint` SETTING disposition (remediate funnel); cap at
  `MAX_INCIDENTS` (~300), age-prune (>14d). `touchIncident(...)` — observe-phase sibling that creates `flagged`
  if new, else only refreshes `lastSeenAt` (never downgrades).
- `resolveIncident(state, fingerprint, at)` — mark matching open record `resolved`.
- `dispositionFromAudit(entry)` — map `outcome`+`tier`+`verdict` → disposition.

Hooks in `agent/src/index.ts` (funnel-based, minimal):
- Extend `record()` (`index.ts:902`) to also `recordIncident()` — single funnel for every confirmed-incident
  disposition in the remediate phase.
- Observe phase: `touchIncident(...)` for confirmed incidents; `resolveIncident()` for cleared
  fingerprints (the cleanup at `index.ts:292`).
- `evaluateDigests(rc, state, detection, now): Promise<AssistantState>` — new exported, tick-testable fn called
  in the observe phase before `writeState` (`index.ts:700`): for each `rc.digests`, if `isDigestDue` or a fresh
  `digestRunNow` token, assemble → headline → send via the `sub.channel` function from `notify.ts` (reuse the
  `flushNotifications` dispatch shape, `index.ts:973`) → set `lastSentAt`. Preview mode assembles + stores
  `lastPreview`, no channel send.
- Restructure the `!rc.enabled` early-return (`index.ts:227`) into the two-phase split.
- Parse `digests` + `digestRunNow` into `RuntimeConfig` in `readRuntimeConfig` (`runtimeConfig.ts:256`) with a
  tolerant `parseDigestsFromConfig` (malformed → `[]`).

### Server (`apps/server/src/assistant.ts`)
- Extend `AssistantAction` (`:102`) + `AssistantRequest` (`:126`) with `saveDigest | deleteDigest | toggleDigest |
  sendDigestNow` and fields `digest?`, `digestId?`, `digestEnabled?`, `digestMode?: "send" | "preview"`.
- `mutateDigests(...)` — near-clone of `mutateAlerts` (`:392`): read-modify-write `assistant-config` via
  `parseDigests` → `normalizeDigest` (validate channel/days/time, reject bad IANA via a `try Intl.DateTimeFormat`)
  → `nextDigests` → `serializeDigests` → `patchConfig` (`:335`).
- `sendDigestNow` — write `digestRunNow: {id, mode, token: randomUUID()}` into `assistant-config` via
  `patchConfig` (respects "agent never writes config"). The agent runs it on a new token. Idempotent,
  restart-safe, no agent→config write-back.
- Add the four `case`s in the `handleAssistant` switch (`:840`); mirror the union + fields in
  `apps/web/src/lib/api.ts` (no new endpoint — reuse `postAssistant`/`useAssistantAction`).

### Web — Reports tab (PENCIL-FIRST)
First UI step: design the Reports tab in Pencil before any TSX (frames don't exist yet; the .pen is the source
of truth and the implementation must reproduce it screen-for-screen). Lay out (1) the digest list (per-row enable
toggle / edit / delete / Send-now / Preview, with last-sent time) and (2) the create/edit form. Get sign-off,
then implement to match. shadcn primitives + Tailwind tokens only; Dialog/Modal for the editor, not Sheet.

Then:
- Register the tab: `TabKey` (`assistant/AssistantContext.tsx:33`), `tabs[]` (`assistant/components/TabBar.tsx:40`,
  label "Reports"), `switch` case (`assistant/components/TabContent.tsx:47`).
- New `apps/web/src/panels/assistant/tabs/ReportsTab.tsx` + a `DigestForm`, modeled on `RulesTab.tsx`/
  `AlertsCard.tsx`. Channel dropdown populated only from connected channels, reusing the derivation in
  `apps/web/src/panels/settings/useSettings.ts` (`deriveSignalBridgeStatus`/`deriveMatrixConnected` +
  `configData["webhookUrl"]` presence). Timezone defaults to
  `Intl.DateTimeFormat().resolvedOptions().timeZone`. Cadence = daily/weekly/custom day chips (0–6). Buttons call
  `useAssistantCtx().run({ action: ... })`.
- Surface data in `assistant/useAssistant.ts` derived state: parse `configData["digests"]` (new
  `parseDigestsFromConfig` web helper next to `parseAutofixFromConfig`) and read `clusterState.digestState`; add
  `digests` + `digestState` to `AssistantDerived` and `decodeClusterState` (`packages/k8s/src/assistant.ts`).

### Shared (`packages/k8s/src/digest.ts`, new)
`DigestSubscription` type + `parseDigests`/`serializeDigests`/`nextDigests`/`normalizeDigest`, mirroring
`packages/k8s/src/alerts.ts`. Plus the `decodeClusterState` additions for `digestState`/`incidents`.

## Reuse notes (extend, don't duplicate)
- Channels: call existing `notifyWebhook`/`notifySignal`/`notifyMatrix`; reuse the `flushNotifications` dispatch
  shape. No new send path.
- Scheduling: extract `parseHHMM` from `parseWindow`; reuse the rolling-window-by-`at` filter from
  `countFixPrBudget`.
- State caps: model `recordIncident` on `recordPullRequest`.
- Config R-M-W + validation/serialization: mirror `mutateAlerts`/`normalizeAlertRule`/`nextAlertRules`.
- LLM: reuse `runModel` (worker role), copy `runDiagnosis`. Don't touch `runClaude` or add a provider path.
- Web data flow: reuse `useAssistantCtx().run` + `postAssistant`; no new fetch wrapper.

## Testing (vitest — agent/server/web/k8s)
- `agent/src/digest.test.ts` (new): `isDigestDue` across timezones incl. DST spring-forward + fall-back; weekly/
  custom day filtering; `assembleDigestData` window boundaries; headline success + failure → body still renders.
- `agent/src/state.test.ts` (extend): `recordIncident` upsert/dedupe/cap/age-prune; `resolveIncident`;
  `dispositionFromAudit`.
- `agent/src/index.test.ts` (extend): drive `tick()` with `enabled` true *and* false → confirmed incident yields
  one `IncidentRecord` either way; remediation upgrades disposition; recovered fingerprint → `resolved`; due
  subscription → `lastSentAt` set + correct notify fn called; stale `digestRunNow` token → no re-send.
- `agent/src/runtimeConfig.test.ts` (extend): `parseDigestsFromConfig` tolerance.
- `packages/k8s` digest.test.ts (new): parse/serialize/next/normalize (reject bad timezone/time/days/channel) +
  `decodeClusterState` carries `digestState`.
- `apps/server/src/assistant.test.ts` (extend): `mutateDigests` R-M-W doesn't clobber other config keys;
  `sendDigestNow` writes a fresh token.
- `apps/web`: `ReportsTab` renders the list; channel dropdown only offers connected channels; buttons dispatch
  the right `AssistantRequest`.

## Verification (no live cluster mutations)
- Run the four vitest suites + typecheck/build.
- Drive `tick()` with mocked kubectl + mocked `runModel` + mocked notify functions to assert
  assembly/scheduling/persistence end-to-end with zero real writes.
- Web: exercise the Reports tab against a mocked WS store + mocked `postAssistant`, asserting emitted payloads.
- Snapshot-test the rendered deterministic body.
- Do not curl `/api/assistant` mutations against the live cluster. Verify UI via `pnpm --filter desktop dev` only
  if asked.

## Risks
- **ConfigMap size (highest):** `assistant-state` already approaches the ~1 MiB etcd limit in the worst case.
  `incidents[]` must store tiny records, cap ~300, age-prune. Validate realistic worst-case combined size.
- **Timezone/DST:** IANA per subscription + `Intl` is DST-correct; `lastSentAt` guard prevents fall-back
  duplicates. Validate the IANA string server-side in `normalizeDigest`.
- **Paused agent no longer idles:** documented tradeoff of decision 6.
- **Send-now latency:** up to one poll interval (~30s) + LLM time; show a "generating…" state.

## After implementation
- Update the app's Outline doc (Rigel collection) with the digests feature; derive Plane tickets (project Rigel /
  HELM) from it.
