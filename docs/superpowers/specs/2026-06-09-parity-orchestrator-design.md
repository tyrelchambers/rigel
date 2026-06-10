# Parity Orchestrator — Design

**Date:** 2026-06-09
**Branch:** `feature/web-rewrite`
**Status:** Approved (brainstorm), pending implementation plan
**Built:** first — then used in porter mode to drive the web rewrite (companion
spec: `2026-06-09-helmsman-web-rewrite-design.md`).

## Goal

A deterministic multi-agent **Workflow** that takes one change description and
keeps the Swift app (`Sources/`) and the web app (`apps/`) implementing the same
behavior. A manager produces a single normative spec; domain sub-agents implement
(or extract) in their own codebases; a verifier confirms parity and builds/tests.

This is built **first** and used as a **porter** to drive the web rewrite: each
panel is ported from the Swift source of truth into the web monorepo through the
same orchestration that will later keep both apps in sync.

## The core rule

The manager produces **one normative spec first**; sub-agents implement against
the spec, never against the raw English request. Independent agents handed the
same prose diverge (naming, edge cases, missing confirm dialogs). Spec-first
prevents drift.

Three surfaces are **manager-owned shared contracts**, handed identically to both
agents and never re-derived per app:

- the chat **action-block JSON protocol**,
- **MCP tool** names / shapes,
- the **`catalog.json`** schema.

These live in `docs/parity/contracts.md`.

## Two modes

A `mode` argument selects the source of truth and flips the Swift-agent's role.

### Porter mode (during the rewrite; Swift = source of truth)

```
you → manager (decompose request, load shared contracts)
        ├── Swift-agent (EXTRACTOR): reads the target panel/feature in Sources/,
        │                            emits normative behavior spec — columns,
        │                            fields, actions, edge cases, exact kubectl
        │                            commands → docs/parity/<feature>.md
        ├── Web-agent (BUILDER): implements that spec in apps/web + apps/server
        └── Verifier: checks web impl against the spec; runs pnpm build + test
```

The Swift-agent does **not** write code in porter mode — it extracts authoritative
behavior. This makes the two agents genuinely distinct (extract vs build) instead
of redundant.

### New-feature mode (after parity; no existing source of truth)

```
you → manager (write normative spec from request, load shared contracts)
        ├── Swift-agent (IMPLEMENTER): implements spec in Sources/
        ├── Web-agent (IMPLEMENTER): implements spec in apps/
        └── Verifier: builds/tests BOTH (swift build + swift test, pnpm build +
                      test); diffs observed behavior against the spec
```

## Domain knowledge

Each sub-agent is grounded in codebase-specific context so it implements idiomatically:

- `Sources/Helmsman/CLAUDE.md` — Swift / SwiftUI conventions, panel structure,
  `KubectlClient` / `ProcessAsync` usage, action-block emission.
- `apps/CLAUDE.md` — web stack conventions (React 19, Tailwind v4, shadcn,
  TanStack Query, Zustand store, WS/REST split, confirm-sheet pattern).
- `docs/parity/contracts.md` — the shared contracts above.

Each agent receives its per-app CLAUDE.md + the contracts doc as context.

## Workflow structure

Implemented with the `Workflow` tool. Phases:

1. **Manager** — one agent. Porter mode: instruct the extractor and assemble the
   request scope + contracts. New-feature mode: author the normative spec.
2. **Extract / Implement** — `parallel()` (new-feature) or sequential
   extract-then-build (porter). Agents use `agentType` with the matching per-app
   CLAUDE.md context; no worktree needed (Swift edits `Sources/`, web edits
   `apps/` — non-overlapping paths).
3. **Verify** — one agent (or two in new-feature mode) that runs the build/test
   commands and compares against the spec. Returns a structured verdict
   (`{ parity: bool, issues: [...] }`).

The normative spec is always written to `docs/parity/<feature>.md` before the
build step, giving an audit trail and a human review point.

### Verification commands

- **Swift:** `swift build`, `swift test` (see `Makefile`, `Tests/HelmsmanTests`).
- **Web:** `pnpm --filter <pkg> build`, `pnpm --filter <pkg> test` (vitest),
  typecheck.

## Invocation

Run via the `Workflow` tool with `args` carrying `{ mode, feature, request }`.
Optionally wrapped in a `/parity-feature` slash-command later for ergonomics, but
the durable form is the Workflow script (committed under `.claude/workflows/` or
the session script path).

## Build order

1. Scaffold the monorepo skeleton enough that `apps/` and `packages/` exist as
   valid targets (so the web-agent has somewhere to write). Minimal: workspace
   config + empty `apps/web`, `apps/server`.
2. Write the domain context files (`Sources/Helmsman/CLAUDE.md`, `apps/CLAUDE.md`)
   and `docs/parity/contracts.md`.
3. Author the parity-orchestrator Workflow script (manager + extractor/builder +
   verifier, both modes).
4. Dogfood it in porter mode on **P0 (Pods panel + chat)** to validate the
   orchestration end-to-end before porting the rest.

## Out of scope

- Auto-merging or auto-committing agent output (human reviews diffs + the
  `docs/parity/<feature>.md` spec each run).
- Bidirectional conflict resolution when both apps have diverged independently
  (assumes one source of truth per run).
```
