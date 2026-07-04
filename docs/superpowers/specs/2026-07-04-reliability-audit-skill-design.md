# Reliability Audit Skill — Design

**Ticket:** HELM-20 (Premium "audit agent" skills)
**Date:** 2026-07-04
**Status:** Approved, ready for implementation plan

## Summary

HELM-20 proposes a family of specialized, sellable "audit skills" for the Rigel
assistant (performance, security, reliability), generalizing the right-sizing
pattern. This spec covers **the first audit — Reliability / SRE — built
end-to-end**, which establishes the reusable framework the other audits slot
into later.

An audit is a **skill the assistant runs**: the user picks it from an "Audits"
list in the Assistant tab, hits Run, and Rigel reports findings **in chat**. The
detection itself is a **deterministic rules engine** (the source of truth); the
assistant's job is to present findings grouped by severity and offer
confirm-gated fixes. This is the "engine + AI presenter" architecture — the LLM
never invents the detection, but can investigate further on request.

## Why this architecture

- **Deterministic detection = a real, sellable product.** A canned prompt is
  something any user could type themselves and it drifts with the model. A
  rigorous, testable, repeatable engine is defensible as a premium skill.
- **Matches the proven template.** Right-sizing (the pattern the ticket cites)
  is algorithmic, not AI-driven; its verdicts are computed client-side from the
  cluster store. We mirror that.
- **Reusable.** One pure engine in `packages/k8s` can be consumed by chat, a
  future web report panel, and the autonomous agent — one detection code path,
  many surfaces.

## Non-goals (v1)

- Security and Performance audits (shown as locked "Coming soon" cards).
- Premium gating / billing / `canRunAudit` (the `entitlements.ts` `canConnect`
  seam stays untouched; HELM-16 will add plan-gating later).
- A persistent audit history or a web-rendered report view (findings live in
  chat).
- Autonomous-agent reuse of the engine.

## Architecture

### 1. The reliability engine — `packages/k8s/src/reliabilityAudit.ts`

A pure, testable module structured like the existing `alerts.ts` /
right-sizing `displayHelper.ts`:

```
analyzeReliability(input: { workloads, pdbs, hpas }) -> ReliabilityFinding[]
```

- **Input** comes from the live cluster store the web app already watches
  (deployments / statefulsets / daemonsets), plus PodDisruptionBudgets. So
  detection runs **client-side** in a `useReliabilityAudit()` hook — no new
  server route — exactly how right-sizing computes verdicts from the store.
- **Output** is a discriminated union of typed findings. Each finding carries:
  - `severity`: `"critical" | "warning" | "info"`
  - target workload (`kind`, `name`, `namespace`, optional `container`)
  - `rationale`: plain-language explanation
  - `fix`: a hint describing the remediation (maps to an action-block kind)
- Severity ordering mirrors right-sizing's `VERDICT_RANK` so findings sort
  urgency-first.

### v1 check set (8 checks, all deterministic)

| Check | Severity | Rule |
|---|---|---|
| Single replica | warning | Deployment/StatefulSet `replicas <= 1` (workloads only, not DaemonSets) |
| No liveness probe | warning | container missing `livenessProbe` |
| No readiness probe | warning | container missing `readinessProbe` |
| No PodDisruptionBudget | warning | multi-replica workload with no PDB selecting it |
| No anti-affinity | info | multi-replica workload without pod anti-affinity across nodes |
| Missing resource requests | warning | container missing cpu/memory `requests` |
| Mutable `:latest` image | warning | container image tag is `:latest` or untagged |
| hostPath volume | warning | pod spec mounts a `hostPath` volume |

Notes:
- Missing-requests overlaps right-sizing's `unset` verdict, but it is also a
  reliability signal (unschedulable / evicted under pressure), so it belongs.
- `hostPath` also appears on the future Security audit; it earns its place here
  too (node pinning, data loss on reschedule).
- Deliberately excluded from v1 (grow the union later): `terminationGracePeriod`,
  privileged/root securityContext (that is the Security audit), CPU-limit
  throttling (Performance audit).

### 2. The chat flow

