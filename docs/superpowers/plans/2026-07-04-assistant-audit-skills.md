# Assistant Audit Skills — Implementation Plan

> Subagent-driven execution. Steps use `- [ ]`. Builds on the three deterministic engines (reliability/security/performance) already on `feature/security-performance-audits`.

**Goal:** Give the Rigel *assistant* (local `claude -p`) real Claude Code skills that run the deterministic audit engines and drive evidence-based remediation.

**Verified mechanics (claude-code-guide):** skills work in `-p` when invoked by putting `/skill-name` in the prompt (Claude Code expands it; the model does NOT auto-select in `-p`). Both `~/.claude/skills` and project `.claude/skills` (relative to spawn cwd) are discovered. `Skill` must be in `--allowedTools`; a skill's `allowed-tools` frontmatter pre-approves its tools.

**Runtime (verified):** chat `claude` runs locally — Electron forks the Node server (cwd `resources/server` packaged), which `spawn`s `claude`. Real user `~/.claude`/PATH. Delivery via electron-builder `extraResources`; run bundled node via `ELECTRON_RUN_AS_NODE` (like `permissionHook.mjs`).

**Decisions:** skills ship in **app resources** (`resources/server/.claude/skills`, project-level, no user-home writes); Audits tab cards become **pure launchers** (Run → `/rigel-<kind>-audit`), dropping web-computed counts (single detection path = the CLI).

---

## Group F1 — Shared detection adapter (refactor, safe/testable)

Move the raw-k8s-object → engine-input adapter into `@rigel/k8s` so the CLI and web share ONE detection path.

- **Move** `apps/web/src/panels/assistant/audits/extractAuditInputs.ts` → `packages/k8s/src/extractAuditInputs.ts` (and its test). Extend it to populate ALL fields the three engines need (reliability + security + performance) from raw kubectl-JSON objects. It must not depend on web-only modules.
- **Move** `parseQuantity` (currently `apps/web/src/panels/rightsizing/displayHelper.ts`) into `@rigel/k8s` (e.g. `packages/k8s/src/quantity.ts`) since the adapter needs it; re-export from the web displayHelper so right-sizing is unchanged. Add a focused `quantity.test.ts`.
- **Security field note (folds in the Group B review finding):** when reading container `securityContext.runAsNonRoot`, populate it as `true`/`false`/`undefined` faithfully, and the security engine's `runsAsNonRoot` must treat an explicit container `runAsNonRoot: false` as NOT establishing non-root (add `if (c.runAsNonRoot === false) return false;` after the `=== true` check) + a test. This closes the theoretical false-negative now that the field is populated.
- **Barrel**: export `extractAuditInputs`, `parseQuantity` from `@rigel/k8s`. Update web imports (`useReliabilityAudit`, right-sizing) to the new locations.
- **Verify**: `pnpm --filter @rigel/k8s test && pnpm --filter web test && pnpm --filter web typecheck` all green (behavior unchanged; existing audit + right-sizing tests pass).

## Group F2 — `rigel-audit` CLI (new package, testable)

- **New workspace package** `packages/audit-cli` (name `@rigel/audit-cli`), a Node CLI: `rigel-audit <reliability|security|performance> [--context X] [--namespace Y] [--json]`.
  - Depends on `@rigel/k8s` (engines + `extractAuditInputs` + `prometheus.ts` helpers).
  - **Injectable kubectl runner** (`(args: string[]) => Promise<string>`) so it's unit-testable without a cluster; the real runner shells `kubectl` (resolving `--context` like `watchManager`).
  - **reliability/security**: `kubectl get deployments,statefulsets,daemonsets,poddisruptionbudgets,horizontalpodautoscalers -o json` → `extractAuditInputs` → `analyze{Reliability,Security}` → sort + print `{ audit, findings, counts }` JSON.
  - **performance (hybrid)**: also detect a metrics backend (`detectAllBackendsFromServices` over `kubectl get services -o json`); if present, run the usage PromQL via `kubectl get --raw <proxy>` (reuse the server `prometheusMetrics` query shapes), build a `PerfUsageProvider`, pass to `analyzePerformance`; else spec-only (no `usage`). Evidence only when backend present.
  - Output is stable JSON (findings incl. `evidence`), ready for a skill to format.
- **Tests**: unit tests with a stubbed kubectl runner returning fixture JSON — assert each audit's findings + that performance degrades to spec-only when the services list has no backend, and attaches evidence when a stubbed `--raw` returns usage.
- **Build**: bundle to a single `.mjs` (esbuild, like the server bundle) at `packages/audit-cli/dist/rigel-audit.mjs`.

## Group F3 — SKILL.md files (content)

Three skills in `resources/server/.claude/skills/` (source in `apps/desktop/resources/skills/` or a repo dir copied by packaging):
- `rigel-reliability-audit/SKILL.md`, `rigel-security-audit/SKILL.md`, `rigel-performance-audit/SKILL.md`.
- Frontmatter: `name`, `description`, `allowed-tools: Bash(rigel-audit *)`.
- Body: "Run `rigel-audit <kind> --json`. Present the findings grouped by severity (Critical, Warning, Info) as a markdown list; explain each in one plain sentence. For each fixable finding emit a ```action block (the app renders a confirm-gated button) — map types to kinds as the finding's fix suggests (scale/setImage/setResources/applyManifest). NEVER invent CPU/memory request or limit numbers: size them only from a finding's `evidence`; if a finding has no `evidence`, recommend the change qualitatively and note a metrics backend is needed. Do not re-run detection or invent findings beyond the CLI output." Keep the same bounded-output discipline (present the highest-severity first if the list is large).

## Group F4 — Wiring (OUTWARD-FACING — review checkpoint before shipping)

These change the shipped app + the assistant's permissions; verify with care.
- **`claudeBridge.ts`**: add `"Skill"` and `"Bash(rigel-audit *)"` (+ context-agnostic) to the `--allowedTools` construction. (The `rigel-audit` binary is made available on the spawn env PATH, or the skills call it by absolute `process.resourcesPath` path exported via env.)
- **Desktop packaging** (`apps/desktop/electron-builder.yml`): `extraResources` entries for `resources/server/.claude/skills/**` and the bundled `rigel-audit.mjs`; a small launcher so `rigel-audit` runs via `ELECTRON_RUN_AS_NODE=1 <execPath> <rigel-audit.mjs>`. `afterPack` chmod if needed. Provide the CLI path to the chat spawn via env (e.g. `RIGEL_AUDIT_BIN`).
- **Audits tab**: `AuditSkillsTab` Run buttons call `handoffToChat("/rigel-<kind>-audit", { newThread: true })` for all three (reliability included — migrate it off `buildReliabilityAuditPrompt`); cards become pure launchers. Retire `buildAuditPrompt`/`auditPrompt.ts` and the `use*Audit` count hooks once nothing uses them (or keep reliability's until parity).
- **Note**: natural-language "run a security audit" won't auto-trigger a skill in `-p`; the tab Run (slash invocation) is the entry point. Consider a system-prompt line telling users to use the Audits tab.

## Out of scope (this phase)
In-cluster agent running audits autonomously (next phase, per "both"); premium gating (HELM-16); non-audit skills.
