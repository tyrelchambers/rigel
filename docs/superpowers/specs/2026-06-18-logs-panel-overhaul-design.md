# Logs panel overhaul — design

**Date:** 2026-06-18
**Status:** Approved (design)
**Delivery:** Phased — 4 PRs, scan-first; each reviewed before the next.

## Problem

The Logs panel (`apps/web/src/panels/logs/`) is a solid live-tail but a live drive
(Playwright, against the real cluster) surfaced concrete gaps:

- **Scale:** 88 deployments in the sidebar with **no search**; the log list renders
  unvirtualized (166 visible rows → ~1,651 DOM nodes; the 5,000-line cap implies
  ~50k nodes on a chatty workload).
- **Debugging:** no `--previous` (can't see why a CrashLoopBackOff died — the most
  common log task), no container picker for multi-container pods, and a hardcoded
  `--tail=200` with no since/window control.
- **Scanability:** substring filter only — no match highlight, no match count, no
  regex, no errors-only; the pod column repeats the same name on every row for a
  single-replica deployment (~150px wasted).
- **A11y/perf:** log rows are `<div onClick>` with no keyboard path (`LogsPanel.tsx:410`);
  error banner isn't `aria-live` (`:380`).

## Current state (what already exists — reuse it)

- **Server `logStream.ts`** spawns `kubectl logs -f --timestamps --prefix=true
  --all-containers=true -n <ns> (-l <selector> | <pod>) --max-log-requests=20
  --tail=N` and **already attributes pod + container per line** by parsing the
  `[pod/<pod>/<container>]` prefix. `LogTarget` already has `container?`/`pod?`.
- The outbound `logs` message already carries `{ pod, container, line }` — but the
  **client ignores `m.container`/`m.pod`** and re-parses `m.line` via `toLogLine`.
  ⇒ per-line container/pod attribution is *already flowing*; we just surface it.
- **Client**: `LogsPanel.tsx` (orchestrator + sidebar + toolbar + list inline),
  `logDisplay.ts` (pure, tested: parse/filter/sort/colors/selectors), `ws.ts`
  (`sendLogsStart(targets, tailLines)`, `sendLogsStop`, `onLogLine`).
- Good parts to keep: merged-replica chronological view, per-pod colors,
  hide-probes, Ask-Claude with ±5 context, auto-follow + jump-to-latest, error
  coloring.

## Architecture & file decomposition

`LogsPanel.tsx` (~480 lines) will grow; split into focused units as phases land
(each file one responsibility, independently testable):

- `logDisplay.ts` *(existing, pure)* — gains `matchRanges`, regex compile,
  `detectLevel`, `streamStats`, distinct-container/pod helpers.
- `LogsSidebar.tsx` — kind tabs + search + deployment/workload/pod list.
- `LogsToolbar.tsx` — filter (+regex/highlight/count), toggles, container + since
  controls, pod chips, actions (pause/clear/wrap/probes/download).
- `LogList.tsx` — the row list (virtualized in Phase 4) + `LogRow`.
- `LogsPanel.tsx` — orchestrator only: state, ws wiring, stream lifecycle.

Decomposition is incremental: Phase 1 extracts what it needs; later phases extend.
No big-bang rewrite — each phase leaves the panel shippable.

## Server / protocol extension *(landed in Phase 2; additive, back-compatible)*

`logStream.ts` + `ws.ts` `LogTarget` / `logs.start`:

- `buildLogsArgs` honors `target.container` → `-c <container>` **in place of**
  `--all-containers=true` when a container is set (keep `--all-containers` when not).
