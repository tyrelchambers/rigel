# Standardized dialog primitives

**Date:** 2026-07-01
**Status:** Approved (design), pending implementation plan

## Problem

The web app has two divergent dialog systems:

- `components/ui/dialog.tsx` — base-ui primitives. `DialogContent` is a graphite
  shell (`#101012`, `ring-white/10`, `p-4 gap-4`) with a floating absolute close
  button. `DialogHeader` is a vertical stack (`flex flex-col gap-2`). `DialogTitle`
  is `font-heading text-base font-medium`. `DialogFooter` uses `bg-muted/50` and
  negative margins that assume a `p-4` body. ~30 files hand-roll on these.
- `components/ui/modal.tsx` — `Modal` / `TabModal` wrappers over `DialogContent`.
  They introduce a *different* header (a hairline-separated bar with a swappable
  left slot: a title for `Modal`, a tab row for `TabModal`) and a padded body, but
  express all of it with raw inline styles: `style={{ padding: "14px 18px" }}`,
  `fontSize: 15, fontWeight: 600, color: "#FFFFFF"`, `rgba(...)` hairlines. ~11
  files use these.

Consequences:

- **Two title treatments.** `DialogTitle` (`text-base`, 16px, `font-heading`) vs
  `Modal`'s inline `15px / 600 / #FFFFFF`.
- **Two spacing systems.** Tailwind `p-4 gap-4` vs raw inline px.
- **Inline CSS sprawl in consumers.** Consumers hand-write hairlines
  (`rgba(255,255,255,0.07)`, `#26272b`) and hex colors, violating the
  Tailwind-utilities-and-tokens-only convention.
- A dialog's header, background, and padding depend on which system it happened to
  be built on.

## Goal

Make `components/ui/dialog.tsx` the single styled source of truth for every
dialog's color, spacing, title treatment, and header. Every header is styled
identically, in one place, and a consumer never hand-writes a hairline, a padding
value, a title font, or the shell background again. Deleting `modal.tsx` removes
the second system.

The canonical values conform to the **existing `dialog.tsx` graphite baseline**
(the bespoke `#101012` shell + `ring-white/10`), not a new design pass.

## Design

### Composition API

One header, one body, one title, one footer. The header is a **slot**: its
children render on the left; the close **X** is rendered by the header itself on
the right. Swapping a title for tabs is just changing the slot's children — the
bar, the X, and the padding stay identical.

Standard dialog:

```tsx
<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent className="max-w-lg">
    <DialogHeader>
      <DialogTitle>Edit ConfigMap</DialogTitle>
    </DialogHeader>
    <DialogBody>…</DialogBody>
    <DialogFooter>…buttons…</DialogFooter>   {/* optional */}
  </DialogContent>
</Dialog>
```

Tabbed dialog (the old `TabModal`) — same header bar, tabs in the slot:

```tsx
<DialogHeader>
  <SegmentedTabs tabs={tabs} active={active} onChange={setActive} />
</DialogHeader>
```

Leading-icon title (the old `Modal` with `icon`):

```tsx
<DialogHeader>
  <DialogIcon><SomeIcon /></DialogIcon>
  <DialogTitle>Account</DialogTitle>
</DialogHeader>
```

### Primitive changes

All styling is expressed in Tailwind utilities and theme tokens — no `style={{}}`
with raw hex/px. Hairlines use `border-white/[0.07]` (preserves the exact current
modal hairline while staying in utilities). The `#101012` shell value lives in
exactly one place: `DialogContent`.

| Primitive | Standardized behavior |
|---|---|
| `DialogContent` | Graphite shell. `flex flex-col p-0 gap-0 overflow-hidden` (was `p-4 gap-4`). Keeps `#101012`, `ring-1 ring-white/10`, rounded, top-anchored, the existing shadow and open/close animations. Default `max-w-md`, overridable via `className`. No longer renders a floating close button (the header owns it). `showCloseButton` prop is removed. |
| `DialogHeader` | The hairline header bar: `flex shrink-0 items-center justify-between gap-4 px-[18px] py-3.5 border-b border-white/[0.07]`. Children render in a `min-w-0 flex-1` left region. Renders the close **X** on the right (ghost button, `size-icon-sm` equivalent, muted icon) unless `showClose={false}`. Was `flex flex-col gap-2`. |
| `DialogTitle` | Unchanged: `font-heading text-base leading-none font-medium`. Becomes the one title treatment app-wide. |
| `DialogBody` | New. The one padded scroll region: `flex-1 overflow-y-auto px-6 pt-6 pb-7`. |
| `DialogFooter` | Sibling bar (not a negative-margin overlay): `flex shrink-0 flex-col-reverse gap-2 px-6 py-4 border-t border-white/[0.07] sm:flex-row sm:justify-end`. Drops `bg-muted/50` and `-mx-4 -mb-4`. `showCloseButton` behavior retained. |
| `DialogDescription` | Unchanged styling. Now lives inside `DialogBody` (or directly under the header), not stacked in the old flex-col header. |
| `DialogIcon` | New. Ports `ModalIcon`: a 30x30 leading tile, `rounded-lg bg-white/[0.07]`, icon `currentColor` white; `background={false}` for a bare icon. Expressed in utilities. |

