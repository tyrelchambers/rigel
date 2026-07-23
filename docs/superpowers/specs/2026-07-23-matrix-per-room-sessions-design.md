# Per-room durable sessions for the Matrix bot

Date: 2026-07-23
Status: Approved (brainstorm) — pending implementation plan

## Summary

The in-cluster Assistant agent (`agent/`) acts as a Matrix bot. Today it polls a
single hard-coded room and threads conversation continuity **per sender** with a
1-hour idle reset, in memory. This project makes the bot hold **one independent,
durable conversation thread per room**: the operator spins up a topic by creating
a Matrix room and inviting the bot; each room gets its own `claude` CLI session
and context that survives idle time and agent pod restarts.

All work is in the `agent/` runtime and its Kubernetes manifest. **Synapse is not
touched** — the Matrix homeserver only relays messages; session state lives
entirely in the agent.

## Goals

- One bot identity, present in many rooms simultaneously.
- Each room is an independent thread: its own session id, its own context. A room
  for a topic; a different room for a different topic.
- Durable: a room's thread survives an idle gap and survives agent pod restarts
  (deploys, node moves, image updates). Come back days later, keep the context.
- Frictionless topic creation: invite the bot to a new room and it auto-joins and
  starts a fresh thread there.
- A manual per-room `/reset` to retire a topic's thread without deleting the room.

## Non-goals

- No changes to Synapse configuration or deployment.
- No change to the Signal inbound path's behavior (it keeps threading by sender).
- No multi-bot / cross-bot context sharing. This is about one bot across rooms.
- No reconstruction of context from Matrix room history (approach B, rejected):
  it is lossy (Matrix has only the bot's text replies, not its tool-call
  transcript) and a larger rewrite.

## Current architecture (baseline)

- `agent/src/matrixInbound.ts` — pure inbound core. `parseSyncEvents(raw, roomId)`
  filters a `GET /_matrix/client/v3/sync` payload down to **one** `roomId`,
  keeping `m.room.message` / `m.text` events. `handleMatrixInbound` de-dupes by
  `event_id` (`SeenEventIds`), drops non-allowlisted senders and the bot's own
  messages, then for each event calls `respondSafely(...)` and replies (chunked).
  Reply / read-receipt / typing handlers all target the one configured room.
- `agent/src/sessionStore.ts` — `SessionStore` maps a normalized key
  (`normalizeNumber(source)`) to `{ sessionId, lastActivityMs }`. `resumeIdFor`
  returns the session to resume if within a 1-hour TTL, else evicts. In-memory.
- `agent/src/threadedDiagnosis.ts` — uses `sessions.resumeIdFor(source, ts)` and
  `sessions.record(source, sessionId, ts)` to thread bursts as one CLI session.
- `agent/src/index.ts` — `handleMatrixInboundIO` wires real IO: sync/reply/
  markRead/setTyping against `m.roomId`; persists `matrixSince` cursor via
  `writeState(stateConfigMap, stateNamespace, {...})`. `SessionStore` constructed
  at `index.ts` with default TTL.
- `agent/src/providers/claude.ts` + `runModel.ts` — resume via `--resume`
  (`resumeSessionId`). The CLI stores transcripts under `$HOME/.claude/...`.
- Live deployment `rigel-assistant/rigel-assistant`: **no volumes**, no
  `volumeMounts`, no `HOME` override. Transcripts are on the ephemeral container
  filesystem and are lost on every pod restart. `MATRIX_ROOM_ID` env supplies the
  single room.

Key constraint discovered: persisting only the `sessionId` pointer is not enough.
`claude --resume <id>` needs the transcript file that `<id>` names; that file is
on ephemeral storage today. Durability requires persisting **both** the pointer
and the transcript.

## Design

### 1. Multi-room inbound (`matrixInbound.ts`)

- Add `roomId` to `MatrixEvent`.
- Replace the single-room filter with a parser that walks **all** `rooms.join.*`
  in the sync payload and emits events tagged with their originating `roomId`
  (same `m.room.message` / `m.text` filtering and malformed-skip behavior as
  today). The old single-room `parseSyncEvents` signature is removed; tests move
  to the multi-room shape.
- Parse `rooms.invite.*`. For each invited room, read the invite's
  `m.room.member` event in `invite_state.events` to find the **inviter**. Only if
  the inviter is on the sender allowlist, emit a "join this room" intent. Invites
  from anyone else are ignored (prevents strangers dragging the bot into rooms).
- `MatrixInboundHandlers` gains `join(roomId)`. `reply`, `markRead`, `setTyping`
  gain a `roomId` parameter so each action targets the originating room instead
  of one configured room.
- `handleMatrixInbound`:
  - First, auto-join any allowlisted invites (best-effort; a failed join logs and
    is retried on the next sync because the invite persists).
  - Then iterate joined-room events across all rooms; per event: skip if seen /
    from the bot / non-allowlisted; mark read + typing on `ev.roomId`; route to
    the turn with `ev.roomId` as the thread key; reply into `ev.roomId`.
  - Recognize a `/reset` message body (exact trimmed match, allowlisted sender):
    clear that room's stored session (see §2) and reply a short confirmation
    instead of running a model turn.
