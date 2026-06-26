# Action progress streaming — Design

**Goal:** Replace the indefinite "Running: <label>" spinner toast for chat action buttons with a live, expandable progress toast that streams the command's output line-by-line as it runs, then settles into a Done/Error state.

**Pencil:** `Action progress toast` (frame `HhLEe` in clankerlocal.pen) — three states: running-collapsed (spinner + label + chevron-down), running-expanded (spinner + label + chevron-up + a sunken mono output panel streaming lines + a `█ streaming…` cursor), done (green check + label + `Done · N resources` meta; error flips red with the message). Approved 2026-06-26.

**Approach:** Mirror Rigel's existing, proven create-cluster streaming. Today actions run one-shot: `executeAction()` → `POST /api/action` → `kubectl()` which buffers all output until exit (`packages/k8s/src/run.ts` `collectProcess`), and `actionRunner.ts` shows a passive `toast.loading`. Create-cluster already streams over the WebSocket: `clusterCreateManager.ts` emits `{type:"cluster.progress", line}` / `cluster.done` / `cluster.error`, the client has `onClusterEvent` in `ws.ts`, and `CreateClusterModal` accumulates lines. We add the identical shape for actions.

## WebSocket protocol (mirror `cluster.*`)
- **Client → server** (start a run): `{ type: "action.run", id: <runId>, action: <ActionBlock> }` (sent on the existing WS).
- **Server → client**:
  - `{ type: "action.progress", id, line }` — one stdout/stderr line.
  - `{ type: "action.done", id, code }` — process exited (code 0 = success).
  - `{ type: "action.error", id, message }` — failed to start / spawn error.

`runId` is generated client-side (a counter or crypto-free unique string; Date.now/Math.random are fine in app code, just not in workflow scripts) so the toast can subscribe to its own run's frames.

## Server (`apps/server/src`)
- New `actionRunManager.ts` modeled on `clusterCreateManager.ts`: given the WS connection + an `action.run` message, build the command argv with the **same builder the `/api/action` route uses** (read `index.ts` ~392-425 + `actions.ts`; preserve any guard/validation that route does — e.g. allowed kinds, context handling), then spawn it line-buffered (a streaming variant of `runProcess` — split stdout/stderr on newlines, emit each as `action.progress`), and emit `action.done`/`action.error`. The actual command is the one the user already approved in the ConfirmSheet — do not change what runs, only how its output is delivered.
- Wire the `action.run` message into the WS router (wherever `cluster.*`/`term` messages are dispatched).
- Keep `POST /api/action` as-is for now (other callers/tests may use it); the chat action button switches to the streaming path.

## Client (`apps/web/src`)
- `lib/ws.ts`: add an `ActionEvent` type + `onActionEvent(id, cb)` subscription (mirror `ClusterEvent`/`onClusterEvent`), and a `runAction(id, action)` sender that posts the `action.run` frame.
- `lib/actionRunner.ts`: `runActionInBackground` generates a `runId`, calls `runAction(runId, action)`, and renders the new `ActionProgressToast` (via `sonner` `toast.custom`) instead of the passive `toast.loading`. Preserve the existing success/error semantics (and the query invalidation the current path does on success).
- New `panels/chat/ActionProgressToast.tsx` (or `components/`): a `toast.custom` component that subscribes via `onActionEvent(runId, …)`, accumulates lines in state, and renders the Pencil design:
  - collapsed by default while running (spinner + "Running: {label}" + chevron-down); clicking the header expands to show the streamed mono output panel + the cursor line; auto-scroll to the latest line.
  - on `action.done` code 0 → green check + label + `Done · N lines/resources`; code ≠ 0 or `action.error` → red + the last error line/message. Keep it dismissible; it may auto-dismiss on success after a short delay (match how create-cluster/toasts behave).
  - **Tailwind utility classes + CSS-var tokens** (per apps/CLAUDE.md / the team rule — NOT inline styles). Tokens: `--surface-elevated` (card), `--surface-sunken` + `--border-subtle` (output panel), `--fg-primary`/`--fg-secondary`/`--fg-tertiary`, `--accent-primary` (spinner), `--status-running` (done), `--status-failed`/`--destructive` (error), `--font-mono`.

## Unchanged / preserved
- The **ConfirmSheet gate** (showing the exact command before running) is untouched — streaming changes only execution+display of the already-approved command.
- Any guard/entitlement the `/api/action` route enforces must be replicated in the streaming path.

## Testing
- Server: `actionRunManager` builds the same argv as the REST path for a given action; streams stdout lines as `action.progress`; emits `action.done` with the exit code; emits `action.error` on spawn failure. Use an injected spawn/runner mock (like the existing manager tests).
- Client: `onActionEvent` routes frames to the right subscriber by `id`; `ActionProgressToast` renders the running state, appends streamed lines, expands on header click, and shows the done/error state. Mock the WS event source.

## Out of scope (follow-ups)
- Step "N/total" counter (needs action-author step hints).
- Retry-from-toast; cancel a running action.
- Migrating non-chat callers off `POST /api/action`.
