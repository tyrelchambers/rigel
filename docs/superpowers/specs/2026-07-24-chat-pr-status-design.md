# Feature 1 — Live PR status on the chat repo badge

## Summary

The repo badge on a chat "Opened pull request" message should reflect the PR's
**current state** — open / merged / closed — by reading it from the GitHub API.
The bare GitHub mark is tinted by state (amber = open, purple = merged, grey =
closed) and the tooltip reads `owner/repo #42 · merged`.

## Why

Today the result badge is a static link. Tinting it by live state turns "I opened
a PR" into "here's where that PR stands" without leaving chat, and it is the
status primitive Feature 2 reuses.

## Approach

Add one server endpoint to read a single PR's state (the GitHub token is
server-side only), and a cached client query the badge consumes.

## Components

### Server — `GET /api/git/pr-status?url=<prUrl>`
- Parse `owner/repo/number` from the PR URL.
- `token = await loadGithubToken(context)`; if none → `409` (badge stays
  neutral, no status).
- `GET https://api.github.com/repos/{owner}/{repo}/pulls/{number}` with the
  token. Map to `{ number, state }` where `state = merged_at ? "merged" :
  json.state` (`"open" | "closed"`).
- Lives alongside the other `/api/git/*` GETs; the fetch helper goes in
  `apps/server/src/git.ts` next to the existing GitHub calls.

### Client
- `usePrStatus(prUrl?)` — TanStack query, key `[ctx, "pr-status", prUrl]`,
  `staleTime ~60s`, `refetchOnWindowFocus`, enabled only when a PR URL is
  present. In `apps/web/src/panels/gitops/gitApi.ts`.
- `prNumberFromUrl(url): number | null` — pure, tested (parse `/pull/<n>`); in
  `repoSlug.ts`. Lets the tooltip show `#42` even before status loads.
- `RepoBadge` gains optional `state?: "open" | "merged" | "closed"` and
  `prNumber?: number`. It tints the mark by `state` (amber/purple/grey; muted
  when absent) and the tooltip becomes `slug #num · state` (parts included only
  when known).
- `MessageBubble` renders result badges (those with `href`) through a small
  `ChatPrBadge({ slug, href })` that calls `usePrStatus(href)` + computes
  `prNumber`, keeping `RepoBadge` presentational. Proposal badges (no href)
  render `<RepoBadge slug />` unchanged.

## Behavior / edge cases

- No token / 409 / fetch error / loading → neutral (muted) mark; tooltip still
  shows `slug #num` when the number parses from the URL.
- Only badges with a PR URL fetch status; proposal badges never do.

## Testing

- Unit: `prNumberFromUrl` (present / absent); the server status mapping
  (`merged_at` → merged, open, closed) via a small pure mapper.
- Component: `RepoBadge` tint + tooltip for each state and the unknown case.
