# Matrix channel for the Rigel assistant (design)

Date: 2026-06-27
Status: Approved (design), pending implementation plan
Branch: `feat/matrix-channel`
Pencil design: `clankerlocal.pen` frames `wDsq8` (Settings section), `egncz` (Step 1),
`EQobU` / `cWrYd` (Step 2A token / login), `wf6XS` (Step 2B public), `KWBf1` (install),
`sNhKw` (reachable), `tXkqG` (first contact), `sfqdY` (connected), `rsCnp` / `Nv2aQ` /
`jL2NU` / `eR4gO` (error states), `s0gXT` (connecting).

## Summary

Let a user text Rigel's in-cluster assistant agent over Matrix to query (and, with
approval, act on) their Kubernetes cluster, from any Matrix client on their phone. Matrix
is a new chat channel that sits next to the existing Signal channel; both are configured
independently and can be live at the same time. A setup wizard in the desktop app connects
the agent to a homeserver, and optionally installs and exposes a Synapse homeserver inside
the cluster for users who do not already have one.

## Background and the key insight

The assistant agent (`agent/`, deployed as `rigel-assistant`) already does exactly this
over Signal: it polls for inbound messages each tick, routes a command, queries the cluster
read-only through Claude, and replies. The Signal bridge works for everyone with no inbound
cluster exposure because `signal-cli` connects **outbound** to Signal's servers.

Matrix has the same shape. The agent connects **outbound** to a homeserver as a bot account
(`@rigel`), and the user's phone connects to that **same** homeserver. The homeserver is the
meeting point. It does not have to live in, or expose, the cluster. That single fact is what
makes this feature tractable and is the spine of the design: the only real decision is
**where the homeserver lives**, and exposure/Tailscale only matter on the one path where
Rigel hosts the homeserver itself.

Three pieces from the agent are already solved and reused as-is:

- **AI auth.** The agent runs `claude` with `CLAUDE_CODE_OAUTH_TOKEN` from a Secret
  (subscription, no API key), spawned directly so nothing scrubs the env. No auth wall.
- **Cluster access.** ServiceAccount + RBAC give broad read-only access plus a few gated
  mutations. The read-only `diagnose` path already answers cluster questions.
- **Inbound/command pattern.** `signalInbound.ts` (receive, de-dup, route command, reply)
  and the `Command` union (`help | status | queue | approve <N> | diagnose`) are transport
  agnostic and reused for Matrix verbatim.

## Scope

In scope:

- **Query + approve (full Signal parity).** Read-only cluster Q&A via `diagnose`, plus
  `status`, `queue`, and `approve <N>` to greenlight the autonomous agent's proposed,
  already-gated remediations. No new mutation path is introduced; `approve` runs through the
  same guardrails as the autonomous loop.
- **Coexistence with Signal.** Matrix is an independent channel. Signal stays. Both can be
  configured and active simultaneously; the agent polls whichever channels are enabled.
- **Connect to a homeserver** the agent dials out to (existing, public, or in-cluster).
- **In-cluster install + exposure** of a Synapse homeserver for users without one.
- **Desktop wizard + Settings section** to drive all of the above.

Out of scope (follow-ons): direct destructive actions over text without the approve queue;
end-to-end-encrypted rooms on the agent side (see "Room and encryption"); multi-cluster fan
out of a single bot (the bot serves the cluster it runs in).

## The three "where the homeserver lives" paths

| Path | User provides | Privacy | Exposure / Tailscale |
| --- | --- | --- | --- |
| **A. Existing homeserver** | its URL + a bot login | Full (they own it) | None, agent dials out |
| **B. Public homeserver (matrix.org)** | a bot account | Lower: the host can read an unencrypted room | None, agent dials out |
| **C. Rigel installs Synapse in-cluster** | a way to reach it | Full (they own it) | Required: Tailscale or Ingress |

Path A is the happy default for self-hosters (and for the author, who already has a
homeserver with `@rigel` reserved). Path B is the zero-infra option with an honest privacy
caveat. Path C is the advanced branch where exposure lives.

## Architecture

### Agent side (in-cluster `rigel-assistant`)

Mirror the Signal integration, transport-only changes:

- `agent/src/notify.ts`: add `notifyMatrix(homeserver, accessToken, roomId, text)` next to
  `notifySignal`. Sends via the Matrix client-server API
  (`PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}`). Best-effort, never
  throws, chunks long replies.