- `ctx.roomId` becomes optional/legacy and is no longer required for the loop to
  run; the loop is gated on homeserver + token only.

### 2. Per-room session keying + `/reset` (`sessionStore.ts`, `threadedDiagnosis.ts`)

- Introduce an explicit **thread key** distinct from `source` (the sender).
  `respondSafely` / the `respond` handler thread on a `threadKey`, defaulting to
  `source` when not provided. Signal passes nothing (→ threads by sender,
  unchanged). Matrix passes `roomId`.
- `SessionStore` keys are opaque strings — remove the built-in `normalizeNumber`.
  The Signal caller normalizes its number before calling; Matrix passes the raw
  `roomId`.
- Remove the idle-TTL eviction from `resumeIdFor` — per-room threads are durable
  and do not auto-expire. `clear(key)` remains (used by `/reset` and on a failed
  resume).
- `threadedDiagnosis.ts` uses the thread key in place of `source` for
  `resumeIdFor` / `record`.

### 3. Durable persistence (write-through state ConfigMap)

- `SessionStore` becomes write-through. Inject a persist function; on `record`
  and `clear`, write the full `threadKey → sessionId` map into the existing state
  ConfigMap under a new field (`threadSessions`), alongside `matrixSince`.
- On boot, hydrate `SessionStore` from `threadSessions` in state.
- Persistence stays injected (a function), so `sessionStore.test.ts` verifies
  persist/hydrate without touching Kubernetes.
- Write volume is one small ConfigMap write per new/cleared session — negligible
  at chat message rates.

### 4. Transcript PVC (deployment manifest)

- Add a 1Gi `ReadWriteOnce` PVC for the agent.
- Mount it at the `claude` CLI home dir and set `HOME` to the mount so transcripts
  (`$HOME/.claude/...`) persist across restarts. This also satisfies the known
  writable-`~/.claude` requirement.
- The agent runs the CLI from a stable working directory (fixed in the image) so
  the CLI's project-scoped transcript path is stable across restarts and
  `--resume` resolves.
- Because the PVC is RWO and the agent is single-replica, set the Deployment
  `strategy: Recreate` so the terminating pod releases the volume before the
  replacement mounts it (RollingUpdate would deadlock on the volume).

### 5. Config / env

- `MATRIX_ROOM_ID` is no longer required; if present it is ignored by the
  multi-room loop (kept harmless for backward compatibility, removed from docs).
- No new required env. The bot serves every room it is a member of.

## Data flow (per inbound poll)

1. `GET /sync?since=<cursor>` → parse all joined-room messages (tagged with
   `roomId`) + allowlisted invites.
2. Auto-join allowlisted invited rooms.
3. For each fresh, allowlisted message event:
   - `/reset` → `SessionStore.clear(roomId)` (write-through) + confirm reply.
   - otherwise → `resumeIdFor(roomId)` → run CLI turn (resume or fresh) →
     `record(roomId, newSessionId)` (write-through) → reply into `roomId`.
4. Persist the new `next_batch` cursor to state (as today).

## Error handling

- Sync failure: keep prior cursor, log, retry next poll (unchanged).
- Join failure: log, best-effort; invite persists so it retries next poll.
- Resume failure (e.g. transcript missing after a volume loss): `clear(roomId)`
  and start a fresh session for that room, so a room is never permanently wedged.
- Handler failure inside a turn becomes an error reply (unchanged
  `respondSafely`).
- The inbound path never throws into the remediation loop.

## Testing

- `matrixInbound.test.ts`:
  - Multi-room parse: events from several joined rooms each carry the right
    `roomId`; malformed rooms/events skipped.
  - Invite handling: auto-join emitted only when the inviter is allowlisted;
    ignored otherwise.
  - Per-room targeting: reply / markRead / setTyping receive the originating
    `roomId`.
  - `/reset`: clears the room's session and replies confirmation without a model
    turn.
  - Existing de-dupe / allowlist / own-message-skip behavior preserved.
- `sessionStore.test.ts`:
  - Per-room (opaque-key) keying; no TTL eviction.
  - Write-through persist called on `record` and `clear`; hydrate restores the
    map.
- `threadedDiagnosis.test.ts`:
  - Thread key routing: Matrix path threads by room, Signal path threads by
    sender.

## Verification

- `pnpm -C agent test` (agent is a standalone pnpm package, not in the workspace
  globs) — all suites pass.
- `pnpm -C agent build` — typechecks.
- Manifest: PVC + `HOME` mount + `strategy: Recreate` applied; agent rolls,
  transcripts survive a manual pod delete, and a topic room resumes context after
  the restart.

## Rollout notes

- Applying the PVC + `Recreate` strategy causes one restart of the agent.
- First deploy starts with an empty `threadSessions`; existing single-room
  conversation context (in-memory) is not migrated — the first message per room
  after rollout starts that room's durable thread.
