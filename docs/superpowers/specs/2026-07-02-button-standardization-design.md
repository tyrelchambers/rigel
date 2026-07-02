# Button standardization

**Date:** 2026-07-02
**Status:** Approved (design), pending implementation plan
**Follow-on to:** `docs/superpowers/specs/2026-07-01-standardized-dialog-primitives-design.md` (dialog primitive standardization, ~41 consumers migrated)

## Problem

`apps/web/src/components/ui/button.tsx` is a complete, correctly-themed
`cva`-based primitive (7 variants x 8 sizes, wired to the real design tokens —
`--primary` resolves to `--accent-primary`, `--border` to `--border-strong`,
etc.). It is already the majority pattern: 64 files import `Button`. But 102
files still hand-roll a native `<button>` with inline Tailwind or `style={{}}`,
for a total of 233 raw `<button>` elements versus a similar count of `<Button>`
usages. The two systems have drifted:

- **Same accent color, different hover.** Button's `default` variant hovers
  with `hover:bg-primary/80` (opacity fade). The dominant hand-rolled CTA
  pattern (`bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)]`, seen in
  9+ files) hovers to a distinct, deliberately-chosen darker token
  (`--accent-hover: #0ea5e9`, not just `--accent-primary` at 80%). Two visually
  different hover treatments for the "same" primary button.
