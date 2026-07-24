# Chat PR repo badge

## Summary

When the Rigel assistant opens (or proposes to open) a pull request against a
configured repo in chat, show a small rounded badge underneath that message
carrying the GitHub logo. Hovering the badge reveals the `owner/repo` slug of
the repo being changed. On the message that reports a PR was opened, the badge
is clickable and opens the pull request in the system browser.

This gives the operator an at-a-glance answer to "which repo is the AI touching
right now?" without reading the full message.

## Goals

- Surface the target repo on chat messages that involve opening a PR.
- Badge appears on **both** the assistant's `proposeRepoFix` proposal message
  and the system "Opened pull request" result message.
- Badge is a rounded chip containing only the GitHub mark; the `owner/repo` slug
  lives in a hover tooltip.
- On the result message the badge links to the PR (opens externally).

## Non-goals

- No badge for the autonomous in-cluster autofix path (that surfaces in the
  assistant panel, not the live chat transcript).
- No new backend endpoint. No change to the `ChatMessage` data model.
- No badge on messages that do not involve a repo PR.

## Approach

Frontend-only, derive-at-render. The web client already has everything needed:

- The `proposeRepoFix` action block carries `source` (a deployment slug).
- `useGitSources()` (`GET /api/git/sources`, already cached via TanStack Query)
  returns every configured `GitSource` with its `repoURL` and `deployments[]`,
  so `source` resolves to `owner/repo` entirely client-side.
- The result system message already contains the PR URL, and a GitHub PR URL
  encodes `owner/repo`.

No data-model change, no streaming plumbing, no new server route.

## Components

### `RepoBadge` (new) — `apps/web/src/panels/chat/RepoBadge.tsx`

Purely presentational, no data fetching.

- Props: `{ slug: string; href?: string }`.
- Renders a small `rounded-full` badge with a subtle bordered/tinted background
  (Tailwind utilities + design tokens only — no hand CSS, no inline hex/px).
- Content is only the GitHub brand mark, sourced from **react-icons**
  (`SiGithub`), per the brand-marks-stay-react-icons convention.
- Wrapped in the app's existing Tooltip primitive; tooltip content is the
  `slug` (`owner/repo`).
- When `href` is present the badge is an external link that opens in the system
  browser using the same external-link handling other chat links use
  (`will-navigate` → `shell.openExternal`). When absent it is tooltip-only and
  non-interactive.

### Resolver helpers (new, pure, unit-tested)

Co-located with the chat panel (e.g. `apps/web/src/panels/chat/repoBadge.ts`).

- `repoSlugFromSource(sources, source): string | null` — find the `GitSource`
  whose `deployments[]` contains `dep.name === source`, then parse `owner/repo`
  from that source's `repoURL` using the existing repo-slug regex. Returns
  `null` when the source is not found or the URL does not parse.
- `repoSlugFromText(text): string | null` — extract `owner/repo` from a
  `github.com/<owner>/<repo>/pull/...` URL found in the message text. Returns
  `null` when no PR URL is present.

### Wiring — `apps/web/src/panels/chat/MessageBubble.tsx`

- Call `useGitSources()` once (shared, cached).
- Compute the badge slug + optional href for the message:
  - If the parsed actions include a `proposeRepoFix` action, resolve its
    `source` via `repoSlugFromSource(...)` → slug (no href; PR does not exist
    yet).
  - Else if `repoSlugFromText(message.text)` yields a slug, use it and set
    `href` to the PR URL found in the text.
- If a slug resolves, render `<RepoBadge slug={slug} href={href} />` **beneath**
  the message content (after the markdown body and any action buttons), on both
  the assistant proposal turn and the system result turn.

## Data flow

```
proposal turn:
  assistant text ──parseSuggestedActions──▶ proposeRepoFix.source
                    useGitSources() cache ──▶ repoSlugFromSource ──▶ owner/repo
                    RepoBadge(slug)  (tooltip only)

result turn:
  system text "Opened pull request: <prUrl>" ──▶ repoSlugFromText ──▶ owner/repo
                                                  RepoBadge(slug, href=prUrl)
                                                  click ──▶ system browser
```

## Edge cases

- No PR action and no PR URL in the message → no badge (the common case).
- `source` not found in `useGitSources` (stale cache, repo not configured) → no
  badge; no invented fallback label.
- `useGitSources` still loading on the proposal turn → badge appears once the
  query resolves.
- Multiple distinct repos referenced in one message → one badge per distinct
  slug (deduped). In practice this is a single repo.

## Testing

- Unit tests for `repoSlugFromSource` (match, no-match, unparseable URL) and
  `repoSlugFromText` (PR URL present, absent, non-PR GitHub URL).
- Component test for `RepoBadge`: renders the mark; tooltip content equals the
  slug; renders an external link only when `href` is provided.

## Open questions

- None outstanding. Proposal badge is intentionally non-clickable for now;
  linking it to the repo homepage is a trivial future addition if wanted.
