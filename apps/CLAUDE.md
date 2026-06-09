# Web app — domain notes (for the parity web builder/implementer)

TypeScript monorepo. `apps/web` (frontend), `apps/server` (Bun backend),
shared `packages/k8s` + `packages/catalog`.

## Stack & conventions
- React 19 + Vite + TypeScript. Tailwind v4 (via `@tailwindcss/vite`, `@import
  "tailwindcss"` in `index.css`). shadcn/ui for primitives — add components with
  `pnpm dlx shadcn@latest add <name>`; do not hand-roll what shadcn provides.
- **TanStack Query v5** owns request/response + mutations (one-shot reads,
  actions, installs). Query keys: `[kind, namespace?, name?]`.
- **Zustand store** (`src/store/cluster.ts`) holds live cluster state, fed by the
  WebSocket. Panels read live lists from the store, not from polling queries.
- **React Router v7** — one route per panel under `src/panels/<name>/`.
- Path alias `@/` → `apps/web/src`.

## Transport split (talk to the server, never kubectl directly)
- **WebSocket `/ws`** — subscribe to live resource watches (snapshot + deltas)
  and stream chat tokens/thinking/action-blocks.
- **REST `/api/*`** — one-shot mutations (scale/restart/delete/edit/port-forward)
  and catalog installs. The server runs the guarded kubectl.

## Guarded actions (MUST match the Swift behavior)
- Every mutation goes through a confirm **Sheet** (shadcn `sheet`) that shows the
  EXACT kubectl command before it runs. Never mutate without it.
- Chat action blocks render as buttons that open the same confirm sheet. The
  action-block JSON schema is fixed — see `docs/parity/contracts.md`. Do not
  invent new `kind` values.

## When BUILDING from a parity spec
- Implement to the normative spec in `docs/parity/<feature>.md` exactly — same
  columns, actions, edge cases, and kubectl commands the extractor recorded.
- Put panel UI in `apps/web/src/panels/<name>/`, server routes in
  `apps/server/src/`, shared parsing/types in `packages/k8s`.

## Build / test
- `pnpm --filter web build`, `pnpm --filter web test` (vitest),
  `pnpm --filter web typecheck`.
- `pnpm --filter @helmsman/server test` (bun test), `… build`.
