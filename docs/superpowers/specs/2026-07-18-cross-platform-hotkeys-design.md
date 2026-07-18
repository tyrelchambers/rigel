# Cross-platform hotkey labels + handlers

Date: 2026-07-18
Branch: `feature/cross-platform-hotkeys`

## Problem

Rigel's keyboard shortcuts were written on macOS. The *handlers* are mostly
already cross-platform (5 of 7 global shortcuts test `metaKey || ctrlKey`), but:

1. Every displayed shortcut *label* hardcodes Mac glyphs (`⌘` / `⌥` / `⌃`), so a
   Windows or Linux user sees keys their keyboard does not have.
2. There is no reliable "is this macOS" check in the renderer. `isMacDesktop`
   (`lib/desktop.ts`) is `true` only in the packaged Mac desktop and `false` in a
   plain browser, so it cannot drive label choice for web usage.
3. Two handlers are Mac-shaped: the `⌥⌘W` wrap toggle in `LogsPanel` requires
   `metaKey`, which does not exist on Windows/Linux.

## Goals

- Windows/Linux users see conventional labels: `Ctrl+K`, `Alt+Ctrl+W`, `Ctrl+\``.
- macOS users keep native glyph labels: `⌘K`, `⌥⌘W`, `⌃\``.
- Every global shortcut fires on Windows/Linux.

## Non-goals

- No central keybinding registry / no third-party hotkey library. Shortcuts stay
  as their existing ad-hoc `addEventListener` handlers.
- No Electron `globalShortcut` or application menu (none exist today).

## Design

### 1. New helper: `apps/web/src/lib/platform.ts`

```ts
export const isMac =
  rigel?.platform === "darwin" ||
  /mac/i.test(
    (navigator as any).userAgentData?.platform ?? navigator.platform ?? "",
  );

type ShortcutSpec = {
  mod?: boolean;   // Cmd on Mac, Ctrl elsewhere
  alt?: boolean;   // Option on Mac, Alt elsewhere
  shift?: boolean;
  ctrl?: boolean;  // literal Control on all platforms (terminal toggle)
  key: string;     // display key, e.g. "K", "/", "`"
};

export function formatShortcut(spec: ShortcutSpec): string;
```

Output:

| Spec | Mac | Windows/Linux |
|---|---|---|
| `{ mod, key: "K" }` | `⌘K` | `Ctrl+K` |
| `{ mod, key: "L" }` | `⌘L` | `Ctrl+L` |
| `{ mod, key: "J" }` | `⌘J` | `Ctrl+J` |
| `{ mod, key: "/" }` | `⌘/` | `Ctrl+/` |
| `{ mod, key: "N" }` | `⌘N` | `Ctrl+N` |
| `{ alt, mod, key: "W" }` | `⌥⌘W` | `Alt+Ctrl+W` |
| `{ ctrl, key: "\`" }` | `⌃\`` | `Ctrl+\`` |

- Mac: glyphs concatenated in native order (`⌃ ⌥ ⇧ ⌘`) then the key, no separator.
- Win/Linux: words joined with `+` in the order `Ctrl(ctrl) Alt Shift Ctrl(mod)`
  then the key. `mod` and literal `ctrl` both render as `Ctrl`.

`rigel` is read via the existing preload bridge (same source as
`lib/desktop.ts`). `isMac` is evaluated once at module load.

### 2. Handler fixes

- `apps/web/src/panels/logs/LogsPanel.tsx:393` — change
  `e.altKey && e.metaKey` to `e.altKey && (e.metaKey || e.ctrlKey)`.
- `apps/web/src/App.tsx:216` — Ctrl+\` toggle is already
  `ctrlKey && !metaKey && !altKey`; correct cross-platform, unchanged. Its label
  is produced from `{ ctrl: true, key: "\`" }`.
- The remaining five handlers already OR `metaKey || ctrlKey`; unchanged.

### 3. Label sites → `formatShortcut`

Replace hardcoded glyph strings with `formatShortcut(...)` at:

- `apps/web/src/shell/StatusBar.tsx` — the five `HintChip` `kbd` props
  (`⌘K`, `/`, `⌘L`, `⌃\``, `⌘J`). `HintChip` keeps its `string` prop; only the
  passed value changes.
- `apps/web/src/shell/GlobalHeader.tsx:73,113` — search `title` and button text.
- `apps/web/src/shell/CommandPalette.tsx:200` — the `⌘K` badge.
- `apps/web/src/shell/ClusterRail.tsx:228` — the `⌘/` navigation `title`.
- `apps/web/src/panels/logs/LogsPanel.tsx:586` — the `⌥⌘W` wrap `title`.

## Testing

- Unit tests for `formatShortcut`: the 7 shortcuts above, asserting both the
  macOS and the Windows/Linux string (mock `isMac` in both directions).
- `pnpm --filter web typecheck` and build must pass.
