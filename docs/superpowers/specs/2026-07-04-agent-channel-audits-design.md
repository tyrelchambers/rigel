# Agent Channel-Triggered Audits — Design

**Ticket:** HELM-20 (audit skills — agent phase)
**Date:** 2026-07-04
**Status:** Approved, ready for plan + implementation
**Builds on:** the merged audit engines + `rigel-audit` CLI + desktop skills.

## Summary

Let the in-cluster agent run the deterministic audits **on demand, triggered by a
natural-language message on a channel** (Signal/Matrix). No autonomous/scheduled
runs, no Needs-you queue. When the operator texts the agent something like "run a
security audit," the agent's existing free-text **diagnose** model recognizes it,
runs `rigel-audit <kind> --json`, and replies with a concise, phone-friendly
findings summary.

Detection stays **deterministic** (the `@rigel/k8s` rules engine via the CLI, not
model judgment); the AI only decides to run it and presents the result. This is
symmetric with the desktop assistant (same CLI, same metrics-backend detection),
over the same `claude` CLI bridge the agent already uses for diagnosis.

## Why this shape

The agent's `diagnose` handler (`agent/src/diagnose.ts`) already runs a `claude
-p` model with an `--allowedTools` allowlist of read-only kubectl patterns. The
cleanest way to give that model the audit capability is to (a) bundle the
`rigel-audit` CLI into the agent image and (b) allowlist `Bash(rigel-audit *)`.
The model then runs the CLI exactly as the desktop skill does. Claude Code SKILL.md
files are **not** used here: headless `-p` only auto-expands `/skill-name`, not
natural language, so a CLI + a system-prompt hint is the correct mechanism for the
NL path.

## Components

### 1. `rigel-audit` in the agent image (`agent/Dockerfile`)

The agent image is a two-stage esbuild build (build context = repo root; the build
stage already `COPY`s `agent/` + `packages/k8s/src`). Add:
- **Build stage:** `COPY packages/audit-cli/{package.json,tsconfig.json,src}`, then
  bundle it with the agent's already-installed esbuild:
  `npx esbuild packages/audit-cli/src/index.ts --bundle --platform=node
  --format=esm --tsconfig=packages/audit-cli/tsconfig.json
  --outfile=/app/packages/audit-cli/dist/rigel-audit.mjs`.
- **Runtime stage:** `COPY --from=build .../rigel-audit.mjs
  /usr/local/bin/rigel-audit.mjs`, and write a tiny wrapper
  `/usr/local/bin/rigel-audit` (`#!/bin/sh\nexec node /usr/local/bin/rigel-audit.mjs "$@"`),
  both `chmod +x`. Node 22 is already in the runtime image.

**Build-resolution fix (`packages/audit-cli/tsconfig.json`):** audit-cli currently
resolves `@rigel/k8s` via the pnpm workspace symlink, which does not exist in the
agent's npm/esbuild Docker build. Add `baseUrl: "."` + `paths`:
`"@rigel/k8s": ["../k8s/src/index.ts"]`, `"@rigel/k8s/src/*": ["../k8s/src/*"]`, so
esbuild inlines it by source (mirrors how the agent consumes `@rigel/k8s`). This is
additive: the pnpm dev build, vitest, and the desktop `rigel-audit` build keep
working (the paths point at the same source the symlink already reaches, and the
workspace dep stays for vitest's resolution).

### 2. Diagnose model gains the audit (`agent/src/diagnose.ts`)

- Add `"Bash(rigel-audit *)"` to `READ_ONLY_TOOLS`. It flows through
  `runModel` → claude bridge → `--allowedTools` unchanged. `rigel-audit` is
  read-only, so this cannot mutate anything.
- Extend `SYSTEM_PROMPT` with audit guidance: "If the operator asks for a
  reliability, security, or performance audit, run `rigel-audit <kind> --json`
  (pipe through `jq` to summarize on a large cluster), then report the findings
  grouped by severity, concisely for a phone. NEVER invent CPU/memory request or
  limit numbers — size a fix only from a finding's `evidence`; if there is no
  evidence, say a metrics backend is needed. Don't re-run detection or invent
  findings beyond the CLI output."

**Non-Claude worker note:** `diagnose` uses `role: "worker"`. If that role is set
to a non-Claude provider, `--allowedTools` doesn't apply, but `rigel-audit` still
runs (allowed by `commandPolicy.classifyCommand` as non-mutating). Works either
way; no extra handling needed.

### 3. RBAC (`packages/k8s/src/assistant.ts` `rigel-assistant` ClusterRole)

The reliability/performance engines read PodDisruptionBudgets and HPAs, which the
CLI fetches via the agent's ServiceAccount. Add two read rules:
- `apiGroups: ["policy"]`, `resources: [poddisruptionbudgets]`, `verbs: [get, list, watch]`
- `apiGroups: ["autoscaling"]`, `resources: [horizontalpodautoscalers]`, `verbs: [get, list, watch]`

Security reads only workloads (already granted). Performance's metrics reads go
through `services/proxy` (already granted) + the metrics backend the agent already
detects.

## Data flow

Operator texts "run a security audit" → Signal/Matrix inbound (auth + de-dup, no
change) → `parseCommand` → free text → `diagnose` handler → `runDiagnosis` →
`claude -p` with the extended prompt + `Bash(rigel-audit *)` allowed → model runs
`rigel-audit security --json` → deterministic engine over kubectl → model
summarizes by severity → chunked reply on the channel.

## Testing

- **`diagnose.ts`:** unit-assert `READ_ONLY_TOOLS` includes `"Bash(rigel-audit *)"`.
- **RBAC:** assert the rendered `rigel-assistant` ClusterRole YAML contains
  `poddisruptionbudgets` and `horizontalpodautoscalers` with read verbs (extend the
  existing `assistant` rbac test).
- **audit-cli:** existing tests + build + typecheck still green after the tsconfig
  `paths` addition.
- **Not unit-testable (verify by review + live):** the Dockerfile change (the dev
  machine has no Docker; verified when the image builds in CI) and the end-to-end
  behavior (message the agent "run a security audit" on Signal/Matrix once
  deployed).

## Out of scope

- Autonomous/scheduled audits, Needs-you queueing, audit digests (the user
  explicitly chose channel-triggered only).
- A dedicated `audit` command keyword (the user chose the natural-language AI path).
- Confirm-gated fix buttons on channels (channels are text; the diagnose model is
  read-only and points at the existing approve/queue flow for mutations).

## Files

**Edit:** `agent/Dockerfile`, `agent/src/diagnose.ts`, `packages/k8s/src/assistant.ts`
(ClusterRole), `packages/audit-cli/tsconfig.json`. Tests: `agent/src/diagnose.test.ts`
(new or extend), `packages/k8s/src/assistant.test.ts` (extend rbac assertions).
