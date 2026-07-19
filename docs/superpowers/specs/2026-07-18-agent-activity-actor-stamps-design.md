# Actor stamps on agent activity (HELM-96)

**Status:** Design approved, pending spec review
**Origin:** HELM-96 "Investigate: surface Kubernetes audit logging in Rigel" — the "who did what" attribution gap. Investigation narrowed the scope (see below).

## Problem

Rigel's Recent Activity feed shows actions the in-cluster autonomous agent takes, but every entry is visually indistinguishable regardless of who initiated it. You cannot tell an action the AI decided and executed *on its own* from an action the agent executed *because you approved it in chat*, or from an autofix that *opened a PR*. The user wants each activity entry stamped with its actor.

## Investigation outcome (why the scope is small)

The original ticket framed this as enabling Kubernetes API-server audit logging (a control-plane change on the k3s server + a log-ingestion pipeline). Investigation established:

1. The only actor of interest is the **in-cluster autonomous agent** (`agent/`), not raw-kubectl / external identities. So no API-server audit logging, no control-plane flag change, and no user-identity resolution are required.
2. The agent **already records every cluster mutation it performs**, durably. All mutations flow through a single choke point (`executeAction`, `agent/src/executor.ts:21`) and are written as an `AuditEntry` into the `assistant-state` ConfigMap via the shared `record()` funnel (`agent/src/index.ts:992`).
3. The desktop app **already reads and renders** that ledger live (ConfigMap watch, decoded by `decodeClusterState`) in three surfaces: the Overview "Recent activity" card, the assistant Activity tab, and the compact audit row.

The single missing piece is an **actor field** on the audit entry, plus a badge to render it. Nothing else needs to be built.

## Scope

**In scope:** stamp each activity entry with the actor that initiated it, and render that stamp.

**Out of scope (explicitly):** k8s API-server audit logging; identity resolution for humans / CI tokens / external kubectl; distinguishing chat-assistant-in-desktop-app from human-clicks (they share a kubeconfig identity and are not a target); attributing changes made outside Rigel.

## Actor taxonomy

Three stamps:

| `source` value | Stamp label | Icon | Meaning |
|---|---|---|---|
| `autonomous` | Autonomous | `fa-robot` | Agent decided and executed on its own (LOW auto-execute or MEDIUM after Opus supervisor approval). |
| `chat` | Approved by you | `fa-user` | Agent executed because the user asked for / approved the action in chat. |
| `pr` | Opened a PR | `fa-code-pull-request` | Autofix dispatched a fix Job that opened a GitHub PR. |

## Design

### 1. Data model

Add one optional field, `source`, to the audit record in both the agent's own type and the shared/decoded type.

- `agent/src/state.ts` — `AuditEntry` (currently `state.ts:17-31`) gains:
  `source?: "autonomous" | "chat" | "pr"`
- `packages/k8s/src/assistant.ts` — `AssistantAuditEntry` (currently `assistant.ts:889-901`) gains the same field.
- `decodeClusterState` (`packages/k8s/src/assistant.ts:~1000`) reads `source` through when decoding `state.json`.

The field is **optional**. Entries written before this ships have no `source`.

### 2. Population (agent side)

Thread `source` through the shared `record()` funnel (`agent/src/index.ts:992-1005`) so each call site sets it once, and `appendAudit` persists it.

- **Autonomous path** — the execution branch at `agent/src/index.ts:739`, whose success/failure entries are recorded at `index.ts:745-760`, sets `source: "autonomous"`.
- **Chat-approved path** — `executeChatAction` (`agent/src/index.ts:885-921`, entry written around `905-912`) sets `source: "chat"`.
- **Autofix PR path** — the terminal `AuditEntry` written by `reconcileFixJobs` (`agent/src/reconcileFixJobs.ts:159-169`) sets `source: "pr"`. (The separate `PullRequestRecord` in the `pullRequests` list is unchanged.)

### 3. Rendering

A single small actor-badge helper, reused across all three surfaces, styled to match the existing tier pill (same pill dimensions/typography already used for `tier` in `ActivityCard.tsx`). Font Awesome Pro icons only (`FontAwesomeIcon`), per the app's icon standard.

Surfaces to update (they already render `AssistantAuditEntry`):
- `apps/web/src/panels/assistant/components/ActivityCard.tsx`
- `apps/web/src/panels/assistant/components/RecentActivityCard.tsx`
- `apps/web/src/panels/assistant/components/AuditRow.tsx`

Badge mapping: `autonomous` → "Autonomous" (`fa-robot`); `chat` → "Approved by you" (`fa-user`); `pr` → "Opened a PR" (`fa-code-pull-request`).

### 4. Legacy entries

Entries with no `source` (written before this ships) render **no actor stamp**. We do **not** invent a default actor for them — a missing `source` is left as undefined and simply omits the badge.

## Testing

- **Decode round-trip** (`packages/k8s`): a `state.json` fixture whose audit entries carry each of the three `source` values decodes to `AssistantAuditEntry` with `source` preserved; an entry with no `source` decodes to `source: undefined`.
- **Agent stamping** (`agent/`): assert the autonomous execution path stamps `"autonomous"`, `executeChatAction` stamps `"chat"`, and the `reconcileFixJobs` terminal entry stamps `"pr"`. Extend existing tests around `record()` / `executeChatAction` / `reconcileFixJobs` rather than adding parallel suites.
- **Render**: the badge helper maps each `source` to the correct label/icon and renders nothing when `source` is undefined.

## Data flow (unchanged plumbing, one new field)

```
agent tick
  ├─ autonomous execute (index.ts:739) ─┐
  ├─ executeChatAction (index.ts:905)   ├─ record() (index.ts:992) → appendAudit → AuditEntry{ …, source }
  └─ reconcileFixJobs (159-169) ────────┘
        │
        ▼  writeState → assistant-state ConfigMap (state.json)
        │
   /ws configmaps watch → Zustand store → decodeClusterState (source read through)
        │
        ▼
   ActivityCard / RecentActivityCard / AuditRow → actor badge
```

## Files touched (summary)

- `agent/src/state.ts` — `AuditEntry.source`
- `agent/src/index.ts` — set `source` on autonomous + chat call sites through `record()`
- `agent/src/reconcileFixJobs.ts` — set `source: "pr"` on the terminal entry
- `packages/k8s/src/assistant.ts` — `AssistantAuditEntry.source` + `decodeClusterState`
- `apps/web/src/panels/assistant/components/{ActivityCard,RecentActivityCard,AuditRow}.tsx` — actor badge
- Tests in `packages/k8s` and `agent`