Exports gain `DialogBody` and `DialogIcon`; everything else keeps its name.

### `modal.tsx` deletion

`Modal`, `TabModal`, `ModalIcon`, `ModalFrame`, `ModalTab` are removed. `modal.tsx`
is deleted. All consumers migrate to the composition above:

- `Modal` → `DialogContent > DialogHeader(DialogTitle [+ DialogIcon]) + DialogBody`.
- `TabModal` → `DialogHeader(SegmentedTabs)` with local `useState` for the active
  tab (the same logic `TabModal` had internally), body renders the active panel.
- `ModalIcon` → `DialogIcon`.

## Affected files

Roughly 41 files. Two groups:

**Group A — `modal.tsx` consumers (~11):** migrate off `Modal`/`TabModal`/`ModalIcon`.
`shell/AccountModal.tsx`, `shell/CreateClusterModal.tsx`,
`shell/ConnectClusterModal.tsx`, `shell/AddClusterChooser.tsx`,
`shell/RemoveClusterDialog.tsx`, `shell/ClusterIconPicker.tsx`,
`panels/assistant/tabs/ReportsTab.tsx`, `panels/rightsizing/MetricsRemoveDialog.tsx`,
`panels/rightsizing/MetricsInstallDialog.tsx`, `panels/helm/ReleasesView.tsx`,
`panels/helm/HelmConfirmModal.tsx`.

**Group B — direct `dialog.tsx` consumers (~30):** update to the new structure —
wrap body content in `DialogBody`, move stacked descriptions out of the old
flex-col header, drop `showCloseButton` usage, remove hand-written hairlines/hex
in favor of the primitives. Includes the `*Sheet` components
(`ConfirmSheet`, `BatchConfirmSheet`, `PurgeSheet`, `PurgePickerSheet`,
`CatalogDetailSheet`, `LinkWorkloadPickerSheet`) and all editor/scale/gitops/
settings dialogs listed by the audit.

## Testing

- `pnpm --filter web typecheck` — catches removed exports (`Modal`, `TabModal`,
  `ModalIcon`, `showCloseButton`) at every call site; the compiler is the primary
  migration driver.
- `pnpm --filter web test` — existing dialog/modal tests
  (`AccountModal.test.tsx`, `RemoveClusterDialog.test.tsx`,
  `ConnectClusterModal.test.tsx`, `MatrixConnectModal.test.tsx`,
  `LinkRepoModal.test.tsx`, `CredentialSourceDialog.test.tsx`) must pass after
  migration; update selectors only where structure changed (e.g. the close button
  now lives in the header).
- `pnpm --filter web build` — final gate.

## Out of scope

- No visual redesign. Values conform to the current graphite baseline; the only
  intentional visual change is that dialogs previously built on plain
  `DialogContent` now get the header bar + padded body treatment (matching what the
  `Modal` consumers already had).
- No new `--surface-dialog` token. The `#101012` value is centralized in
  `DialogContent` but not promoted to a named token (can be a follow-up).
- No behavior changes to any dialog's logic, data flow, or actions.

## Migration approach

Big but mechanical. Order:

1. Land the standardized `dialog.tsx` primitives (add `DialogBody`, `DialogIcon`;
   restyle `DialogContent`/`DialogHeader`/`DialogFooter`; remove
   `showCloseButton`).
2. Migrate Group A (delete `modal.tsx` last, once no consumer imports it).
3. Migrate Group B in batches.
4. Typecheck + test + build green after each batch.

Execute via the subagent-driven path in batches.
