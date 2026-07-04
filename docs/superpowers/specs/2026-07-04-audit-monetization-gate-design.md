# Audit Monetization Gate — Design

**Ticket:** HELM-20 / HELM-16 (monetization seam for the audit skills)
**Date:** 2026-07-04
**Status:** Approved, ready for plan + implementation

## Summary

Scaffold the premium-audit gate now so it can be turned on when accounts/billing
(HELM-16) exist. A single pure `canRunAudit(kind, entitlement)` seam, mirroring
the existing `canConnect`, is consulted at both user-facing trigger surfaces — the
desktop Audits tab and the agent's channel path (via the `rigel-audit` CLI). Today
everything resolves to **allow-all**; each surface has one obvious swap point where
a real entitlement plugs in later.

Decisions (approved): the gate is **per-audit** (`reliability`/`security`/
`performance` independently gateable), enforced at **the desktop Audits tab + the
agent channel path**.

## The seam — `packages/k8s/src/auditEntitlement.ts` (shared)

Placed in `@rigel/k8s` so the web, the agent, and the CLI all use one source.

```ts
export type AuditKind = "reliability" | "security" | "performance";
export const ALL_AUDIT_KINDS: AuditKind[] = ["reliability", "security", "performance"];

export interface AuditEntitlement {
  /** Audit kinds the current plan unlocks. */
  unlocked: AuditKind[];
}

export interface AuditGate {
  allowed: boolean;
  reason?: string;
}

/**
 * Monetization seam (HELM-16). Today DEFAULT_AUDIT_ENTITLEMENT unlocks every
 * audit, so this returns allowed for all. When accounts/billing land, a real
 * entitlement derived from the user's plan is passed in and gates per audit.
 */
export function canRunAudit(kind: AuditKind, entitlement: AuditEntitlement): AuditGate {
  if (entitlement.unlocked.includes(kind)) return { allowed: true };
  return { allowed: false, reason: `The ${kind} audit is a premium skill. Upgrade to unlock it.` };
}

/** Permissive default until HELM-16 supplies a real entitlement: all unlocked. */
export const DEFAULT_AUDIT_ENTITLEMENT: AuditEntitlement = { unlocked: [...ALL_AUDIT_KINDS] };

/**
 * Parse a comma-separated unlocked-audits string (e.g. a RIGEL_UNLOCKED_AUDITS env
 * var). Empty/absent → the permissive default (all unlocked), so the gate is inert
 * until something explicitly supplies a plan. Unknown tokens are ignored.
 */
export function parseUnlockedAudits(raw: string | undefined | null): AuditEntitlement {
  if (!raw || raw.trim() === "") return { unlocked: [...ALL_AUDIT_KINDS] };
  const unlocked = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is AuditKind => (ALL_AUDIT_KINDS as string[]).includes(s));
  return { unlocked };
}
```

Note: `AuditKind` here is the canonical audit-kind type; `packages/audit-cli`
currently defines its own local `AuditKind` union — it will import this one to
avoid two definitions.

## Desktop Audits tab (UI gate)

- **`useAuditEntitlement()`** hook (`apps/web/src/panels/assistant/audits/`) returns
  `DEFAULT_AUDIT_ENTITLEMENT` today. This is the single swap point: when the plan
  exists it reads the real entitlement (from the account/store).
- **`AuditSkillsTab`**: for each audit, `canRunAudit(kind, entitlement)`. Allowed →
  the current live launcher card. Locked → a **locked card**: the Run button is
  disabled, the gate `reason` is shown, and an "Upgrade" affordance replaces Run.
- **`AuditSkillCard`**: gains an optional `locked?: { reason: string }`. When set,
  the card renders the locked treatment (dimmed, lock/upgrade chip, disabled Run
  with the reason) instead of the live Run button. This reuses the earlier
  "coming soon" visual language for the disabled state.

## Agent channel path (enforced at the CLI chokepoint)

The agent's diagnose model runs `rigel-audit <kind>`. Rather than add agent-specific
gating, the **CLI itself** enforces:
- `rigel-audit` reads `RIGEL_UNLOCKED_AUDITS` (via `parseUnlockedAudits`). Before
  running an audit it calls `canRunAudit(kind, entitlement)`; if locked, it writes
  the `reason` to stderr and exits non-zero (code 2). The diagnose model then
  relays "that audit needs an upgrade" instead of findings.
- **Today the env is unset → the CLI defaults to all-unlocked → the check is inert.**
  When HELM-16 lands, the agent (and the desktop server, for its own CLI spawns)
  set `RIGEL_UNLOCKED_AUDITS` from the plan. No agent code change is needed now
  beyond nothing — the CLI reads its own env, which it inherits from the agent
  process; the agent simply doesn't set it yet.

This also incidentally covers the desktop skill's CLI runs, but the desktop tab's
UI gate is the primary product boundary there.

## Data flow (when turned on, illustrative)

Plan → entitlement. Desktop: `useAuditEntitlement()` reads it → `canRunAudit` →
locked cards. Agent: sets `RIGEL_UNLOCKED_AUDITS` from the plan → CLI reads it →
`canRunAudit` → refuses locked audits → model relays the reason.

## Testing

- **`auditEntitlement.test.ts`** (`@rigel/k8s`): `canRunAudit` allowed vs locked
  (+ reason); `parseUnlockedAudits` for absent/empty (→ all), a subset, and
  unknown tokens; `DEFAULT_AUDIT_ENTITLEMENT` unlocks all.
- **CLI** (`packages/audit-cli`): with `RIGEL_UNLOCKED_AUDITS` locking a kind, that
  kind exits non-zero with the reason and does NOT run kubectl; an unlocked kind
  runs; absent env runs everything. (Stub the runner; assert the exit path before
  any kubectl call.)
- **Tab** (`AuditSkillsTab.test.tsx`): with a mocked entitlement locking one audit,
  its card renders the locked treatment and its Run does not call `handoffToChat`;
  unlocked audits still launch.

## Out of scope (until HELM-16)

- The actual plan/account model, billing, and where the real entitlement comes from.
- Wiring `useAuditEntitlement()` to a real plan source, and setting
  `RIGEL_UNLOCKED_AUDITS` from a plan in the agent/desktop. (Both are left at their
  permissive defaults; the swap points are documented in code.)
- Server-side enforcement beyond the CLI chokepoint.

## Files

**New:** `packages/k8s/src/auditEntitlement.ts` (+ test),
`apps/web/src/panels/assistant/audits/useAuditEntitlement.ts`.
**Edit:** `packages/k8s/src/index.ts` (barrel), `packages/audit-cli/src/index.ts`
(env gate + reuse shared `AuditKind`) + its test, `AuditSkillsTab.tsx` (+ test),
`AuditSkillCard.tsx` (locked state).