- `agent/src/matrixInbound.ts` (new, mirrors `signalInbound.ts`): receive via
  `GET /_matrix/client/v3/sync` with a stored `since` token; de-dup by Matrix `event_id`;
  filter to the allowed-senders allowlist; reuse `parseCommand` and the existing
  `InboundHandlers` (help/status/queue/approve/diagnose). One poll per tick.
- `agent/src/runtimeConfig.ts`: add `matrixHomeserverUrl`, `matrixUserId` (the bot id),
  `matrixAccessToken` (or read from a Secret), `matrixRoomId`, `matrixAllowedSenders` (CSV),
  `matrixInbound` (bool, default false) to the `assistant-config` ConfigMap read each tick.
  The access token lives in a Secret, not the ConfigMap.
- `agent/src/index.ts`: in the tick, dispatch Matrix notifications in `flushNotifications`
  and call `handleMatrixInbound` alongside `handleSignalInbound`. Both channels run if
  enabled; neither blocks the other.

The agent is single-pod with a `since`-token cursor; persist the sync cursor in
`assistant-state` (next to existing state) so a restart does not reprocess or miss events.

### Auth model (three independent layers)

- **Agent to homeserver.** A bot access token, stored in a Kubernetes Secret. Obtained two
  ways in the wizard: the user pastes a token they already created, or Rigel performs the
  Matrix login (`POST /_matrix/client/v3/login` with username + password), keeps the
  returned token, and discards the password.
- **User to homeserver.** The user's normal Matrix client login. Rigel does not touch it.
- **Who may command the bot.** An allowlist of Matrix IDs (`matrixAllowedSenders`). Inbound
  messages from anyone else are ignored. This is non-negotiable: without it, anyone who can
  reach the homeserver could drive the cluster agent. Mirrors `signalRecipients`.

On path C the homeserver also gets a network gate: Tailscale exposure makes it reachable
only from the user's tailnet, on top of Matrix auth. Public Ingress has no network gate, so
registration must be off and accounts locked down.

### Room and encryption

