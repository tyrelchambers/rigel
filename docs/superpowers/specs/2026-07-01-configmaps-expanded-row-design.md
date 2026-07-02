# ConfigMaps expanded-row (improved) — design

**Date:** 2026-07-01
**Status:** Implemented (typecheck + build + tests green)
**Area:** `apps/web/src/panels/configmaps/`
**Pencil frame:** `xCFK3` — "ConfigMaps — expanded row (improved)" (`clankerlocal.pen`)

## Problem

The ConfigMaps panel's expanded row body (`ConfigMapDetail`, currently an inline
function in `ConfigMapsPanel.tsx`) is a plain `space-y` stack: a STATUS dl-grid,
a `<ul>` of keys with raw `<pre>` values, and a single ghost Edit button. It
predates the "expanded row (improved)" visual language shipped for Services
(`ServiceDetail`, Pencil frame `x2MuTZ`, commit `4c0e3ec9`) and looks nothing
like the rest of the app's redesigned drop-downs.

## Goal

Reproduce Pencil frame `xCFK3` as the ConfigMaps expanded-row **body**, matching
the Services precedent: the shared `ListRow` keeps rendering the row
header/chevron/kebab (and the collapsed-row chrome), and this work replaces only
the `expandedContent` — the new `ConfigMapDetail`. `ListRow` already provides the
outer padding + `surface-primary` background the body renders into.

The body has three sections (top to bottom in the frame's `Body` node `a1Wi4`):

1. **Meta strip** — KEYS / AGE / NAMESPACE cards.
2. **Keys section** — one code-preview card per data key.
3. **Manage bar** — Edit / Download YAML / Copy / Delete.

### Scope decisions (from brainstorming)

- **Value-type intelligence: Medium.** Each key card shows gutter-numbered
  monospace lines, a byte-size badge, a line count, and a simple detected-kind
  badge (`CERTIFICATE` / `JSON` / `YAML` / `TEXT`). No deep X.509 / format-detail
  parsing (the `.pen`'s "PEM certificate · X.509 · 566 bytes" footer is
  simplified to `<kind> · <bytes>`).
- **No maximize icon.** The frame's per-key `⤢` icon is dropped. Instead the
  code block itself is **scrollable** — capped max-height with vertical scroll
  when the value is tall.
- **Manage-bar "Copy" copies the full manifest YAML** (per-key Copy already
  covers single values).
- **Row header / collapsed rows stay as the shared `ListRow` chrome** (unchanged),
  exactly as the Services `x2MuTZ` body-only redesign did. The chevron/kebab are
  ListRow-owned and shared across every panel, so the frame's row-header styling
  is out of scope for this body redesign.

Non-goals: no server changes (the configmaps watch already delivers
`data`/`binaryData`); no changes to `ListRow`; no ConfigMapEditor changes; no new
`index.css` component classes.

## Architecture

### New file: `ConfigMapDetail.tsx`

`apps/web/src/panels/configmaps/ConfigMapDetail.tsx`

```ts
export function ConfigMapDetail({
  configMap,
  onEdit,
}: { configMap: ConfigMap; onEdit: () => void }): JSX.Element
```

Extracted out of `ConfigMapsPanel.tsx` (mirrors `ServiceDetail.tsx` living beside
`ServicesPanel.tsx`). Renders `<div className="flex flex-col gap-[18px]">` with
the three sections below. Owns two pieces of local state:

- `pendingAction: ActionBlock | null` — drives a `ConfirmSheet` for Delete.
- (Copy/Download feedback is handled by `useCopyToClipboard` / transient flags.)

The `ConfirmSheet` is rendered at the end of the component (same pattern as
PodsPanel/DeploymentsPanel).

### Section 1 — Meta strip

Horizontal row of three equal `MetaCard`s (`flex gap-3`), reusing the shared
`MetaCard` + `SectionLabel` (see Reuse below):

- **KEYS** — big count: `<span 18px bold>{total}</span>` + dim `key`/`keys` unit.
  `total = keyCount(cm)`.
- **AGE** — calendar icon + long human age: `humanAge(cm.metadata.creationTimestamp)`
  (e.g. "165 days"). Same treatment as `ServiceDetail`'s AGE card.
- **NAMESPACE** — a small color dot + `cm.metadata.namespace` (mono). Dot color
  is deterministic per namespace (`namespaceDotColor`, see helpers).

### Section 2 — Keys section

`SectionLabel` reading `KEYS · {total}`, then a vertical stack (`gap-[9px]`) of
one **key card** per entry in `keysSorted(cm)`. Each key card
(`rounded-md border`, `bg-[var(--surface-elevated)]`, `border-[var(--border-subtle)]`,
`overflow-hidden`) has:

1. **Header** (`flex items-center gap-[9px]`, `bg-[var(--surface-elevated)]`,
   bottom border):
   - file icon (`FileKey` for cert, else `FileText` / `FileCode`).
   - key name (mono, semibold).
   - **size badge** — neutral pill, `humanBytes(bytes)`.
   - **kind badge** — `CERTIFICATE` (green, `--status-running`), `JSON`/`YAML`
     (accent, `--accent-primary`), `TEXT` (neutral). `shield-check` icon on cert.
   - spacer (`flex-1`).
   - **Copy** button — copies the key's value (`useCopyToClipboard`; check icon +
     "Copied" on success). Omitted/disabled for binary keys.
