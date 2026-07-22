# Windows window controls — design

Date: 2026-07-22
Status: approved

## Goal

Seamlessly integrate the Windows minimize / maximize / close buttons into the
custom top bar (GlobalHeader), on the right, with no traditional Windows title
bar. This is the Windows counterpart to the existing macOS setup.

## Background

The macOS "traffic lights" are not custom-drawn. The window uses
`titleBarStyle: "hiddenInset"` and the native macOS buttons show through; the
header simply reserves 102px on the left for them (`GlobalHeader.tsx`). There is
no IPC and no custom button code.

Windows has no native buttons to show through a frameless window, so we use the
mirror image: `titleBarStyle: "hidden"` + `titleBarOverlay`, which makes Windows
draw native caption buttons on the right that can be themed (color, symbol color,
height) to blend into the bar. This keeps Windows 11 Snap Layouts, correct DPI
and high-contrast rendering, and needs no custom buttons, no IPC, and no
maximize-state tracking.

The app is dark-only (single fixed palette in `apps/web/src/index.css`), so the
overlay is configured once at window creation and never updated.

## Approach: native, themed (titleBarOverlay)

### 1. Electron main — `apps/desktop/src/main.ts` (`createWindow`)

Make the titlebar options platform-conditional instead of the current hardcoded
`hiddenInset`:

- darwin -> `titleBarStyle: "hiddenInset"` + `trafficLightPosition: { x: 16, y: 14 }` (unchanged)
- win32 -> `titleBarStyle: "hidden"` + `titleBarOverlay: { color: "#121315", symbolColor: "#a1a1aa", height: 42 }`
  - `color` = `--surface-primary` (header background) so the strip is seamless
  - `symbolColor` = `--fg-secondary` so glyphs match the nav-arrow icons
  - `height: 42` = header height, so buttons align with the bar
- other (linux) -> default frame

### 2. Platform flag — `apps/web/src/lib/desktop.ts`

Add `export const isWindowsDesktop = rigel?.platform === "win32";` next to
`isMacDesktop`.

### 3. Header inset — `apps/web/src/shell/GlobalHeader.tsx`

The native caption buttons overlay the top-right, so the search button and avatar
must not slide under them. Reserve the exact region Windows reports via the
Window-Controls-Overlay CSS environment variables (DPI-correct, no magic pixel):

```
paddingRight: isWindowsDesktop
  ? "calc(100vw - env(titlebar-area-width) - env(titlebar-area-x))"
  : 14
```

`paddingLeft` stays `isMacDesktop ? 102 : 14`. The header already spreads
`-webkit-app-region: drag`, which is what the overlay needs; the OS owns the
button hit-testing.

## Out of scope (YAGNI)

Custom-drawn buttons, IPC handlers, maximize/restore state, explicit Snap Layouts
wiring (the overlay provides Snap Layouts for free).

## Verification

- macOS: `pnpm --filter web typecheck` + build; `pnpm --filter desktop dev` to
  confirm the Mac traffic lights and layout do not regress (the win32 path is a
  no-op on macOS).
- Windows: check out this branch on a Windows machine/VM and run
  `pnpm --filter desktop dev`. Confirm the min/max/close buttons render, blend
  with the bar, and the right inset keeps the avatar/search clear. First thing to
  judge: whether `symbolColor` `#a1a1aa` reads too dim vs near-white; if so,
  change it to `#ffffff` (one-line).