- Add `previous?: boolean` → appends `--previous` and **omits `-f`** (a dead
  container can't be followed; previous-mode is a one-shot dump).
- Add `since?: string` (e.g. `"5m"`, `"1h"`) → appends `--since=<v>` when set.
- `tailLines` already exists on `logs.start`.

All four are optional and default to today's behavior. `buildLogsArgs` stays a pure
function → covered in `logStream.test.ts`.

---

## Phase 1 — Faster to scan *(client-only; first PR)*

**Files:** `logDisplay.ts` (+helpers, +tests), `LogsPanel.tsx` (toolbar + row
render), optional `LogsToolbar.tsx`/`LogList.tsx` extraction start.

- **Errors-only toggle** — toolbar toggle; when on, filter to `isErrorLine(text)`
  (compose with the existing probe + substring filters in `filterLines`).
- **Match highlighting + count** — a pure `matchRanges(text, query, useRegex)` →
  `[start,end][]`; `LogRow` renders the line with `<mark>` spans over matches. The
  toolbar shows **"K of N"** (matched lines / total after probe+errors filters).
- **Regex toggle** — a `.* ` toggle next to the filter. Invalid pattern → input gets
  a red ring + inline "invalid pattern", and matches **nothing** (no silent
  fallback to substring). `filterLines`/`matchRanges` accept a `useRegex` flag and a
  pre-compiled matcher to avoid recompiling per line.
- **Level coloring** — `detectLevel(text) → "error"|"warn"|"info"|"debug"|null`
  (word-boundary scan for the level token); tint the token (errors already red,
  warn amber, info/debug muted). Subtle, not a full theme.
- **Collapse pod column when single pod** — compute distinct `sourcePod` count over
  the current lines; when 1, hide the 150px pod column (and its color bar moves to
  the row's left border, already present). Re-show when replicas >1.

**Tests:** `matchRanges` (substring + regex, overlaps, empty), `detectLevel`,
errors-only path in `filterLines`, distinct-pod count. Vitest.

## Phase 2 — Debugging power *(server + client)*

**Files:** `logStream.ts` (+tests), `ws.ts` (`LogTarget`/`sendLogsStart`),
`LogsToolbar.tsx`, `LogsPanel.tsx` (stream lifecycle).

- **Container picker** — a dropdown built from the **distinct `container` values seen
  in the stream** (now read from `m.container`, surfaced onto `LogLine`), default
  "All containers". Selecting one **filters client-side** instantly (no re-stream)
  for live logs. (Server `-c` is used only for previous-mode below.)
- **Previous (crashed) logs** — toggle → re-issues `logs.start` with
  `previous: true` (+ the selected container, or all) → server one-shot
  `--previous`. The pane shows a **"previous instance · not live"** banner; pause/
  follow are disabled in this mode. Toggling off returns to the live stream.
- **Since / tail controls** — a small popover: tail size (200 / 500 / 1000) and
  since (off / 5m / 1h). Changing either re-issues `logs.start`.

**Tests:** `buildLogsArgs` for container (`-c` replaces `--all-containers`),
`previous` (`--previous`, no `-f`), `since`. `LogLine.container` plumbed from the
message. Bun + vitest.

## Phase 3 — Find & isolate

**Files:** `LogsSidebar.tsx` (new), `logTargets.ts` (new pure: per-kind selector +
pod listing), `LogsPanel.tsx`, `LogsToolbar.tsx`.

- **Kind tabs** — segmented control atop the sidebar: Deployments (default) /
  StatefulSets / DaemonSets / Pods. STS/DS subscribe their watches and reuse the
  `labelSelector` stream (selector from `spec.selector.matchLabels`, same as
  deployments). **Pods** mode lists pods (pods watch) → tail a single pod via the
  `pod` target. Pure selector/list logic in `logTargets.ts` (+tests).
- **Sidebar search** — a filter box over the active kind's list (case-insensitive
  over name + namespace), reusing the existing `matchesSearch` pattern.
- **Click-a-pod-to-isolate** — when a multi-replica stream is open, the toolbar
  shows pod chips (distinct `sourcePod`); clicking one solos it (client-side filter),
  click again to clear. Complements the container picker.

**Tests:** per-kind selector derivation, pod-target building, sidebar search,
pod-isolation filter. Vitest.

## Phase 4 — Smoothness & polish

**Files:** `LogList.tsx` (virtualize), `LogsToolbar.tsx` (download/stats),
`LogsPanel.tsx`, `package.json` (`@tanstack/react-virtual`).

- **Virtualize** `LogList` with `@tanstack/react-virtual` — dynamic row measurement
  (rows vary with wrap/expand), overscan, and **sticky-bottom preserved** (auto-
  follow scrolls the virtualizer to the last index; `onScroll` unstick logic adapts
  to the virtual scroller). This removes the ~50k-node ceiling.
- **Download / copy-all** — toolbar menu: "Copy all (visible)" and "Download .log"
  (the filtered or full buffer; filename `<ns>-<name>-<HHMMSS>.log`).
- **Stats + buffer indicator** — toolbar shows `N lines · M errors`, a "buffer full
  (5,000)" pill when the cap is hit, and a "paused — X dropped" count while paused
  (pause currently *drops* lines; surface that rather than change the behavior here).
- **A11y** — log row becomes a focusable control (real `<button>` or `role="button"`
  + `tabIndex` + Enter/Space to expand), drop the misleading `cursor-default`, and
  the error banner gets `aria-live="polite"`. Row click no longer fights text
  selection (expand via an explicit affordance / keyboard, click selects text).

**Tests:** stats computation, download payload builder (pure), virtualization
verified via Playwright (smooth scroll, sticky-bottom) + typecheck/build.

---

## Testing & verification (all phases)

- Pure logic (filters, match ranges, regex compile, level parse, selectors, stats,
  download payload, `buildLogsArgs`) → vitest (web) / bun (server) unit tests, TDD.
- UI → `pnpm --filter web typecheck && build`, a Playwright re-drive of the panel,
  and `docker compose up -d --build` so the change is live (per project workflow).
- Update the Rigel Outline doc (a "Logs panel" doc) as features land.

## Out of scope (YAGNI for now)

- Full-text server-side log search / historical (Loki-style) backends — this stays a
  live `kubectl logs` tail.
- Multi-deployment simultaneous tail in one pane (the server supports multiple
  targets, but the UI stays single-selection; pod-isolation covers the common need).
- Saved filters / alerting on log patterns.
- Changing pause to *buffer* instead of drop (Phase 4 only *surfaces* the drop count).
