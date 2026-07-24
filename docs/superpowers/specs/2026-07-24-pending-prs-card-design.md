# Feature 2 — Pending PRs card (chat-opened PRs) + Sync-on-merge

## Summary

An Overview card that lists the PRs the **chat copilot** has opened, watches each
one's status, and — once a PR is merged — offers a one-click **Sync now** for the
affected deployment. This closes the loop that today stops at "PR opened."

## Why

Rigel opens a PR and then goes quiet; the user must remember to come back and
sync after merging. Chat-opened PRs are currently ephemeral (transcript only).
Persisting them and watching status makes the propose → PR → rollout flow feel
finished. (Autonomous agent PRs already persist + render in Assistant → AutoFix;
this card is scoped to the chat copilot's PRs.)

## Approach

Persist chat PRs to a dedicated ConfigMap ledger on the server (modeled on the
Recent-Deployments Undo ledger), expose read/dismiss routes, and render an
Overview card that reuses Feature 1's status check and the existing sync API.

## Components

### Persistence — `rigel-pull-requests` ConfigMap
- Single ConfigMap holding a JSON array under one data key, newest-first,
  capped at 50, records older than 30 days GC'd on write. Server-owned.
- `ChatPrRecord`: `{ id, prUrl, number, repoSlug (owner/repo, display),
  repoName (GitSource.name, for sync), source (deployment slug), title, branch,
  filePath, createdAt }`. Dedup by `prUrl`.
- Ledger read/write helpers in `packages/k8s` (mirroring `applyLedger.ts`
  shape), executed via the server's kubectl seam.

### Server
- On a successful non-dryRun `POST /api/git/propose-fix`, append a record. The
  handler already resolves the source via `findByDeployment` (giving the owning
  `GitSource`), so it has `repoName`, `source`, `repoSlug` (from `parseRepoSlug`),
  `branch`, `prUrl`; parse `number` from the URL.
- `GET /api/git/pull-requests` → `{ pullRequests: ChatPrRecord[] }`.
- `DELETE /api/git/pull-requests?id=<id>` → remove one record (dismiss).

### Client
- `useChatPullRequests()` / `useDismissPullRequest()` in `gitApi.ts` (TanStack
  query + mutation, invalidate on dismiss).
- `PendingPrsCard` on Overview (sibling of `RecentDeploysCard`). Each row:
  the GitHub mark + `repoSlug #number`, the live status (via `usePrStatus` from
  Feature 1) as a tinted pill, the PR title, a dismiss `×`, and — when
  `state === "merged"` — a **Sync now** action for `{ repoName, source }`.
- **Sync now** reuses the existing GitOps sync flow: it runs the standard
  preview (`syncDeployment(repoName, source, dryRun:true)`) and shows the diff
  in a confirm before applying (`dryRun:false`), matching the guarded-action
  rule. If a reusable sync-preview dialog exists it is reused; otherwise a thin
  confirm dialog wraps the same two calls.

## Behavior / edge cases

- Recording is best-effort: a ledger-write failure never fails the PR open.
- Empty ledger → card renders an empty state (or hides), like other Overview
  cards.
- A record whose `source` no longer resolves in `git-sources` (deployment
  unlinked/removed) → row shows status but the Sync action is disabled.
- Dismiss removes the row; it does not touch the PR on GitHub.
- Dedup by `prUrl` so re-opening the same fix doesn't duplicate rows.

## Testing

- Unit: ledger add/dedup/cap/GC (pure helpers); the propose-fix → record mapping
  (source → repoName/repoSlug via `findByDeployment` + `parseRepoSlug`).
- Component: `PendingPrsCard` renders rows, shows Sync only when merged, disables
  Sync when the source is unresolved, and dismiss calls the mutation.

## Sequencing

Build after Feature 1 (reuses `usePrStatus`). Feature 3 is independent and can
land first.
