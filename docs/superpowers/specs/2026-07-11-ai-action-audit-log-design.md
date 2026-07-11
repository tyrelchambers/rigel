# AI-action audit log (HELM-18)

Records every action Rigel's AI surfaces take, so users can review what was done, when, why, and with what outcome. This is a trust/accountability feature for AI-driven changes.

Two AI surfaces take actions:

- **Desktop AI chat / copilot** — action blocks run through the ConfirmSheet (scale, restart, delete, apply). Currently writes **no durable record anywhere** — this is the gap.
- **In-cluster AI Assistant** — the autonomous remediation agent. Already writes a rich, durable audit ledger to the `assistant-state` ConfigMap, surfaced in the Assistant → Activity tab.

This design gives the chat surface the same durable ledger the agent already has, then folds both into the existing **Events panel** as one tagged, time-sorted list — merged with the panel's existing live native Kubernetes events. It also reworks the **Activity tab** into a flat interleaved timeline.

## Decisions

- **Persistence = per-surface ConfigMap ledgers (single writer each).** The agent keeps its existing `assistant-state` ledger unchanged. A **new `rigel-chat-actions` ConfigMap ledger** is written **only by the server** for chat actions. Single-writer-per-ledger avoids cross-process read-modify-write races. Both ride the configmaps WS watch the app already runs; the audit lives cluster-side, so any desktop that connects sees the same history.
- **No Kubernetes Event emission.** AI actions appear in the panel in real time (the configmaps watch pushes updates instantly) *and* survive past Kubernetes's ~1h Event TTL, all from the ledger. No dedup logic needed.
- **Unify at the presentation layer.** Storage stays per-surface; the Events panel merges both ledgers + live native events into one list, tagged by actor.
- **Native events remain transient and untagged by us.** A user-run command (e.g. a rollout) does not produce one taggable "Rigel did this" event — it triggers a cascade of native events from different controllers (`deployment-controller`, `replicaset-controller`, `kubelet`), each stamped by Kubernetes with its own source and no causal link back to the command. We do **not** retag those. Manual command effects are covered by the panel's existing live native-event window, exactly as today.
- **Activity tab = flat interleaved timeline** — the agent's rich action cards interleaved chronologically with surrounding native events.

## Architecture

### Chat-actions ledger (the new durable store)

New ConfigMap in the install namespace, labeled `rigel.dev/ledger=ai-actions`, e.g. `rigel-chat-actions`, key `log.json` → `AiActionEntry[]`, newest-first, capped ring buffer (~200 entries). Modeled on the existing `assistant-state` and apply-batch ledger patterns.

`AiActionEntry` (shared type in `packages/k8s`):

| Field | Value / ticket mapping |
|---|---|
| `id` | unique (`crypto.randomUUID`) |
| `at` | ISO timestamp |
| `source` | `"chat"` (actor tag) |
| `kind` | action kind — `Scaled`, `Restarted`, `Deleted`, `Applied`, `RolledOut`, … |
| `target` | `{ kind, name, namespace }` |
| `command` | exact kubectl/command run |
| `trigger` | originating prompt (best-effort) |
| `outcome` | `"success" \| "failure"` |
| `detail` | short stdout/stderr summary (optional) |

This subsumes the ticket's required per-entry capture (action kind, target + namespace, trigger/which-AI, exact command, timestamp, outcome). The agent surface reuses its existing `AuditEntry` shape (which is richer: proposal, analysis, backupRef/Revert); the panel maps both to a common row model.

**Server wiring.** Append to the ledger after the command runs, at the chat execution seams:
- REST: `apps/server/src/index.ts:432-472` (`POST /api/action`).
- WS streaming: `apps/server/src/actionRunManager.ts` (the `action.run` handler).

The server is a single Node process, so serialize all ledger writes through an in-process async queue (read → prepend → cap → `kubectl apply` the ConfigMap). This fully eliminates the read-modify-write race even for batch confirms (`BatchConfirmSheet`). Ledger-write failure must never fail the action — log and continue.

Read/write helpers for the ledger live in `packages/k8s` (mirroring `assistant.ts` decode + `applyBatch.ts` ledger conventions).

### Events panel

File: `apps/web/src/panels/events/EventsPanel.tsx` (+ `eventsDisplay.ts`, `types.ts`).

1. **Remove the graph.** Delete: `EventTimeline` + `TimelineBar` (359-425), the render site (217-220), the `buckets` memo (136-139), `bucketTimeRange` (76-89), the `TIMELINE_SPAN_SECONDS` / `TIMELINE_BUCKETS` consts (45-46), and now-unused imports (`addMinutes`, `format`, `Popover*`, `eventBuckets`, `EventBucket`).
2. **Merge three row sources into one time-sorted list**, mapped to a common row model:
   - live native K8s events from the store (unchanged — the panel's existing transient ~1h window),
   - `rigel-chat-actions` ledger entries (from the configmaps store), tagged actor **AI Chat**,
   - `assistant-state` audit entries (already in the configmaps store), tagged actor **Assistant**.
3. **Actor tag badge** on the two ledger-sourced row types, visually distinct from the native Normal/Warning status badge. Native events render as today (no actor tag).
4. **Filter pill** — extend the existing type filter with an "AI actions" option that shows only ledger-sourced rows.
5. **Row expand** shows the full `command` + `trigger` for ledger rows.

The panel stays presentation-only — it never writes; the server/agent own the ledgers.

### Assistant Activity tab

Files: `apps/web/src/panels/assistant/tabs/ActivityTab.tsx`, `useAssistant.ts`.

- Keep the rich audit-ledger cards (`ActivityCard`) as the primary content.
- Build a **flat interleaved timeline**: merge the agent's ledger entries with the **native** cluster events from the store, sorted newest-first, scoped to the window spanning the shown ledger entries (from the timestamp of the oldest currently-shown audit entry through now). When no audit entries exist, the timeline is empty, matching today's behavior.
- Native events render as compact rows between the rich action cards, so cause→effect reads naturally ("Restarted deploy/api" → "Killing pod …" → "Started container …").
- "See all", "Clear all", badge count behavior unchanged.

### RBAC

- The server's context needs `create`/`update`/`get` on `configmaps` in the install namespace — it already writes ConfigMaps for manifest applies, so this is likely already satisfied; confirm.
- No agent RBAC change (the agent surface is unchanged).

## UI design

Per project convention, design the two visual changes in **Pencil first**, then implement screen-for-screen in Tailwind + tokens:
- Events panel: the graph removed, the merged list with actor tag badges, the "AI actions" filter pill.
- Activity tab: the interleaved timeline (rich card + compact native-event row rhythm).

## Testing

- Unit: `AiActionEntry` builder (correct `kind`/`target`/`outcome`/`command`).
- Unit: ledger read-modify-write — prepend order, cap/ring-buffer truncation, serialized writes.
- Unit: actor-to-badge mapping + panel merge sort.
- Unit: Activity interleave — sort order, window scoping.
- Do **not** execute live mutation endpoints to verify — exercise builders and merge logic via unit tests and reads (per project rule).

## Out of scope

- **Manual / in-app-Terminal command capture.** Commands you run yourself are reflected via the panel's live native events (transiently), not the durable ledger.
- **Native cluster-event archival** beyond Kubernetes's ~1h TTL — a separate event-retention feature.
- **Kubernetes Event emission** for AI actions — superseded by the ledger.
- Changing the agent's `AssistantAuditEntry` / `AuditEntry` wire shape.