2. **Code block** (`bg-[var(--surface-sunken)]`, `max-h-[…] overflow-auto`) — for
   plaintext keys, one row per line: a fixed-width right-aligned gutter number +
   the line text (mono). BEGIN/END PEM lines get a light accent tint (the only
   "highlighting" in Medium scope). For binary keys, a single muted line
   `<binary, {binaryBytes} bytes>` and no gutter.
3. **Footer** (`flex justify-between`, `bg-[var(--surface-elevated)]`, top border):
   left `<kind> · <humanBytes>`, right `{n} lines` (omitted for binary).

Empty state (no data keys) → a muted "No data keys" line (kept from current).

### Section 3 — Manage bar

`flex items-center gap-3`, top border, leading `MANAGE` `SectionLabel`:

- **Edit** — accent-filled button (`bg-[var(--accent-primary)]/…`, accent border),
  `Pencil` icon → calls `onEdit()` (existing `openEdit(cm)` → `ConfigMapEditor`).
- **Download YAML** — neutral button, `Download` icon → `fetchResourceYaml` then
  `downloadText(`${name}.yaml`, yaml)`.
- **Copy** — neutral button, `Copy` icon → `fetchResourceYaml` then clipboard
  (transient "Copied").
- spacer (`flex-1`).
- **Delete** — red/destructive button (`bg-[var(--status-failed)]/…`), `Trash2`
  icon → sets `pendingAction` to a `deleteResource` block; the `ConfirmSheet`
  shows the exact `kubectl delete configmap <name> -n <ns>` before running.

Delete action block:

```ts
{ kind: "deleteResource", resourceKind: "configmap",
  name: cm.metadata.name, namespace: cm.metadata.namespace,
  destructive: true, label: `Delete ${cm.metadata.name}` }
```

(`deleteResource` + `resourceKind: configmap` is already supported server-side —
`apps/server/src/actions.ts` `resolveDeleteResource`.)

## Display helpers (`configmapsDisplay.ts` additions)

Pure, unit-tested functions (extend `configmapsDisplay.test.ts`):

- `humanBytes(n: number): string` — `566` → `"566 B"`, `1536` → `"1.5 KB"`, etc.
- `valueKind(key: string, value: string): "certificate" | "json" | "yaml" | "text"`
  - `certificate` when value contains `-----BEGIN CERTIFICATE-----`.
  - `json` when the trimmed value starts with `{`/`[` and `JSON.parse` succeeds.
  - `yaml` when the key ends `.yaml`/`.yml` (extension heuristic — Medium scope,
    no structural YAML parse).
  - `text` otherwise.
- `kindLabel(kind)` → `"CERTIFICATE" | "JSON" | "YAML" | "TEXT"`.
- `valueLines(value: string): string[]` — split on `\n`, trailing-newline aware,
  used for the gutter-numbered rows and the `{n} lines` count.
- `namespaceDotColor(ns: string): string` — deterministic hash of the namespace
  into a small fixed hex palette (self-contained; the app has no existing
  namespace-color helper). Returns a hex string for the dot fill.

Existing helpers reused unchanged: `keyCount`, `binaryKeyCount`, `keysSorted`,
`isBinaryKey`, `plaintextBytes`, `binaryBytes`, `relativeAge`.

## Reuse & targeted refactors

In direct service of this body (not unrelated cleanup):

1. **Extract `MetaCard` + `SectionLabel`** out of `ServiceDetail.tsx` into a
   shared `apps/web/src/panels/components/MetaCard.tsx`. `ServiceDetail` imports
   them (verbatim markup, no visual change); `ConfigMapDetail` reuses them for the
   Meta strip. The frame's meta cards are pixel-identical to Services'
   (`rounded-md border px-[15px] py-[13px] bg-[var(--surface-elevated)]
   border-[var(--border-subtle)]`, `gap-[9px]` + a `10.5px` mono uppercase label).
2. **Lift `humanAge`** from `servicesDisplay.ts` into the shared age home
   `apps/web/src/panels/pods/podDisplay.ts` (already the source of `relativeAge`).
   `servicesDisplay.ts` and `configmapsDisplay.ts` both re-export it, so there is
   one long-form age formatter and existing `servicesDisplay` imports/tests are
   untouched.