- **An unused `link` variant.** `variant="link"` exists and is never used
  (`grep` count: 0). Instead, arrow-style text actions
  (`text-xs font-semibold text-[var(--accent-primary)] hover:underline`, e.g.
  `panels/assistant/tabs/OverviewTab.tsx`'s "View all in Activity →") are
  hand-rolled every time they're needed.
- **A recurring "copy chip" treatment with no home.** A small ghost
  icon+label button (`rounded-md px-1.5-2 py-0.5-1 text-[10px] font-medium
  text-muted-foreground hover:bg-white/5 hover:text-foreground`) is
  hand-rolled near-identically in `components/ConfirmSheet.tsx`,
  `components/DiffView.tsx`, and `panels/configmaps/ConfigMapDetail.tsx`. It's
  functionally `variant="ghost" size="xs"` with a couple of size tweaks, but
  nobody reaches for `Button` for it.
- **Inline `style={{}}` sprawl on buttons specifically**, heaviest in
  `shell/*` (315 `style={{`  occurrences), `panels/settings/*` (135),
  `panels/gitops/*` (50), `panels/chat/*` (58) — raw hex, raw px, `rgba(...)`
  hairlines on click targets, violating the Tailwind-utilities-and-tokens-only
  convention independently of whether `Button` gets used.
- **Inconsistent icon-button sizing.** `Button`'s icon scale is `icon-xs`
  (24px) / `icon-sm` (28px) / `icon` (32px) / `icon-lg` (36px). Hand-rolled
  icon buttons pick arbitrary pixel values that don't land on the scale —
  30px close buttons (`shell/ClusterHealthBadge.tsx`,
  `panels/gitops/GitOpsLinkWorkloadDialog.tsx`), 38px rail buttons
  (`shell/ClusterRail.tsx`), 24px sheet-close buttons
  (`panels/chat/ChatHistorySheet.tsx`) — each a one-off.

None of this is a theming bug — the tokens Button already uses are correct.
The drift is pure non-adoption: authors didn't know/reach for `Button`, so
every screen re-invents padding, radius, and hover for what is visually the
same handful of button treatments.

## Goal

Make `components/ui/button.tsx` the single styled source of truth for every
button's fill, border, radius, padding, text size/weight, icon spacing, hover,
focus-visible ring, and disabled state. Every hand-rolled `<button>` that is a
genuine control affordance (icon trigger, CTA, toggle, destructive action,
text-link-style action) migrates onto `<Button variant size>`. A small,
explicitly-named set of Pencil-designed modal-footer CTAs stay bespoke because
their proportions are a deliberate one-off design, not the app's general
button scale.

## Current `Button` (baseline — do not restyle beyond the two Design changes below)

`apps/web/src/components/ui/button.tsx`, built on `@base-ui/react/button` +
`cva`:

**Base classes (all variants/sizes):** `group/button inline-flex shrink-0
items-center justify-center rounded-lg border border-transparent bg-clip-padding
text-sm font-medium whitespace-nowrap transition-all outline-none select-none
focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50
active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none
disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3
aria-invalid:ring-destructive/20 …`

| Variant | Style | Current adoption |
|---|---|---|
| `default` | `bg-primary text-primary-foreground hover:bg-primary/80` | 1 explicit use (usually the implicit default) |
| `outline` | `border-border bg-background hover:bg-muted hover:text-foreground …` | 45 uses |
| `secondary` | `bg-secondary text-secondary-foreground hover:bg-[color-mix(…5%)] …` | 3 uses |
| `muted` | `border-[var(--border-strong)] bg-white/5 text-foreground hover:bg-white/10` | 17 uses |
| `ghost` | `hover:bg-muted hover:text-foreground …` | 33 uses |
| `destructive` | `bg-destructive/10 text-destructive hover:bg-destructive/20 …` | 15 uses |
| `link` | `text-primary underline-offset-4 hover:underline` | 0 uses |

| Size | Style |
|---|---|
| `default` | `h-8 gap-1.5 px-2.5` |
| `xs` | `h-6 gap-1 rounded-[min(--radius-md,10px)] px-2 text-xs` |
| `sm` | `h-7 gap-1 rounded-[min(--radius-md,12px)] px-2.5 text-[0.8rem]` |
| `lg` | `h-9 gap-1.5 px-2.5` |
| `icon` | `size-8` (32px) |
| `icon-xs` | `size-6` (24px) |
| `icon-sm` | `size-7` (28px) |
| `icon-lg` | `size-9` (36px) |

Tokens resolve correctly already: `--primary: var(--accent-primary)`,
`--primary-foreground: var(--fg-inverse)`, `--border: var(--border-strong)`,
`--muted: var(--surface-elevated)`, `--destructive: #ef4444`. No new tokens are
needed for this ticket.

## Design changes to `Button` itself

Two small, targeted changes — not a redesign:

1. **`default` variant hover** changes from `hover:bg-primary/80` to
   `hover:bg-[var(--accent-hover)]`, matching the dedicated hover token every
   hand-rolled accent CTA already uses (`--accent-hover: #0ea5e9`, a distinct
   shade, not `--accent-primary` at reduced opacity). This makes `default`
   pixel-identical to the dominant hand-rolled accent-button hover across the
   9+ files that use it, and is the one behavior change existing `Button`
   consumers will see (a hover-color shift only).
2. No new variants or sizes. `link` (unused) becomes the target for arrow-style
   text actions; `ghost` + `xs` becomes the target for copy-chip buttons.
   Per-instance sizing that must match a Pencil-exact pixel value (e.g. a
   38px rail button) is layered on via `className` (e.g.
   `size="icon-lg" className="size-[38px]"`) rather than adding a new size —
   `cn()` already merges `className` last, so this is a supported escape
   hatch, not drift.

## Target variant -> hand-rolled pattern mapping

| Hand-rolled pattern (examples) | Target |
|---|---|
| `bg-[var(--accent-primary)] … hover:bg-[var(--accent-hover)]` CTA (e.g. `shell/OnboardingWizard.tsx` `primaryBtn`, `panels/assistant/tabs/*`) | `variant="default"` |
| `border-[var(--border-strong)] … hover:text-foreground` cancel/secondary (dialog cancels, wizard "Back") | `variant="outline"` (or `muted` where the hand-rolled version used `bg-white/5`) |
| Icon-only toolbar/header triggers, `hover:bg-muted`/`hover:bg-white/[0.05]`, no border | `variant="ghost"`, size from `icon-xs`/`icon-sm`/`icon`/`icon-lg` |
| `text-red-*`/`bg-destructive/10`-style delete/remove actions | `variant="destructive"` (already the dominant pattern for these — 15 files already use it; hand-rolled destructive holdouts are the minority to sweep) |
| `text-[var(--accent-primary)] hover:underline` arrow/text links (e.g. "View all in Activity →") | `variant="link"` |
| Small icon+label "Copy" chips (`ConfirmSheet`, `DiffView`, `ConfigMapDetail`) | `variant="ghost" size="xs"` |

## Out of scope (explicitly not migrated)

**1. Named Pencil-exception modal footers** — kept bespoke because their
padding/font-weight (`px-[22px] py-[11px] text-sm font-bold`, `px-5 py-[11px]
font-semibold`) is a deliberate large modal-CTA proportion from the Pencil
redesign work, not the app's general button scale:

- `apps/web/src/panels/assistant/AlertsCard.tsx` — "New alert" modal footer
  (accent "Create alert" + outline "Cancel" via `DialogClose`).
- `apps/web/src/panels/gitops/GitOpsLinkWorkloadDialog.tsx` — "Link a workload"
  modal footer ("Cancel" + "Link workload").
- `apps/web/src/shell/AccountModal.tsx` — footer ("Sign out" ghost-text button
  + "Done" accent button), named explicitly in the ticket.
- `apps/web/src/panels/configmaps/ConfigMapEditor.tsx` — **not named in the
  ticket, but byte-identical footer CSS** to the two named exceptions
  (`px-[22px] py-[11px]` accent CTA + `px-5 py-[11px]` outline cancel), from
  the same "(improved)" Pencil redesign family (commit `959f7045`, "redesigned
  ConfigMap edit modal"). Flagged as a **likely fourth exception** — the
  implementer should check the Pencil frame before deciding, not silently
  migrate it because it happens to share a CSS shape with the kept files.

Only these footers are excepted — any *other* button in those same files
(e.g. `AlertsCard.tsx` has other `Button`-eligible controls outside the New
Alert modal) is in scope and should migrate normally.

**2. Clickable cards/rows that happen to be `<button>` elements.** A `<button>`
used for a full-width navigational card or list row (e.g.
`panels/assistant/tabs/OverviewTab.tsx`'s "N fixes awaiting approval" banner,
`panels/gitops/GitOpsLinkWorkloadDialog.tsx`'s workload-picker rows,
`panels/chat/SuggestedQuestionList.tsx`'s option rows, `panels/components/ListRow.tsx`)
is semantically correct as a native `<button>` — it's a row/card layout, not a
button-shaped affordance, and `Button`'s `inline-flex` + fixed-height sizing
model isn't built for it. These stay native `<button>`. This is a per-file
judgment call for the implementer: a control with an icon + short label at a
button's intrinsic size migrates; a full-bleed row/card does not.

**3. Non-button inline-style cleanup.** The heavy `style={{}}` usage in
`shell/*`, `panels/settings/*`, `panels/chat/*`, `panels/gitops/*` on
*non-button* elements is real drift from the Tailwind-tokens convention but is
a separate, much larger cleanup outside this ticket's scope. Only inline
styles that live directly on a migrated `<button>` are cleaned up as a side
effect of that migration.

## Scope (rough count)

- 1 file changed for the primitive (`button.tsx`) + 1 new test file.
- ~98 consumer files migrated (102 hand-rolling files, minus the 4
  exception files which are migrated for their non-footer buttons only, so
  not fully excluded — no file is 100% excluded except where it truly has
  no in-scope buttons).
- ~233 raw `<button>` elements audited; the row/card subset (exact count
  determined per-file during migration, expect on the order of 15-25 across
  `ListRow.tsx`, `SuggestedQuestionList.tsx`, `GitOpsLinkWorkloadDialog.tsx`,
  `OverviewTab.tsx`-style banners, `ChatHistorySheet.tsx` list rows) stays
  native `<button>` by design (see Out of scope #2).

## Testing

- `pnpm --filter web typecheck` — will **not** catch a leftover hand-rolled
  button (unlike the dialog migration, this isn't an export/prop removal that
  the compiler enforces). The only automated backstop is the grep gate below;
  typecheck still gates that migrated call sites use `Button`'s real prop
  types correctly (e.g. `onClick`, `disabled`, `type`).
- `pnpm --filter web test` — existing tests that query
  `getByRole("button", { name: … })` continue to pass unchanged, since
  `Button` renders a real `<button>` (via base-ui) with the same accessible
  name. Tests asserting on a specific hand-rolled `className` (rare) need
  updating.
- `pnpm --filter web build` — final gate.
- Grep gate (see plan's final task) — `grep -rn "<button" apps/web/src` minus
  the exception files/lines and the documented row/card holdouts, to catch
  stragglers.
- No visual/browser verification is available in this workflow (per
  `feedback_no_web_dev_server`); migrations must follow the recipe's
  before/after examples exactly rather than being "eyeballed."

## Migration approach

Mechanical but large (~98 files). Order, mirroring the dialog-primitive
standardization:

1. Land the one `Button` change (`default` hover) + add `button.test.tsx`.
2. Migrate consumers in batches grouped by area (shell chrome, shared
   components, then panels grouped by feature), each batch typecheck + test
   green before committing.
3. Final gate: full typecheck/test/build + the grep sweep for stray
   hand-rolled buttons, confirming only the documented exceptions and
   row/card holdouts remain.
