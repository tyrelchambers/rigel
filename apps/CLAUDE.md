# Web app — domain notes

TypeScript monorepo. `apps/web` (frontend), `apps/server` (Node backend),
shared `packages/k8s` + `packages/catalog`.

`apps/desktop` is the Electron shell that forks the Node server and loads the
SPA — no separate server process needed for the desktop build.

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

## Guarded actions
- Every mutation goes through a confirm **Sheet** (shadcn `sheet`) that shows the
  EXACT kubectl command before it runs. Never mutate without it.
- Chat action blocks render as buttons that open the same confirm sheet. The
  action-block JSON schema is fixed — see `apps/CONTRACTS.md`. Do not
  invent new `kind` values.

## Where things go
- Panel UI → `apps/web/src/panels/<name>/`
- Server routes → `apps/server/src/`
- Shared parsing/types → `packages/k8s`

## Build / test
- `pnpm --filter web build`, `pnpm --filter web test` (vitest),
  `pnpm --filter web typecheck`.
- `pnpm --filter @rigel/server test` (vitest), `… build`.
  Server dev: `tsx watch src/index.ts`.
