# Feature 3 — Cluster + namespace pill on the tool status line

## Summary

When the chat copilot runs a command, the tool card (`ToolCard`) should show
which **cluster (kube context)** and **namespace** the command targeted, as a
small muted pill on the card's header row. The values are parsed directly from
the command string, so the pill reflects exactly what ran.

## Why

In a multi-cluster setup a reader can't tell which cluster/namespace a `kubectl`
in chat hit. The system prompt forces `--context <ctx>` on every kubectl call,
and `-n <ns>` appears when the model targets a namespaced resource, so the
command itself is a reliable source of truth.

## Approach

Frontend-only. Parse the target out of `tool.command`; render a pill in the
`ToolCard` header. No server change, no new tool-event field.

## Components

- `parseCommandTarget(command?): { context?: string; namespace?: string }` — pure,
  unit-tested. `context` from `--context[=\s]+(\S+)`; `namespace` from
  `(?:-n|--namespace)[=\s]+(\S+)`. Returns `{}` for a non-kubectl command.
  Co-located with the chat panel (e.g. `apps/web/src/panels/chat/toolTarget.ts`).
- `ToolCard.tsx` — render a pill in the header row when `context` is present:
  a small `faServer`-style icon + `ctx` and, when a namespace was parsed,
  `· ns`. Muted, mono, `text-2xs`. Placed just left of the status Badge
  (move `ml-auto` onto the pill so pill + status + chevron form the right group).
  When no context is parsed (plain Bash), render no pill.

## Behavior / edge cases

- No `--context` in the command → no pill (non-kubectl Bash).
- `--context` but no `-n` → show just the cluster (cluster-scoped or
  all-namespaces command). No UI-namespace fallback.
- Values are shown verbatim (no fabrication).

## Testing

- Unit: `parseCommandTarget` (context only; context + namespace; `--namespace=`
  form; no context; `-n` absent).
- Component: `ToolCard` renders the pill for a kubectl command and omits it for
  a plain command.