1. `useReliabilityAudit()` runs the engine over the store → `ReliabilityFinding[]`.
2. The **Run** button calls `handoffToChat(prompt, { newThread: true })` — the
   existing auto-send path (precedent: `AlertsCard.tsx:491`). The prompt
   **embeds the findings** (grouped, compact) and instructs Rigel to:
   - Present them grouped by severity (Critical / Warning / Info) — the system
     prompt already teaches this list format (`systemPrompt.ts:172`).
   - Explain each finding in plain language.
   - Emit an ` ```action ` block per fixable finding so it renders as a
     confirm-gated fix button.
   - Investigate further with read-only kubectl if the user asks "why?".
3. **Fixes** map to the existing action-block contract
   (`packages/k8s/src/actionBlocks.ts`):
   - single replica → `scale`
   - `:latest` image → `setImage` (pin to resolved digest/tag)
   - missing probe / no PDB / no anti-affinity / hostPath / missing requests →
     `applyManifest` (Rigel generates the patched YAML from the live spec)
   - All flow through the existing `ConfirmSheet` showing the exact kubectl
     before running. No new mutation surface.

The engine guarantees *what is wrong* (deterministic, seeded — the AI never
re-derives detection). The assistant handles *explaining it and proposing the
fix* (conversational, may investigate deeper on request).

### 3. The Audits tab (a launcher, not a report view)

A new **"Audits"** tab in the Assistant panel, registered the standard way:
- `TabKey` union in `AssistantContext.tsx`
- entry in `components/TabBar.tsx`
- `case` in `components/TabContent.tsx`
- new `tabs/AuditSkillsTab.tsx`

**Naming:** an `AuditRow.tsx` already exists for the autonomous agent's audit
*log*. Name the new components distinctly (`AuditSkillsTab`, `AuditSkillCard`)
to avoid collision.

The tab lists audit skills as cards:
- **Reliability** — live. One-line description, a live finding count from
  `useReliabilityAudit()` (e.g. "12 issues across 5 workloads"), an optional
  severity-breakdown chip, and a **Run** button → hands off to chat.
- **Security**, **Performance** — disabled "Coming soon" cards. This is
  deliberately where premium/locked state will live once HELM-16 lands.

**Namespace scope:** cluster-wide by default (like right-sizing's `"*"`),
respecting the shared namespace bar if one is set. No new namespace picker.

**Gating (v1): none.** Reliability is free and open; no entitlement check, no
Stripe. When HELM-16 adds real plan-gating, a `canRunAudit(kind)` check is
consulted here and the "Coming soon" cards become "Upgrade to unlock."

## Testing

The engine is the whole point of this architecture, so tests concentrate there.

- **Unit tests** for `reliabilityAudit.ts` — one focused test per check: a
  fixture workload that trips the rule and one that does not; assert the finding,
  its severity, and that clean workloads produce nothing. Plus severity-ranking
  and multiple-findings-per-workload cases.
- **Hook test** for `useReliabilityAudit()` — feed a small store snapshot,
  assert findings aggregate correctly.
- **Prompt-builder test** — the handoff-prompt builder produces stable, grouped
  output from a `Finding[]` fixture (pure function; snapshot-friendly).
- No live-cluster or mutation tests (per project rule: never execute mutation
  endpoints to verify wiring).

## Files touched

**New:**
- `packages/k8s/src/reliabilityAudit.ts` (+ test)
- `apps/web/src/panels/assistant/tabs/AuditSkillsTab.tsx`
- `apps/web/src/panels/assistant/.../AuditSkillCard.tsx`
- `useReliabilityAudit()` hook
- a handoff-prompt builder (co-located with the tab or in `lib/`)

**Edited:**
- `apps/web/src/panels/assistant/AssistantContext.tsx` (`TabKey`)
- `apps/web/src/panels/assistant/components/TabBar.tsx` (tab entry)
- `apps/web/src/panels/assistant/components/TabContent.tsx` (case)
- cluster store — add a `PodDisruptionBudget` watch if not already watched
  (verify during implementation; do not open a second watch on an
  already-watched kind).

**No** server changes, **no** new mutation surface, **no** gating.

## Framework generalization (informational)

This build establishes the shape every future audit reuses:
1. a pure discriminated-union engine in `packages/k8s` (`<domain>Audit.ts`)
2. a `use<Domain>Audit()` hook joining live store state (+ evidence)
3. a handoff-prompt builder that seeds findings into a fresh chat thread
4. an `AuditSkillCard` on the Audits tab (Run → chat)
5. fixes via the existing action-block + ConfirmSheet seam
6. later: a `canRunAudit(kind)` entitlement check for premium gating (HELM-16)

Security (HELM-19) and Performance are the next candidates; Performance depends
on the Prometheus/VM metrics backend being present, so it will not run on every
cluster.