3. **Export `fetchResourceYaml`** from `apps/web/src/lib/api.ts` (moved out of
   `ResourceYamlViewer.tsx`, which then imports it). Powers both the viewer and
   the new Download YAML / Copy. Add a tiny `apps/web/src/lib/download.ts`
   `downloadText(filename, text)` (Blob → object URL → anchor click → revoke).
4. **Reuse as-is:** `ListRow`, `ConfirmSheet`, `ConfigMapEditor`,
   `useCopyToClipboard`, `StatusBadge`.

## Styling

Tailwind utilities + token arbitrary values only — no `style={{}}` raw hex, no new
`index.css` classes (per the repo's design-token rule). Token map from the frame:

| Frame fill | Token |
|---|---|
| `#1B1C1F` surface.elevated (cards, header/footer) | `--surface-elevated` |
| `#0C0D0F` surface.sunken (code block) | `--surface-sunken` |
| `#26272B` border.subtle | `--border-subtle` |
| `#6B6B73` fg (labels, dim) | `--fg-tertiary` |
| `#A1A1AA` fg (values, code) | `--fg-secondary` |
| `#FFFFFF` fg (names, count) | `text-foreground` |
| `#38BDF8` accent (Edit, JSON/YAML) | `--accent-primary` |
| `#34D07F` green (CERTIFICATE) | `--status-running` |
| `#EF4444` red (Delete) | `--status-failed` |

Match the frame's exact spacings (`gap-[18px]`, `gap-[9px]`, `px-[15px]`,
`py-[13px]`, `px-[14px]`, `py-[10px]`, code gutter `w-[22px]`, etc.), the same
approach `ServiceDetail` already uses.

## Data flow

- `ConfigMapsPanel` already tracks expand state and passes
  `expandedContent={<ConfigMapDetail configMap={cm} onEdit={() => openEdit(cm)} />}`.
  Only the component internals change; the wiring line stays.
- `ConfigMapDetail` reads `data` / `binaryData` / `metadata` straight from the
  ConfigMap object in the Zustand store.
- Delete goes through `ConfirmSheet` → `/api/action` (guarded). Download/Copy read
  YAML via `GET /api/resource` (the existing endpoint `fetchResourceYaml` calls).
- No new subscriptions, no server changes.

## Error handling / edge cases

- **Binary keys** — no code lines; a muted `<binary, N bytes>` note; kind badge
  `BINARY`; no per-key Copy.
- **Empty value** — renders one empty gutter line; footer `0 B · 1 line`.
- **Huge value** — code block caps height and scrolls (no maximize needed).
- **Download / Copy failure** — `fetchResourceYaml` throws → surface a small
  inline error/toast state on the button (non-fatal; the row stays usable).
- **Delete of a mid-stream object** — `deleteResource` uses the live name/namespace;
  `--ignore-not-found` semantics live server-side.

## Testing

- **Display helpers** (`configmapsDisplay.test.ts`): `humanBytes` rounding/units;
  `valueKind` for cert / JSON / YAML-by-extension / plain text; `valueLines`
  line-count incl. trailing newline; `namespaceDotColor` determinism (same ns →
  same color) and palette membership.
- **Component smoke** (vitest + RTL, `ConfigMapDetail.test.tsx`): renders a
  fixture with a plaintext key, a cert key, and a binary key without crashing;
  Meta strip shows the key count; Delete click opens a `ConfirmSheet` previewing
  `delete configmap`; per-key Copy calls the clipboard.
- **Regression:** `ServiceDetail` renders identically after the `MetaCard`
  extraction; `servicesDisplay` `humanAge` tests still pass after the move.
- Gates: `pnpm --filter web typecheck`, `pnpm --filter web test`,
  `pnpm --filter web build`.

## Files touched

New:
- `apps/web/src/panels/configmaps/ConfigMapDetail.tsx`
- `apps/web/src/panels/components/MetaCard.tsx` (extracted from `ServiceDetail`)
- `apps/web/src/lib/download.ts` (`downloadText`)
- `apps/web/src/panels/configmaps/ConfigMapDetail.test.tsx`

Modified:
- `apps/web/src/panels/configmaps/ConfigMapsPanel.tsx` (remove inline
  `ConfigMapDetail`; import the new component; wiring line unchanged)
- `apps/web/src/panels/configmaps/configmapsDisplay.ts` (new helpers + `humanAge`
  re-export)
- `apps/web/src/panels/configmaps/configmapsDisplay.test.ts` (new helper tests)
- `apps/web/src/panels/services/ServiceDetail.tsx` (consume shared `MetaCard`)
- `apps/web/src/panels/pods/podDisplay.ts` (host `humanAge`)
- `apps/web/src/panels/services/servicesDisplay.ts` (re-export `humanAge`)
- `apps/web/src/lib/api.ts` (export `fetchResourceYaml`)
- `apps/web/src/components/ResourceYamlViewer.tsx` (import shared `fetchResourceYaml`)
