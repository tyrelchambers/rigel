# AI chat — quote & action content blocks

**Date:** 2026-07-09
**Pencil frame:** `JgClK` — "AI chat — quote & action blocks" (`clankerlocal.pen`)

## Problem

Assistant messages are rendered as plain markdown. Fenced code blocks fall through
to `CodeBlock.tsx`, an unlabeled dark `<pre>` — so a bare ``` block reads as an
anonymous "black box with text" with no indication of what it is. Markdown also
carries no notion of typed status (a warning vs a success vs a quote), so the
assistant cannot visually distinguish the kinds of content it emits.

## Goal

Reproduce the Pencil `JgClK` callout system so message content renders as
polished, typed blocks: a shared anatomy (left-accent bar, tinted fill, mono
uppercase label + lucide icon, body text) where color encodes type. Give fenced
code blocks a header that names the language. Drive the typed callouts from
standard GitHub alert syntax so no new AI contract is invented.

## Block anatomy (from `JgClK`)

Every callout shares:

- 3px left-accent bar (`strokeWidth.left: 3`)
- tinted fill at ~5–8% of the accent color
- `$radius.md` corners, `$border.subtle` where shown
- header row: mono, uppercase, letter-spaced label (`$font.mono`, ~10.5px,
  letterSpacing 1) + a lucide icon, both in the type color
- body: `$font.body` 14px, lineHeight 1.5

## Mapping: markdown the assistant writes → rendered block

| Source markdown        | Rendered as         | Color token           | Icon           | Label       |
|------------------------|---------------------|-----------------------|----------------|-------------|
| `> [!NOTE]`            | Info callout        | `$accent.primary`     | `info`         | NOTE        |
| `> [!TIP]`             | Success callout     | `$status.running`     | `lightbulb`    | TIP         |
| `> [!IMPORTANT]`       | Accent callout      | `$accent.primary`     | `circle-alert` | IMPORTANT   |
| `> [!WARNING]`         | Warning callout     | `$status.pending`     | `triangle-alert` | WARNING   |
| `> [!CAUTION]`         | Danger callout      | `--status-failed`     | `octagon-alert`| CAUTION     |
| plain `> quote`        | Quote callout       | `$foreground.tertiary`| `quote`        | (none)      |
| ` ```lang ` fenced code| Code block + header | `$surface.sunken`     | (none)         | the language|
| `- ` / `1. ` lists     | Styled list         | accent bullets / number badges | — | —   |
| `` `inline` ``         | accent chip         | `$accent.primary`     | —              | — (shipped) |

## Architecture

All changes are in `apps/web` (rendering) plus one assistant-prompt line. The
`packages/k8s` `actionBlocks` parser is unchanged — the ` ```action `/
` ```question `/` ```alert ` fenced contract and their interactive button
components (`SuggestedActionList`, `SuggestedQuestionList`, `SuggestedAlertList`)
are functional buttons and out of scope.

- **Alert detection:** a remark plugin recognizes `[!TYPE]` alert blockquotes and
  normalizes them so they can be rendered as typed callouts. Plain blockquotes
  (no `[!type]`) fall through to the gray quote callout.
- **`Callout.tsx`** (new, `apps/web/src/panels/chat`) — one component driven by a
  `type → { color, icon, label }` map. Tailwind utilities + design tokens only;
  no inline hex, no hand-written CSS.
- **`CodeBlock.tsx`** (enhanced) — add a header row showing the fenced language
  (extracted from the `code` child's `language-*` class; "text" when absent).
  Keep the existing floating Copy button.
- **`blockquote` / `ul` / `ol` / `li` overrides** passed to `react-markdown`,
  styled with Tailwind classes, replacing the current `.chat-md` CSS for those
  elements. Generic markdown element styling (`p`, `a`, headings) stays in
  `.chat-md`.
- **Assistant prompt:** add one instruction so Rigel emits GitHub alert syntax
  (`[!WARNING]`, `[!TIP]`, etc.) for status and plain `>` for quotes. Without
  this the callouts render correctly but rarely appear.

## Scope decisions

- **Standalone lists are not boxed.** A normal list gets accent bullet dots /
  circular number badges in a fixed column with hanging indent, but is not
  wrapped in a titled card. The design's boxed "NEXT STEPS" list is the result of
  a list living *inside* a callout.
- **CAUTION = red**, an addition beyond the design's four colors
  (accent/green/amber/gray), using the existing `--status-failed` token for
  genuine danger.
- **Plain quotes get the gray bar + quote icon but no text label**, keeping
  ordinary quoting clean. The `[!TYPE]` alerts carry labels; plain quotes do not.

## Out of scope

- The interactive ` ```action `/` ```question `/` ```alert ` button components and
  their confirm-sheet flow.
- Changes to the WebSocket streaming or the `actionBlocks` parser in
  `packages/k8s`.

## Testing

- Vitest coverage for the alert-detection remark plugin (each `[!TYPE]` maps to
  the right callout type; plain blockquote → quote; malformed `[!type]` falls
  back to plain quote).
- Vitest for `CodeBlock` language extraction (fenced with/without a language).
- `pnpm --filter web typecheck`, `pnpm --filter web test`, `pnpm --filter web build`.
