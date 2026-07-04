# Audit Monetization Gate — Implementation Plan

> Small feature. Steps use `- [ ]`. Spec: `docs/superpowers/specs/2026-07-04-audit-monetization-gate-design.md`. **Write NO comments in the implemented code** (per user); the spec documents intent.

**Goal:** A shared `canRunAudit(kind, entitlement)` seam (allow-all today) consulted at the desktop Audits tab and the agent channel path (via the CLI), ready to gate per audit when HELM-16 lands.

---

## Task 1: the entitlement seam (`@rigel/k8s`)

**Files:** create `packages/k8s/src/auditEntitlement.ts` (+ `auditEntitlement.test.ts`); edit `packages/k8s/src/index.ts`.

- [ ] Implement per the spec: `AuditKind`, `ALL_AUDIT_KINDS`, `AuditEntitlement`, `AuditGate`, `canRunAudit`, `DEFAULT_AUDIT_ENTITLEMENT`, `parseUnlockedAudits`. No comments.
- [ ] Tests: `canRunAudit` allowed (unlocked kind) vs locked (reason contains the kind + "premium"); `parseUnlockedAudits("")`/`undefined` → all unlocked; `parseUnlockedAudits("reliability,security")` → those two; unknown tokens dropped; `DEFAULT_AUDIT_ENTITLEMENT.unlocked` = all three.
- [ ] Barrel-export all six names from `index.ts` (no duplicate exports).
- [ ] Verify: `pnpm --filter @rigel/k8s test auditEntitlement && pnpm --filter @rigel/k8s typecheck`.
- [ ] Commit: `feat(k8s): canRunAudit monetization seam for audits (HELM-16)`.

## Task 2: CLI enforces the gate (`packages/audit-cli`)

**Files:** edit `packages/audit-cli/src/index.ts` (+ `cli.test.ts`); reuse the shared `AuditKind`.

- [ ] In `packages/audit-cli/src/audits.ts` (or wherever `AuditKind` is defined locally), replace the local `AuditKind` union with an import of `AuditKind` from `@rigel/k8s` (avoid two definitions). Verify types still line up.
- [ ] In `runAudit` (or `main`, before any kubectl gathering), consult the gate: `const gate = canRunAudit(kind, parseUnlockedAudits(process.env.RIGEL_UNLOCKED_AUDITS))`. If `!gate.allowed`, throw / return an error so `main` writes `gate.reason` to stderr and exits code 2 — BEFORE any `runner` (kubectl) call. Keep the injected-runner testability: read the env inside `main` (or accept an entitlement param defaulting to the env) so tests can drive it without mutating global env, OR set/restore `process.env.RIGEL_UNLOCKED_AUDITS` in the test.
- [ ] Tests: `RIGEL_UNLOCKED_AUDITS="reliability"` → `runAudit("security", stubRunner)` (or `main(["security"])`) exits/throws with the reason and the stub runner is NEVER called; unlocked kind runs normally; unset env runs everything. Use a stub runner that records calls to assert no kubectl on the locked path.
- [ ] Verify: `pnpm --filter @rigel/audit-cli test && pnpm --filter @rigel/audit-cli typecheck && pnpm --filter @rigel/audit-cli build`.
- [ ] Commit: `feat(audit-cli): gate audits on RIGEL_UNLOCKED_AUDITS entitlement (HELM-16)`.

## Task 3: desktop Audits tab UI gate

**Files:** create `apps/web/src/panels/assistant/audits/useAuditEntitlement.ts`; edit `AuditSkillsTab.tsx` (+ test), `AuditSkillCard.tsx`.

- [ ] `useAuditEntitlement()` returns `DEFAULT_AUDIT_ENTITLEMENT` (from `@rigel/k8s`). One-line body; this is the future swap point.
- [ ] `AuditSkillCard`: add an optional `locked?: { reason: string }` prop. When set, render the disabled/locked treatment (dim the card, show a lock/"Upgrade" chip, disable the Run button, show the `reason`) instead of the live Run. Reuse the earlier "coming soon"/disabled visual language (Tailwind + var(--…) tokens, no comments).
- [ ] `AuditSkillsTab`: call `useAuditEntitlement()`; for each `AUDIT_SKILLS` entry compute `canRunAudit(skill.key, entitlement)`. If allowed → live card with `onRun` (unchanged). If locked → pass `locked={{ reason: gate.reason! }}` and no `onRun`.
- [ ] Test: mock `useAuditEntitlement` (or `@rigel/k8s` `canRunAudit`) so one audit (e.g. security) is locked. Assert: security card shows the locked treatment / disabled Run and clicking it does NOT call `handoffToChat`; reliability + performance still launch with their `/rigel-<kind>-audit` slash. Keep the existing `AuditSkillCard count summary` describe block.
- [ ] Verify: `pnpm --filter web test AuditSkillsTab && pnpm --filter web typecheck && pnpm --filter web build`.
- [ ] Commit: `feat(web): gate Audits tab cards on the audit entitlement (HELM-16)`.

## Verification (whole feature)

`pnpm --filter @rigel/k8s test && pnpm --filter @rigel/audit-cli test && pnpm --filter web test && pnpm --filter web typecheck`. All green; everything allow-all today (DEFAULT entitlement / unset env), so no behavior change until a real plan is supplied.