The agent uses an **unencrypted room** and plain HTTP, exactly like the Signal bridge. It
does not implement megolm. Because most Matrix clients (notably Element X) refuse to create
unencrypted rooms, **Rigel provisions the room during setup**: the wizard, acting as the bot
with the bot token, creates an unencrypted room, invites the allowed user(s), and stores the
room id in `assistant-config`. The agent then simply reads and writes that room. The user
accepts the invite in their client and chats there. The "first contact" wizard step reflects
this (Rigel created a room and invited you). Room creation lives server-side (in the desktop
app's server, next to the other Matrix API calls), not in the agent, since the bot token and
the guided setup flow both live there.

Privacy follows the path: on a homeserver the user owns (A or C) the room content sits only
on their own server, and transport is TLS over the tailnet or in-cluster, so nothing third
party sees plaintext. On a public homeserver (B) an unencrypted room means the host can read
it; the wizard states this plainly on the Step 2B screen. E2E on the agent side is a
documented future enhancement, not v1.

This decision is informed directly by the OpenClaw integration, where the matrix plugin
silently dropped encrypted messages until `encryption: true` was set. We avoid that class of
problem by keeping the agent's room unencrypted and agent-provisioned.

### In-cluster install and exposure (path C)

- **Install.** Rigel deploys Synapse into the cluster (Deployment + Service + persistent
  storage for media and the SQLite/Postgres store). For a single-user assistant homeserver,
  prefer the simplest viable database; the plan will decide SQLite vs a bundled Postgres.
  Create the bot account (`@rigel`) and the user's account via the registration shared
  secret, and reserve `@rigel`.
- **Exposure.** The user's phone must reach the in-cluster homeserver:
  - Detect the Tailscale operator (its ingressClass / CRDs). If present, offer
    "Private via Tailscale" (tailnet-only, automatic TLS, no domain or DNS). Recommended.
  - Otherwise, "Public via Ingress" using an ingress controller + cert-manager on a domain
    the user enters.
  - If neither is available, the wizard explains the requirement; Rigel detects and uses
    Tailscale but does not install it (that needs the user's Tailscale account and auth key).

### Desktop app (Settings + wizard)

- A `MatrixSection` in the Settings panel, mirroring `SignalSection`'s state machine
  (not connected / connected / error), so both channels coexist visually. Resting states are
  the `wDsq8` frame.
- The connect/install flow is the wizard (`egncz` onward). Built as a Dialog/Modal (the app
  uses modals, not slide-in sheets), as a sibling of the cloud-connect modals.
- The wizard reuses one modal shell + a **dynamic stepper**: the total adapts to the chosen
  path (3 steps for bring-your-own, 4 for install). Step 1 shows no total because the path
  is not yet chosen.

### Server control plane

- A `setMatrix` action in `apps/server/src/assistant.ts`, mirroring `setSignal`:
  read-modify-write of `assistant-config` (only provided fields), plus writing the access
  token Secret. Pure config-update helpers in `packages/k8s` (mirror `signalConfigUpdates`).
- Path C adds server endpoints to apply the Synapse manifests, run account creation, detect
  Tailscale, and apply the chosen exposure (Ingress or Tailscale ingress).

## The wizard flow

```
1. Where should Rigel's Matrix live?            (egncz, "Step 1")
     A) I already have a homeserver      -> 2A
     B) Use a public one (matrix.org)    -> 2B
     C) Install it in my cluster         -> install

2A. Connect existing homeserver          (EQobU token / cWrYd login, "Step 2 of 3")
     URL + bot auth (paste token OR log in) + allowed senders
2B. Public homeserver                    (wf6XS, "Step 2 of 3")
     matrix.org + bot account + privacy callout + allowed senders

install. Installing Synapse              (KWBf1, "Step 2 of 4")
         Database -> Homeserver -> Accounts -> Done
reachable. Make it reachable             (sNhKw, "Step 3 of 4")
         Tailscale (detected) vs Ingress (+ domain)

3/4. First contact                       (tXkqG, "Step 3 of 3" or "Step 4 of 4")
     Rigel provisions a room + invites you; live Waiting -> Received -> Replied

Connected (success)                      (sfqdY)
     Summary: homeserver, bot id, allowed senders, Enabled toggle, Done
```

States: authentication failed, homeserver unreachable, install failed, could not expose,
and a generic connecting/loading state, each on the terminal (stepper-free) modal shell.

## Coexistence with Signal

Matrix and Signal are independent config blocks and independent Settings sections. The agent
tick polls every enabled inbound channel and `flushNotifications` dispatches to every enabled
outbound channel. Enabling one does not require or disable the other. The shared
command-routing and handler logic is reused unchanged; only the transports differ.

## Testing

- Pure functions first: `parseCommand` reuse, Matrix event parsing/de-dup
  (`matrixInbound`), `matrixConfigUpdates` read-modify-write, allowlist filtering. Inject the
  receive/reply/send IO via the existing handler interface so logic is testable without a
  homeserver.
- Server `setMatrix` action: mock the kubectl/IO layer, assert only provided fields are
  written and the token Secret is created (mirror the `setSignal` tests).
- Detection: Tailscale-operator detection returns the right exposure options.
- No live homeserver calls in tests; the author's homeserver is the manual end-to-end check.

## Phasing (the implementation plan will expand this)

1. **Connect (core).** Agent `notifyMatrix` + `matrixInbound` + config + wiring;
   `MatrixSection` + `setMatrix`; the connect wizard paths A and B; room provisioning and
   first-contact. Delivers a working `@rigel` against any homeserver, no exposure needed.
2. **Install + expose (path C).** Synapse manifests + install flow, account creation,
   Tailscale detection and the two exposure modes, the install/reachable wizard screens.

## Out of scope and follow-ons

- E2E-encrypted rooms on the agent side (megolm in the agent).
- Direct destructive actions over text outside the approve queue.
- Installing Tailscale itself (only detect and use it).
- A bot serving more than its own cluster.

## References

- Pencil design: `clankerlocal.pen` (frames listed at top).
- Signal integration mirrored: `agent/src/notify.ts`, `agent/src/signalInbound.ts`,
  `agent/src/runtimeConfig.ts`, `agent/src/index.ts`, `apps/server/src/assistant.ts`,
  `apps/web/src/panels/settings/SettingsPanel.tsx`, `packages/k8s/src/signal.ts`.
- Homeserver groundwork: `docs/superpowers/specs/2026-06-26-matrix-homeserver-design.md`.
- OpenClaw encryption lesson (why the agent room is unencrypted + agent-provisioned).
